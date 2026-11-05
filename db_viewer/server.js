'use strict';

/**
 * db_viewer — read-only PostgreSQL table viewer server.
 *
 * The browser cannot talk to PostgreSQL directly, so this small server holds
 * the connection. The user enters host / port / database / user / password in
 * the web UI; the server opens a pool, returns an opaque session token, and
 * every subsequent query runs inside a READ ONLY transaction.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');

// pg returns int8 / numeric as strings by default (to avoid precision loss).
// Keep them as strings; the client formats them without converting to Number.
// Also keep date/time values as the server's text so no timezone shift happens.
for (const oid of [1082, 1083, 1114, 1184, 1266]) types.setTypeParser(oid, (v) => v);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_IDLE_MS = (Number(process.env.SESSION_IDLE_MIN) || 30) * 60 * 1000;
const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS) || 15000;
const MAX_PAGE_SIZE = 1000;
// Optional comma-separated allow list of DB hosts (e.g. "db.internal,10.0.0.5").
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** token -> { pool, info, lastUsed } */
const sessions = new Map();

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function sslOption(mode) {
  switch (mode) {
    case 'require': return { rejectUnauthorized: false };
    case 'verify-full': return { rejectUnauthorized: true };
    default: return false; // 'disable'
  }
}

async function readOnly(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS | 0}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

function getSession(req) {
  const token = req.get('x-session-token');
  const s = token && sessions.get(token);
  if (!s) {
    const err = new Error('세션이 만료되었습니다. 다시 연결해 주세요.');
    err.status = 401;
    throw err;
  }
  s.lastUsed = Date.now();
  return s;
}

// Drop idle sessions.
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.lastUsed > SESSION_IDLE_MS) {
      sessions.delete(token);
      s.pool.end().catch(() => {});
    }
  }
}, 60 * 1000).unref();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/fonts', express.static(path.join(__dirname, 'node_modules/@fontsource/inter/files'), {
  maxAge: '30d',
}));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

app.post('/api/connect', wrap(async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  const database = String(b.database || '').trim();
  const user = String(b.user || '').trim();
  const port = Number(b.port) || 5432;
  if (!host || !database || !user) {
    return res.status(400).json({ error: '호스트, DB 이름, 계정은 필수입니다.' });
  }
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(host.toLowerCase())) {
    return res.status(403).json({ error: '허용되지 않은 호스트입니다.' });
  }

  const pool = new Pool({
    host, port, database, user,
    password: b.password == null ? undefined : String(b.password),
    ssl: sslOption(b.ssl),
    max: 3,
    idleTimeoutMillis: 60 * 1000,
    connectionTimeoutMillis: 10 * 1000,
    application_name: 'db_viewer',
  });
  pool.on('error', () => { /* idle client errors are handled per request */ });

  let version;
  try {
    version = await readOnly(pool, async (c) => (await c.query('SHOW server_version')).rows[0].server_version);
  } catch (err) {
    pool.end().catch(() => {});
    return res.status(400).json({ error: '연결 실패: ' + err.message });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const info = { host, port, database, user, version };
  sessions.set(token, { pool, info, lastUsed: Date.now() });
  res.json({ token, info });
}));

app.post('/api/disconnect', wrap(async (req, res) => {
  const token = req.get('x-session-token');
  const s = token && sessions.get(token);
  if (s) {
    sessions.delete(token);
    s.pool.end().catch(() => {});
  }
  res.json({ ok: true });
}));

app.get('/api/tables', wrap(async (req, res) => {
  const s = getSession(req);
  const rows = await readOnly(s.pool, async (c) => (await c.query(`
    SELECT n.nspname AS schema, c.relname AS name,
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                          WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                          WHEN 'f' THEN 'foreign' END AS kind,
           CASE WHEN c.relkind IN ('r','p','m') THEN GREATEST(c.reltuples, 0)::bigint END AS est_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f')
       AND NOT c.relispartition
       AND n.nspname NOT IN ('pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp%'
       AND has_table_privilege(c.oid, 'SELECT')
     ORDER BY n.nspname, c.relname`)).rows);
  res.json({ tables: rows, info: s.info });
}));

async function loadColumns(c, schema, table) {
  const r = await c.query(`
    SELECT a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           t.typcategory AS category,
           NOT a.attnotnull AS nullable,
           COALESCE(a.attnum = ANY(i.indkey), false) AS pk
      FROM pg_attribute a
      JOIN pg_class cl ON cl.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_index i ON i.indrelid = cl.oid AND i.indisprimary
     WHERE n.nspname = $1 AND cl.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`, [schema, table]);
  return r.rows;
}

app.get('/api/rows', wrap(async (req, res) => {
  const s = getSession(req);
  const schema = String(req.query.schema || '');
  const table = String(req.query.table || '');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_PAGE_SIZE);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const sort = req.query.sort ? String(req.query.sort) : '';
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const q = String(req.query.q || '').trim();
  const filterCol = req.query.fcol ? String(req.query.fcol) : '';

  const result = await readOnly(s.pool, async (c) => {
    const columns = await loadColumns(c, schema, table);
    if (!columns.length) {
      const err = new Error('테이블을 찾을 수 없거나 권한이 없습니다.');
      err.status = 404;
      throw err;
    }
    const names = new Set(columns.map((col) => col.name));
    const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;

    const params = [];
    let where = '';
    if (q) {
      params.push('%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
      const targets = filterCol && names.has(filterCol) ? [filterCol] : [...names];
      where = 'WHERE ' + targets.map((n) => `${quoteIdent(n)}::text ILIKE $1`).join(' OR ');
    }

    let order = '';
    if (sort && names.has(sort)) {
      order = `ORDER BY ${quoteIdent(sort)} ${dir} NULLS LAST`;
    } else {
      const pks = columns.filter((col) => col.pk).map((col) => quoteIdent(col.name));
      if (pks.length) order = `ORDER BY ${pks.join(', ')}`;
    }

    const rows = await c.query({
      text: `SELECT * FROM ${from} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`,
      values: params,
      rowMode: 'array',
    });
    let total = null;
    try {
      await c.query('SAVEPOINT cnt');
      await c.query('SET LOCAL statement_timeout = 5000');
      total = Number((await c.query(`SELECT count(*) AS n FROM ${from} ${where}`, params)).rows[0].n);
      await c.query('RELEASE SAVEPOINT cnt');
    } catch (_) {
      await c.query('ROLLBACK TO SAVEPOINT cnt'); // count too slow — leave total unknown
    }
    return { columns, rows: rows.rows.map(serializeRow), total, limit, offset };
  });
  res.json(result);
}));

function serializeRow(row) {
  return row.map((v) => {
    if (v === null || v === undefined) return null;
    if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex', 0, Math.min(v.length, 64)) + (v.length > 64 ? '…' : '');
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
}

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 400;
  res.status(status).json({ error: err.message || String(err) });
});

app.listen(PORT, HOST, () => {
  console.log(`db_viewer listening on http://${HOST}:${PORT}`);
});
