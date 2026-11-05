'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };
  const sess = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (_) { /* ignore */ } },
  };

  const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const decFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const S = {
    token: sess.get('dbv.token'),
    info: null,
    tables: [],
    cur: null,            // { schema, name, kind }
    columns: [],
    meta: [],             // per column: { align, kind: 'int'|'dec'|'' }
    rows: [],
    total: null,
    offset: 0,
    limit: 100,
    sort: '',
    dir: 'asc',
    q: '',
    fcol: '',
    frozenIndex: 0,       // identifying column (PK or first) frozen next to the row numbers
    sel: null,            // { r0, c0, r1, c1 } anchor (r0,c0) → focus (r1,c1); c = -1 means row header
    selectMode: false,
    reqId: 0,
  };

  // ───────────────────────── API ─────────────────────────
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { 'X-Session-Token': S.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (res.status === 401) { showConnect('세션이 만료되었습니다. 다시 연결해 주세요.'); throw new Error(data.error || 'unauthorized'); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ───────────────────────── Connect screen ─────────────────────────
  const PROFILE_KEY = 'dbv.profiles';
  function profiles() { return store.get(PROFILE_KEY, []); }

  function renderProfiles(selectKey) {
    const list = profiles();
    $('profileBar').hidden = !list.length;
    $('profileSelect').innerHTML = '<option value="">— 새 연결 —</option>' +
      list.map((p, i) => `<option value="${i}">${esc(p.name || `${p.user}@${p.host}/${p.database}`)}</option>`).join('');
    if (selectKey != null) $('profileSelect').value = String(selectKey);
  }

  function fillForm(p) {
    const f = $('connectForm');
    f.host.value = p.host || '';
    f.port.value = p.port || 5432;
    f.database.value = p.database || '';
    f.user.value = p.user || '';
    f.password.value = p.password || '';
    f.ssl.value = p.ssl || 'disable';
    f.name.value = p.name || '';
    $('f_savepw').checked = !!p.password;
  }

  $('profileSelect').addEventListener('change', (e) => {
    const p = profiles()[e.target.value];
    fillForm(p || {});
  });
  $('profileDelete').addEventListener('click', () => {
    const i = $('profileSelect').value;
    if (i === '') return;
    const list = profiles();
    list.splice(Number(i), 1);
    store.set(PROFILE_KEY, list);
    renderProfiles();
    fillForm({});
  });

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  $('connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const p = {
      name: f.name.value.trim(),
      host: f.host.value.trim(),
      port: Number(f.port.value) || 5432,
      database: f.database.value.trim(),
      user: f.user.value.trim(),
      ssl: f.ssl.value,
    };
    const password = f.password.value;
    $('connectBtn').disabled = true;
    setMsg($('connectMsg'), '연결 중…', 'busy');
    try {
      const r = await api('POST', '/api/connect', { ...p, password });
      S.token = r.token; sess.set('dbv.token', r.token);
      setMsg($('connectMsg'), '연결됨', 'ok');
      if ($('f_save').checked) {
        const list = profiles();
        const saved = { ...p, ...($('f_savepw').checked ? { password } : {}) };
        const idx = list.findIndex((x) => x.host === p.host && x.port === p.port && x.database === p.database && x.user === p.user);
        if (idx >= 0) list[idx] = saved; else list.unshift(saved);
        store.set(PROFILE_KEY, list.slice(0, 20));
      }
      f.password.value = '';
      await enterApp();
    } catch (err) {
      setMsg($('connectMsg'), err.message, 'err');
    } finally {
      $('connectBtn').disabled = false;
    }
  });

  function showConnect(message) {
    S.token = null; sess.set('dbv.token', null);
    $('appView').hidden = true;
    $('connectView').hidden = false;
    renderProfiles();
    const list = profiles();
    if (list.length && !$('connectForm').host.value) { fillForm(list[0]); $('profileSelect').value = '0'; }
    setMsg($('connectMsg'), message || '', message ? 'err' : '');
  }

  // ───────────────────────── App shell ─────────────────────────
  async function enterApp() {
    const r = await api('GET', '/api/tables');
    S.info = r.info;
    S.tables = r.tables;
    $('connectView').hidden = true;
    $('appView').hidden = false;
    $('connInfo').innerHTML = `<b>${esc(r.info.database)}</b> · ${esc(r.info.user)}@${esc(r.info.host)}:${esc(r.info.port)} · PG ${esc(String(r.info.version).split(' ')[0])}`;
    renderTableList();
    const last = sess.get('dbv.current');
    const t = last && S.tables.find((x) => `${x.schema}.${x.name}` === last);
    if (t) openTable(t);
    else if (isMobile()) toggleDrawer(true);
  }

  $('disconnectBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/disconnect'); } catch (_) { /* ignore */ }
    sess.set('dbv.current', null);
    resetTable();
    showConnect();
  });

  const isMobile = () => window.matchMedia('(max-width: 720px)').matches;
  function toggleDrawer(open) {
    $('sidebar').classList.toggle('open', open);
    $('backdrop').hidden = !open;
  }
  $('drawerBtn').addEventListener('click', () => toggleDrawer(!$('sidebar').classList.contains('open')));
  $('backdrop').addEventListener('click', () => toggleDrawer(false));

  // ───────────────────────── Table list ─────────────────────────
  const KIND = { view: 'V', matview: 'MV', foreign: 'F' };
  function renderTableList() {
    const f = $('tableFilter').value.trim().toLowerCase();
    const list = S.tables.filter((t) => !f || `${t.schema}.${t.name}`.toLowerCase().includes(f));
    let html = '';
    let schema = null;
    for (const t of list) {
      if (t.schema !== schema) { schema = t.schema; html += `<li class="schema">${esc(schema)}</li>`; }
      const sel = S.cur && S.cur.schema === t.schema && S.cur.name === t.name;
      html += `<li class="item" role="option" tabindex="0" aria-selected="${sel}" data-k="${esc(t.schema + '.' + t.name)}">` +
        `<span class="nm">${esc(t.name)}</span>` +
        (KIND[t.kind] ? `<span class="kind" title="${t.kind}">${KIND[t.kind]}</span>` : '') +
        (t.est_rows != null ? `<span class="cnt" title="추정 행 수">${intFmt.format(t.est_rows)}</span>` : '') +
        '</li>';
    }
    $('tableList').innerHTML = html || '<li class="schema">표시할 테이블이 없습니다</li>';
    $('tableCount').textContent = `${intFmt.format(list.length)} / ${intFmt.format(S.tables.length)}개`;
  }
  $('tableFilter').addEventListener('input', renderTableList);
  function pickFromList(li) {
    const t = S.tables.find((x) => `${x.schema}.${x.name}` === li.dataset.k);
    if (t) { openTable(t); if (isMobile()) toggleDrawer(false); }
  }
  $('tableList').addEventListener('click', (e) => {
    const li = e.target.closest('li.item');
    if (li) pickFromList(li);
  });
  $('tableList').addEventListener('keydown', (e) => {
    const li = e.target.closest('li.item');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFromList(li); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...$('tableList').querySelectorAll('li.item')];
      const n = items[items.indexOf(li) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (n) n.focus();
    }
  });

  // ───────────────────────── Table data ─────────────────────────
  function resetTable() {
    S.cur = null; S.columns = []; S.rows = []; S.sel = null;
    $('grid').hidden = true; $('emptyMsg').hidden = false;
    $('tblTitle').textContent = '테이블을 선택하세요';
  }

  function openTable(t) {
    S.cur = t;
    S.offset = 0; S.sort = ''; S.dir = 'asc'; S.q = ''; S.fcol = '';
    S.sel = null;
    $('searchBox').value = '';
    sess.set('dbv.current', `${t.schema}.${t.name}`);
    $('tblTitle').innerHTML = `<span class="sch">${esc(t.schema)}.</span>${esc(t.name)}`;
    $('tblTitle').title = `${t.schema}.${t.name}`;
    renderTableList();
    load(true);
  }

  async function load(newTable) {
    if (!S.cur) return;
    const id = ++S.reqId;
    status('불러오는 중…');
    const qs = new URLSearchParams({
      schema: S.cur.schema, table: S.cur.name, limit: S.limit, offset: S.offset,
      ...(S.sort ? { sort: S.sort, dir: S.dir } : {}),
      ...(S.q ? { q: S.q } : {}),
      ...(S.fcol ? { fcol: S.fcol } : {}),
    });
    try {
      const r = await api('GET', '/api/rows?' + qs);
      if (id !== S.reqId) return;
      S.columns = r.columns; S.rows = r.rows; S.total = r.total;
      if (newTable) fillSearchCols();
      S.sel = S.rows.length ? { r0: 0, c0: 0, r1: 0, c1: 0 } : null;
      renderGrid();
      if (!newTable) $('gridWrap').scrollTop = 0;
      else { $('gridWrap').scrollTop = 0; $('gridWrap').scrollLeft = 0; }
    } catch (err) {
      if (id !== S.reqId) return;
      status(err.message, true);
    }
  }

  function fillSearchCols() {
    $('searchCol').innerHTML = '<option value="">전체 컬럼</option>' +
      S.columns.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  }

  // Column classification → alignment + number format
  const INT_TYPES = /^(smallint|integer|bigint|oid|xid)\b/;
  const INT_NUMERIC = /^numeric\(\d+,0\)$/;
  const CENTER_CATS = new Set(['B', 'D', 'E', 'I', 'T', 'V']);
  function classify() {
    S.meta = S.columns.map((c, ci) => {
      if (c.category === 'N') {
        const isInt = INT_TYPES.test(c.type) || INT_NUMERIC.test(c.type);
        return { align: 'r', kind: isInt ? 'int' : 'dec' };
      }
      if (CENTER_CATS.has(c.category) || c.type === 'uuid') return { align: 'c', kind: '' };
      // short category-like text (codes, flags) → center; long text → left
      let max = 0;
      for (const row of S.rows) { const v = row[ci]; if (v != null) max = Math.max(max, String(v).length); if (max > 8) break; }
      return { align: S.rows.length && max <= 8 ? 'c' : 'l', kind: '' };
    });
    const pk = S.columns.findIndex((c) => c.pk);
    S.frozenIndex = pk >= 0 ? pk : 0;
  }

  function fmt(v, m) {
    if (v === null || v === undefined) return 'NULL';
    if (m.kind && /^-?\d/.test(String(v))) {
      try { return (m.kind === 'int' ? intFmt : decFmt).format(String(v)); } catch (_) { return String(v); }
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  // Visual column order: identifying column (PK or first) first, then the rest.
  function order() {
    const o = [S.frozenIndex];
    for (let i = 0; i < S.columns.length; i++) if (i !== S.frozenIndex) o.push(i);
    return o;
  }

  function renderGrid() {
    classify();
    const grid = $('grid');
    if (!S.columns.length) { grid.hidden = true; $('emptyMsg').hidden = false; return; }
    const ord = order();
    S.ord = ord;
    let h = '<thead><tr><th class="rn frz" data-c="-1" title="전체 선택">#</th>';
    ord.forEach((ci, vi) => {
      const c = S.columns[ci];
      const sorted = S.sort === c.name;
      const arr = sorted ? (S.dir === 'asc' ? '˄' : '˅') : '';
      h += `<th data-c="${vi}" class="${vi === 0 ? 'frz frz-last ' : ''}${sorted ? 'sorted' : ''}" title="${esc(c.name)} (${esc(c.type)}) — 눌러서 정렬"` +
        ` aria-sort="${sorted ? (S.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">` +
        `<span class="h">${c.pk ? '<span class="pk">PK</span>' : ''}${esc(c.name)}<span class="arr" aria-hidden="true">${arr}</span></span>` +
        `<span class="ty">${esc(c.type)}</span></th>`;
    });
    h += '</tr></thead><tbody>';
    const parts = [];
    S.rows.forEach((row, ri) => {
      let tr = `<tr><td class="rn frz" data-r="${ri}" data-c="-1">${intFmt.format(S.offset + ri + 1)}</td>`;
      ord.forEach((ci, vi) => {
        const v = row[ci];
        const m = S.meta[ci];
        const text = fmt(v, m);
        tr += `<td data-r="${ri}" data-c="${vi}" class="${m.align}${v == null ? ' null' : ''}${vi === 0 ? ' frz frz-last' : ''}"` +
          `${text.length > 30 ? ` title="${esc(text.slice(0, 500))}"` : ''}>${esc(text.length > 300 ? text.slice(0, 300) + '…' : text)}</td>`;
      });
      parts.push(tr + '</tr>');
    });
    grid.innerHTML = h + parts.join('') + '</tbody>';
    grid.hidden = false;
    $('emptyMsg').hidden = S.rows.length > 0;
    $('emptyMsg').textContent = S.rows.length ? '' : '조회된 행이 없습니다.';
    if (!S.rows.length) $('emptyMsg').hidden = false;
    layoutFrozen();
    paintSel();
    updatePager();
  }

  function layoutFrozen() {
    const grid = $('grid');
    const rn = grid.querySelector('thead th.rn');
    if (!rn) return;
    const w = rn.getBoundingClientRect().width;
    grid.querySelectorAll('.rn').forEach((el) => { el.style.left = '0px'; });
    grid.querySelectorAll('[data-c="0"]').forEach((el) => { el.style.left = w + 'px'; });
  }
  window.addEventListener('resize', layoutFrozen);

  function updatePager() {
    const from = S.rows.length ? S.offset + 1 : 0;
    const to = S.offset + S.rows.length;
    $('pagerInfo').textContent = `${intFmt.format(from)}–${intFmt.format(to)}`;
    $('prevBtn').disabled = S.offset === 0;
    $('nextBtn').disabled = S.total != null ? to >= S.total : S.rows.length < S.limit;
    const total = S.total != null ? intFmt.format(S.total) : '?';
    status(`${intFmt.format(from)}–${intFmt.format(to)} / 총 ${total}행 · ${intFmt.format(S.columns.length)}개 컬럼` + (S.q ? ` · 검색: “${S.q}”` : ''));
  }

  function status(text, isErr) {
    const el = $('statusLeft');
    el.textContent = text;
    el.className = isErr ? 'err' : '';
  }

  // ───────────────────────── Toolbar ─────────────────────────
  $('prevBtn').addEventListener('click', () => { S.offset = Math.max(0, S.offset - S.limit); load(); });
  $('nextBtn').addEventListener('click', () => { S.offset += S.limit; load(); });
  $('pageSize').addEventListener('change', (e) => { S.limit = Number(e.target.value); S.offset = 0; load(); });
  $('refreshBtn').addEventListener('click', () => load());
  let searchTimer;
  $('searchBox').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.q = e.target.value.trim(); S.offset = 0; load(); }, 350);
  });
  $('searchCol').addEventListener('change', (e) => { S.fcol = e.target.value; if (S.q) { S.offset = 0; load(); } });
  $('selectModeBtn').addEventListener('click', () => {
    S.selectMode = !S.selectMode;
    $('selectModeBtn').setAttribute('aria-pressed', String(S.selectMode));
    $('gridWrap').classList.toggle('select-mode', S.selectMode);
    toast(S.selectMode ? '범위선택 켜짐: 드래그하여 셀 범위 선택' : '범위선택 꺼짐: 드래그로 스크롤');
  });
  $('copyBtn').addEventListener('click', () => copySelection());
  $('detailBtn').addEventListener('click', () => openDetail());

  // ───────────────────────── Selection ─────────────────────────
  const rect = () => {
    const s = S.sel;
    if (!s) return null;
    return { top: Math.min(s.r0, s.r1), bot: Math.max(s.r0, s.r1), left: Math.min(s.c0, s.c1), right: Math.max(s.c0, s.c1) };
  };
  let painted = [];
  function paintSel() {
    painted.forEach((el) => el.classList.remove('sel', 'act', 'colsel', 'rowsel'));
    painted = [];
    const g = rect();
    const tbody = $('grid').tBodies[0];
    const thead = $('grid').tHead;
    if (!g || !tbody) { $('statusRight').textContent = ''; return; }
    const multi = g.top !== g.bot || g.left !== g.right;
    let sum = 0; let nums = 0;
    for (let r = g.top; r <= g.bot; r++) {
      const tr = tbody.rows[r];
      if (!tr) continue;
      tr.cells[0].classList.add('rowsel'); painted.push(tr.cells[0]);
      for (let c = g.left; c <= g.right; c++) {
        const td = tr.cells[c + 1];
        if (!td) continue;
        if (multi) { td.classList.add('sel'); painted.push(td); }
        const ci = S.ord[c];
        const v = S.rows[r][ci];
        if (S.meta[ci].kind && v != null && v !== '' && isFinite(v)) { sum += Number(v); nums++; }
      }
    }
    for (let c = g.left; c <= g.right; c++) { const th = thead.rows[0].cells[c + 1]; if (th) { th.classList.add('colsel'); painted.push(th); } }
    const act = tbody.rows[S.sel.r1] && tbody.rows[S.sel.r1].cells[S.sel.c1 + 1];
    if (act) { act.classList.add('act'); painted.push(act); }
    const cnt = (g.bot - g.top + 1) * (g.right - g.left + 1);
    let txt = multi ? `선택 ${intFmt.format(g.bot - g.top + 1)}×${intFmt.format(g.right - g.left + 1)} (${intFmt.format(cnt)}셀)` : `${S.columns[S.ord[S.sel.c1]].name} · ${intFmt.format(S.offset + S.sel.r1 + 1)}행`;
    if (multi && nums) txt += ` · 합계 ${Number.isInteger(sum) ? intFmt.format(sum) : decFmt.format(sum)}`;
    $('statusRight').textContent = txt;
  }

  function cellFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const td = el && el.closest && el.closest('#grid td');
    return td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null;
  }

  function setSel(r0, c0, r1, c1) {
    const maxR = S.rows.length - 1; const maxC = S.ord.length - 1;
    const cl = (v, m) => Math.max(0, Math.min(m, v));
    S.sel = { r0: cl(r0, maxR), c0: cl(c0, maxC), r1: cl(r1, maxR), c1: cl(c1, maxC) };
    paintSel();
  }

  let drag = null;
  const wrap = $('gridWrap');
  wrap.addEventListener('pointerdown', (e) => {
    const th = e.target.closest('#grid thead th');
    if (th) return; // header handled by click
    const td = e.target.closest('#grid td');
    if (!td) return;
    const r = Number(td.dataset.r); const c = Number(td.dataset.c);
    const allowDrag = e.pointerType === 'mouse' || S.selectMode;
    if (c === -1) { // row header → whole row
      const last = S.ord.length - 1;
      if (e.shiftKey && S.sel) setSel(S.sel.r0, 0, r, last); else setSel(r, 0, r, last);
      if (allowDrag) drag = { rowMode: true };
    } else if (e.shiftKey && S.sel) {
      setSel(S.sel.r0, S.sel.c0, r, c);
      if (allowDrag) drag = {};
    } else if (allowDrag) {
      setSel(r, c, r, c);
      drag = {};
    } else {
      drag = { tap: { r, c, x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.pointerType !== 'mouse') e.preventDefault();
    wrap.focus({ preventScroll: true });
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag || drag.tap) return;
    const p = cellFromPoint(e.clientX, e.clientY);
    if (!p) { autoScroll(e); return; }
    if (drag.rowMode) setSel(S.sel.r0, 0, p.r, S.ord.length - 1);
    else if (p.c >= 0 && (p.r !== S.sel.r1 || p.c !== S.sel.c1)) setSel(S.sel.r0, S.sel.c0, p.r, p.c);
    autoScroll(e);
  });
  const endDrag = (e) => {
    if (drag && drag.tap && e.type === 'pointerup') {
      const t = drag.tap;
      if (Math.abs(e.clientX - t.x) < 8 && Math.abs(e.clientY - t.y) < 8) setSel(t.r, t.c, t.r, t.c);
    }
    drag = null;
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  function autoScroll(e) {
    const b = wrap.getBoundingClientRect(); const m = 24;
    if (e.clientY > b.bottom - m) wrap.scrollTop += 12; else if (e.clientY < b.top + m + 26) wrap.scrollTop -= 12;
    if (e.clientX > b.right - m) wrap.scrollLeft += 12; else if (e.clientX < b.left + m) wrap.scrollLeft -= 12;
  }

  // header: sort / select all
  $('grid').addEventListener('click', (e) => {
    const th = e.target.closest('thead th');
    if (!th) return;
    const vc = Number(th.dataset.c);
    if (vc === -1) { if (S.rows.length) setSel(0, 0, S.rows.length - 1, S.ord.length - 1); return; }
    const name = S.columns[S.ord[vc]].name;
    if (S.sort === name) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
    else { S.sort = name; S.dir = 'asc'; }
    S.offset = 0;
    load();
  });
  $('grid').addEventListener('dblclick', (e) => { if (e.target.closest('tbody td')) openDetail(); });

  // keyboard
  wrap.addEventListener('keydown', (e) => {
    if (!S.sel || !S.rows.length) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); setSel(0, 0, S.rows.length - 1, S.ord.length - 1); return; }
    if (k === 'Enter') { e.preventDefault(); openDetail(); return; }
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] }[k];
    if (!d) return;
    e.preventDefault();
    const r = S.sel.r1 + d[0]; const c = S.sel.c1 + d[1];
    if (e.shiftKey) setSel(S.sel.r0, S.sel.c0, r, c); else setSel(r, c, r, c);
    const td = $('grid').tBodies[0].rows[S.sel.r1].cells[S.sel.c1 + 1];
    scrollIntoViewIfNeeded(td);
  });
  function scrollIntoViewIfNeeded(td) {
    const b = wrap.getBoundingClientRect(); const t = td.getBoundingClientRect();
    const head = $('grid').tHead.getBoundingClientRect().height;
    const frz = S.sel.c1 === 0 ? 0 : $('grid').tHead.rows[0].cells[1].getBoundingClientRect().right - b.left;
    if (t.top < b.top + head) wrap.scrollTop -= b.top + head - t.top;
    else if (t.bottom > b.bottom) wrap.scrollTop += t.bottom - b.bottom;
    if (t.left < b.left + frz) wrap.scrollLeft -= b.left + frz - t.left;
    else if (t.right > b.right) wrap.scrollLeft += t.right - b.right;
  }

  // ───────────────────────── Copy ─────────────────────────
  function selectionTSV() {
    const g = rect();
    if (!g) return '';
    const lines = [];
    for (let r = g.top; r <= g.bot; r++) {
      const cells = [];
      for (let c = g.left; c <= g.right; c++) {
        const v = S.rows[r][S.ord[c]];
        let s = v == null ? '' : String(v);
        if (/[\t\n\r"]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        cells.push(s);
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }
  // Native copy (Ctrl+C / ⌘C) works over plain http too.
  document.addEventListener('copy', (e) => {
    const a = document.activeElement;
    if ($('appView').hidden || !$('sheet').hidden || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))) return;
    if (!S.sel) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionTSV());
    toast(copiedMsg());
  });
  function copiedMsg() { const g = rect(); return `✓ ${intFmt.format((g.bot - g.top + 1) * (g.right - g.left + 1))}셀 복사됨`; }
  async function copySelection() {
    if (!S.sel) return;
    const text = selectionTSV();
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand && (() => { try { return document.execCommand('copy'); } catch (__) { return false; } })();
      ta.remove();
      wrap.focus({ preventScroll: true });
      if (!ok) { toast('✕ 복사 실패: 브라우저가 클립보드 접근을 막았습니다'); return; }
    }
    toast(copiedMsg());
  }

  // ───────────────────────── Row detail ─────────────────────────
  function openDetail() {
    if (!S.sel || !S.rows.length) return;
    renderDetail(S.sel.r1);
    $('sheet').hidden = false;
    $('sheetClose').focus();
  }
  function renderDetail(r) {
    const row = S.rows[r];
    $('sheetTitle').textContent = `${intFmt.format(S.offset + r + 1)}행 상세`;
    $('sheetTable').innerHTML = S.columns.map((c, ci) => {
      const v = row[ci]; const m = S.meta[ci];
      const text = v == null ? 'NULL' : (m.kind ? fmt(v, m) : String(v));
      return `<tr><th>${c.pk ? '<span class="pk">PK</span> ' : ''}${esc(c.name)}<span class="ty">${esc(c.type)}</span></th>` +
        `<td class="${m.align === 'r' ? 'r' : ''}${v == null ? ' null' : ''}">${esc(text)}</td></tr>`;
    }).join('');
    $('sheetPrev').disabled = r <= 0;
    $('sheetNext').disabled = r >= S.rows.length - 1;
  }
  const closeSheet = () => { $('sheet').hidden = true; wrap.focus({ preventScroll: true }); };
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  const moveDetail = (d) => {
    const r = Math.max(0, Math.min(S.rows.length - 1, S.sel.r1 + d));
    setSel(r, S.sel.c1, r, S.sel.c1);
    renderDetail(r);
  };
  $('sheetPrev').addEventListener('click', () => moveDetail(-1));
  $('sheetNext').addEventListener('click', () => moveDetail(1));
  document.addEventListener('keydown', (e) => {
    if ($('sheet').hidden) return;
    if (e.key === 'Escape') closeSheet();
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveDetail(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveDetail(1); }
  });

  // ───────────────────────── Toast ─────────────────────────
  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1600);
  }

  // ───────────────────────── Boot ─────────────────────────
  if (S.token) enterApp().catch(() => showConnect());
  else showConnect();
})();
