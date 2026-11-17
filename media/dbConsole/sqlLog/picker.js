// SQL 로그 고르기 창. 창을 연 순간의 목록(init)만 보여 주고, 그 뒤 들어오는 쿼리는 반영하지 않는다
// 보기: 요청별(왼쪽 요청 · 오른쪽 그 요청의 쿼리와 SQL) / 쿼리별(왼쪽 쿼리 · 오른쪽 SQL)
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const $list = $('list');
  const $filter = $('filter');
  const $sql = $('sql');
  const $head = $('head');

  /** @type {{id:number,title:string,mapper:string,verb:string,tables:string,cond:string,info:string,time:string,warn:string,sql:string,search:string}[]} */
  let all = [];
  let shown = []; // 쿼리별: 보이는 쿼리, 요청별: 보이는 요청
  let groups = [];
  let byId = new Map();
  let view = 'request';
  let curGroup = ''; // 요청별에서 고른 요청
  let open = new Set(); // 펼친 반복 쿼리 (요청 열쇠 + 반복 열쇠)
  let cur = -1; // 고른 쿼리의 id
  let rules = { include: [], exclude: [], latestOnly: false };
  let diagnosis = [];
  let debugConsole = true; // Java 실행이 이미 디버그 콘솔인지 (아니면 전환 단추를 보인다)

  /** 필터를 바꿔 달라고 보낸다 (확장이 저장하고 목록을 다시 보낸다) */
  function sendRules(next, note) {
    vscode.postMessage({ type: 'setFilter', filter: next, note });
  }
  const has = (list, w) => list.some((x) => x.toLowerCase() === w.toLowerCase());
  function addRule(kind, word) {
    word = word.trim();
    if (!word || has(rules[kind], word)) return;
    sendRules({ ...rules, [kind]: [...rules[kind], word] }, `"${word}" ${kind === 'exclude' ? '수집 제외' : '포함'}에 더함`);
  }
  function removeRule(kind, word) {
    sendRules({ ...rules, [kind]: rules[kind].filter((x) => x !== word) }, `"${word}" ${kind === 'exclude' ? '수집 제외' : '포함'}에서 뺌`);
  }
  /** 수집 필터 칸: 걸린 낱말(칩, ✕ 로 빼기) · 고른 쿼리의 id · 테이블 제안(⊕ 로 더하기) */
  function renderRules() {
    const q = selected();
    for (const [kind, chipsId, suggId] of [['exclude', 'exChips', 'exSugg'], ['include', 'inChips', 'inSugg']]) {
      const box = $(chipsId);
      box.textContent = '';
      for (const w of rules[kind]) {
        const chip = document.createElement('span');
        chip.className = 'chip ' + kind;
        chip.textContent = w;
        const x = document.createElement('button');
        x.className = 'x';
        x.textContent = '✕';
        x.title = '빼기 — 이 낱말로 빠져 있던 최근 쿼리는 목록으로 돌아옵니다';
        x.addEventListener('click', () => removeRule(kind, w));
        chip.appendChild(x);
        box.appendChild(chip);
      }
      const sugg = $(suggId);
      sugg.textContent = '';
      for (const x of q ? q.excludes : []) {
        if (has(rules[kind], x.word)) continue;
        const b = document.createElement('button');
        b.className = 'small ' + x.kind;
        b.textContent = '⊕ ' + (x.kind === 'query' ? 'id ' : '') + x.word;
        b.title = kind === 'exclude' ? `${x.kind === 'query' ? '이 쿼리' : '이 테이블'}가 든 쿼리는 모으지 않음` : `${x.kind === 'query' ? '이 쿼리' : '이 테이블'}가 든 쿼리만 모음`;
        b.addEventListener('click', () => addRule(kind, x.word));
        sugg.appendChild(b);
      }
      if (!rules[kind].length && !sugg.childElementCount) box.appendChild(div('none', kind === 'exclude' ? '없음' : '없음 (모두 모음)'));
    }
    $('latestOnly').checked = !!rules.latestOnly;
  }

  const KEYWORDS = new Set(
    ('SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS JOIN LEFT RIGHT FULL INNER OUTER CROSS ON GROUP BY ORDER HAVING UNION ALL ' +
      'INSERT INTO VALUES UPDATE SET DELETE MERGE USING WHEN MATCHED THEN CASE ELSE END AS DISTINCT WITH ASC DESC LIMIT OFFSET FETCH FIRST ROWS ONLY ' +
      'START CONNECT PRIOR SIBLINGS OVER PARTITION ROWNUM').split(' ')
  );

  /** SQL 을 색칠해 넣는다 (주석·따옴표 글·숫자·예약어). textContent 만 쓰므로 로그 내용이 HTML 로 해석되지 않는다 */
  function paint(el, sql) {
    el.textContent = '';
    const re = /(\/\*[\s\S]*?\*\/|--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$#]*)|([\s\S])/g;
    let m;
    let plain = '';
    const flush = () => {
      if (plain) el.appendChild(document.createTextNode(plain));
      plain = '';
    };
    const span = (cls, text) => {
      flush();
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      el.appendChild(s);
    };
    while ((m = re.exec(sql))) {
      if (m[1]) span('c', m[1]);
      else if (m[2]) span('s', m[2]);
      else if (m[3]) span('n', m[3]);
      else if (m[4] && KEYWORDS.has(m[4].toUpperCase())) span('k', m[4]);
      else plain += m[0];
    }
    flush();
  }

  function div(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  /** 지금 고른 쿼리 (보이는 것 가운데) */
  function selected() {
    if (view === 'query') return all.find((x) => x.id === cur && shown.includes(x));
    const g = groups.find((x) => x.key === curGroup && shown.includes(x));
    return g && g.ids.includes(cur) ? byId.get(cur) : undefined;
  }

  /** 요청 안 쿼리를 보일 줄: 반복(N+1)은 처음 것 한 줄로 접고 ×n (펼치면 모두) */
  function innerRows(g) {
    const n1 = new Map(g.nplus.map((r) => [r.key, r.count]));
    const seen = new Set();
    const rows = [];
    for (const id of g.ids) {
      const q = byId.get(id);
      if (!q) continue;
      const count = n1.get(q.rk);
      if (count && !open.has(g.key + '\n' + q.rk)) {
        if (seen.has(q.rk)) continue;
        seen.add(q.rk);
        rows.push({ q, count });
      } else rows.push({ q, count: 0, repeat: !!count });
    }
    return rows;
  }

  function verbSpan(verb) {
    const v = document.createElement('span');
    v.className = 'verb ' + verb;
    v.textContent = verb;
    return v;
  }

  function badge(text, cls) {
    const b = document.createElement('span');
    b.className = 'badge ' + (cls || '');
    b.textContent = text;
    return b;
  }

  function renderEmpty() {
    if (all.length) {
      $list.appendChild(div('empty', view === 'query' ? '맞는 쿼리가 없습니다.' : '맞는 요청이 없습니다.'));
      return;
    }
    const box = div('empty');
    box.appendChild(div('', '모은 쿼리가 없습니다.'));
    for (const line of diagnosis) box.appendChild(div('why', line));
    if (!debugConsole) {
      const d = document.createElement('button');
      d.className = 'primary';
      d.textContent = '디버그 콘솔로 전환';
      d.title = 'F5 · Run · Debug 로 띄우는 Java 서버의 로그를 디버그 콘솔로 보내 SQL 을 모읍니다 (사용자 설정 java.debug.settings.console). 바꾼 뒤 서버를 다시 실행하세요';
      d.addEventListener('click', () => vscode.postMessage({ type: 'useDebugConsole' }));
      box.appendChild(d);
    }
    const b = document.createElement('button');
    b.textContent = '고른 로그에서 읽기';
    b.title = '터미널에서 SQL 로그를 드래그해 고른 뒤 누르세요 (편집기에서 고른 글 · 클립보드도 됨)';
    b.addEventListener('click', () => vscode.postMessage({ type: 'readSelection' }));
    box.appendChild(b);
    $list.appendChild(box);
  }

  function render() {
    $list.textContent = '';
    $('vReq').classList.toggle('on', view === 'request');
    $('vQuery').classList.toggle('on', view === 'query');
    $('vReq').setAttribute('aria-selected', String(view === 'request'));
    $('vQuery').setAttribute('aria-selected', String(view === 'query'));
    $('sendGroup').style.display = view === 'request' ? '' : 'none';
    $('send').className = view === 'request' ? '' : 'primary';
    $('keys1').innerHTML = view === 'request' ? '<kbd>↑</kbd> <kbd>↓</kbd> 요청 · <kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> 안의 쿼리' : '<kbd>↑</kbd> <kbd>↓</kbd> 이동';
    $('keys2').innerHTML = view === 'request' ? '<kbd>Enter</kbd> 묶음째 새 콘솔로 · <kbd>Alt</kbd>+<kbd>Enter</kbd> 고른 쿼리만 (실행은 직접)' : '<kbd>Enter</kbd> 새 콘솔로 (실행은 직접)';
    const total = view === 'query' ? all.length : groups.length;
    const unit = view === 'query' ? '쿼리' : '요청';
    $('count').textContent = shown.length === total ? `최근 ${unit} ${total}` : `${shown.length} / ${total}`;
    if (!shown.length) renderEmpty();
    if (view === 'query') {
      for (const q of shown) {
        const row = div('row' + (q.id === cur ? ' on' : ''));
        row.dataset.id = String(q.id);
        const t = div('t');
        t.appendChild(verbSpan(q.verb));
        t.appendChild(document.createTextNode(q.title));
        t.title = q.title;
        row.appendChild(t);
        row.appendChild(div('m', [q.mapper, q.tables, q.time, q.info].filter(Boolean).join(' · ')));
        if (q.cond) row.appendChild(div('w', q.cond));
        $list.appendChild(row);
      }
    } else {
      for (const g of shown) {
        const row = div('row' + (g.key === curGroup ? ' on' : ''));
        row.dataset.key = g.key;
        const t = div('t');
        if (g.method) t.appendChild(verbSpan(g.method));
        t.appendChild(document.createTextNode(g.method ? g.title.slice(g.method.length + 1) : g.title));
        t.title = g.title;
        row.appendChild(t);
        const m = div('m');
        if (g.status) m.appendChild(badge(String(g.status), g.status >= 400 ? 'bad' : 'ok'));
        m.appendChild(document.createTextNode(' ' + [g.info.replace(/^\d{3} · /, ''), g.time].join(' · ')));
        for (const r of g.nplus) m.appendChild(badge(`N+1 ×${r.count}`, 'warn'));
        row.appendChild(m);
        $list.appendChild(row);
      }
    }
    renderRight();
    renderRules();
    const on = $list.querySelector('.row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function renderRight() {
    const $inner = $('inner');
    $inner.textContent = '';
    $head.textContent = '';
    const g = view === 'request' ? groups.find((x) => x.key === curGroup && shown.includes(x)) : undefined;
    $inner.style.display = g ? '' : 'none';
    if (g) {
      const h = div('gh');
      h.appendChild(document.createTextNode(g.title));
      h.title = g.title;
      $head.appendChild(h);
      $head.appendChild(div('gi', g.info + (g.overflow ? ` (뒤의 ${g.overflow}개는 담지 못함)` : '')));
      for (const r of innerRows(g)) {
        const q = r.q;
        const row = div('qr' + (q.id === cur ? ' on' : '') + (r.repeat ? ' rep' : ''));
        row.dataset.id = String(q.id);
        row.appendChild(div('off', g.offsets[q.id] || ''));
        const t = div('qt');
        t.appendChild(verbSpan(q.verb));
        t.appendChild(document.createTextNode(q.title));
        row.appendChild(t);
        if (r.count) {
          const b = badge(`N+1 ×${r.count} ▸`, 'warn');
          b.title = '값만 바꿔 여러 번 돈 쿼리 — 눌러 모두 보기';
          b.dataset.toggle = g.key + '\n' + q.rk;
          row.appendChild(b);
        } else if (r.repeat && g.nplus.some((x) => x.key === q.rk) && g.ids.find((id) => byId.get(id) && byId.get(id).rk === q.rk) === q.id) {
          const b = badge('접기 ▾', 'warn');
          b.dataset.toggle = g.key + '\n' + q.rk;
          row.appendChild(b);
        }
        row.appendChild(div('qi', q.info || ''));
        $inner.appendChild(row);
      }
    }
    const q = selected();
    if (q) {
      if (!g) $head.appendChild(document.createTextNode([q.title, q.mapper, q.time, q.info].filter(Boolean).join(' · ')));
      if (q.warn) {
        const w = document.createElement('div');
        w.className = 'warn';
        w.textContent = q.warn;
        $head.appendChild(w);
      }
      paint($sql, q.sql);
    } else {
      $sql.textContent = '';
    }
    const on = $inner.querySelector('.qr.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function applyFilter() {
    const words = $filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (text) => words.every((w) => text.includes(w));
    if (view === 'query') {
      shown = all.filter((q) => hit(q.search));
      if (!shown.some((q) => q.id === cur)) cur = shown.length ? shown[0].id : -1;
    } else {
      shown = groups.filter((g) => hit(g.search));
      if (!shown.some((g) => g.key === curGroup)) curGroup = shown.length ? shown[0].key : '';
      pickFirstInner();
    }
    render();
  }

  /** 고른 요청 안에서 고른 쿼리가 없으면 첫 쿼리 */
  function pickFirstInner() {
    const g = groups.find((x) => x.key === curGroup);
    if (!g) return;
    const rows = innerRows(g);
    if (!rows.some((r) => r.q.id === cur)) cur = rows.length ? rows[0].q.id : -1;
  }

  function move(delta) {
    if (!shown.length) return;
    if (view === 'query') {
      const i = shown.findIndex((q) => q.id === cur);
      cur = shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? 0 : i) + delta))].id;
    } else {
      const i = shown.findIndex((g) => g.key === curGroup);
      curGroup = shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? 0 : i) + delta))].key;
      cur = -1;
      pickFirstInner();
    }
    render();
  }

  function moveInner(delta) {
    const g = groups.find((x) => x.key === curGroup);
    if (!g) return;
    const rows = innerRows(g);
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.q.id === cur);
    cur = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta))].q.id;
    renderRight();
    renderRules();
  }

  function setView(v) {
    if (v === view) return;
    const q = selected();
    view = v;
    vscode.postMessage({ type: 'view', view });
    if (view === 'request' && q) curGroup = q.group;
    applyFilter();
  }

  const act = (type) => {
    if (type === 'sendGroup') {
      if (view === 'request' && curGroup && shown.some((g) => g.key === curGroup)) vscode.postMessage({ type, key: curGroup });
      return;
    }
    if (selected()) vscode.postMessage({ type, id: cur });
  };

  $filter.addEventListener('input', applyFilter);
  $list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (view === 'query') cur = Number(row.dataset.id);
    else {
      curGroup = row.dataset.key;
      cur = -1;
      pickFirstInner();
    }
    render();
    $filter.focus();
  });
  $list.addEventListener('dblclick', (e) => {
    if (e.target.closest('.row')) act(view === 'request' ? 'sendGroup' : 'send');
  });
  $('inner').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const k = t.dataset.toggle;
      if (open.has(k)) open.delete(k);
      else open.add(k);
    }
    const row = e.target.closest('.qr');
    if (row) cur = Number(row.dataset.id);
    renderRight();
    renderRules();
    $filter.focus();
  });
  $('inner').addEventListener('dblclick', (e) => {
    if (e.target.closest('.qr') && !e.target.closest('[data-toggle]')) act('send');
  });
  $('vReq').addEventListener('click', () => setView('request'));
  $('vQuery').addEventListener('click', () => setView('query'));
  $('sendGroup').addEventListener('click', () => act('sendGroup'));
  $('send').addEventListener('click', () => act('send'));
  $('copy').addEventListener('click', () => act('copy'));
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.target && (e.target.id === 'exAdd' || e.target.id === 'inAdd') && e.key !== 'Escape') return;
    if (view === 'request' && e.altKey && e.key === 'ArrowDown') moveInner(1);
    else if (view === 'request' && e.altKey && e.key === 'ArrowUp') moveInner(-1);
    else if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'PageDown') move(5);
    else if (e.key === 'PageUp') move(-5);
    else if (e.key === 'Enter') act(view === 'request' && !e.altKey ? 'sendGroup' : 'send');
    else if (e.key === 'Escape') vscode.postMessage({ type: 'close' });
    else if ((e.ctrlKey || e.metaKey) && e.key === '1') setView('request');
    else if ((e.ctrlKey || e.metaKey) && e.key === '2') setView('query');
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !String(window.getSelection())) act('copy');
    else return;
    e.preventDefault();
  });
  function filtered(n) {
    $('filtered').textContent = n ? `필터로 빠져 있는 쿼리 ${n}` : '';
  }
  for (const [kind, id] of [['exclude', 'exAdd'], ['include', 'inAdd']]) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      addRule(kind, e.target.value);
      e.target.value = '';
    });
  }
  $('latestOnly').addEventListener('change', (e) => sendRules({ ...rules, latestOnly: e.target.checked }, e.target.checked ? '같은 쿼리는 최근 하나만' : '같은 쿼리도 모두'));

  /** 받은 목록을 넣는다 (찾기 글 · 고른 것은 keep 이면 그대로) */
  function load(m, keep) {
    all = m.items.map((q) => Object.assign(q, { search: [q.title, q.mapper, q.verb, q.tables, q.sql].join('\n').toLowerCase() }));
    byId = new Map(all.map((q) => [q.id, q]));
    groups = m.groups.map((g) =>
      Object.assign(g, { search: [g.title, g.info, ...g.ids.map((id) => (byId.get(id) || { search: '' }).search)].join('\n').toLowerCase() })
    );
    if (!keep) {
      view = m.view === 'query' ? 'query' : 'request';
      curGroup = m.focus && groups.some((g) => g.key === m.focus) ? m.focus : groups.length ? groups[0].key : '';
      cur = view === 'query' ? (all.length ? all[0].id : -1) : -1;
      if (view === 'request') pickFirstInner();
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      const keep = !!m.note; // 필터를 바꿔 다시 받은 목록이면 고른 것 · 찾기 글을 그대로
      rules = m.filter;
      diagnosis = m.diagnose || [];
      debugConsole = m.debugConsole !== false;
      const $note = $('note');
      $note.textContent = m.note || '';
      $note.className = /못했/.test(m.note || '') ? 'err' : 'ok';
      filtered(m.excluded);
      load(m, keep);
      if (!keep) {
        $('opened').textContent = m.openedAt + ' 에 연 목록';
        $filter.value = '';
        $filter.focus();
      }
      applyFilter();
    } else if (m.type === 'copied') {
      $('copy').textContent = '복사됨';
      setTimeout(() => ($('copy').textContent = '복사'), 1200);
    }
  });
  window.addEventListener('focus', () => $filter.focus());
  vscode.postMessage({ type: 'ready' });
})();
