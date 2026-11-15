// SQL 로그 고르기 창. 창을 연 순간의 목록(init)만 보여 주고, 그 뒤 들어오는 쿼리는 반영하지 않는다
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const $list = $('list');
  const $filter = $('filter');
  const $sql = $('sql');
  const $head = $('head');

  /** @type {{id:number,title:string,mapper:string,verb:string,tables:string,cond:string,info:string,time:string,warn:string,sql:string,search:string}[]} */
  let all = [];
  let shown = [];
  let cur = -1; // 고른 쿼리의 id
  let rules = { include: [], exclude: [], latestOnly: false };
  let diagnosis = [];

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
    const q = all.find((x) => x.id === cur && shown.includes(x));
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

  function render() {
    $list.textContent = '';
    $('count').textContent = shown.length === all.length ? `최근 쿼리 ${all.length}` : `${shown.length} / ${all.length}`;
    if (!shown.length) {
      if (all.length) $list.appendChild(div('empty', '맞는 쿼리가 없습니다.'));
      else {
        const box = div('empty');
        box.appendChild(div('', '모은 쿼리가 없습니다.'));
        for (const line of diagnosis) box.appendChild(div('why', line));
        const b = document.createElement('button');
        b.textContent = '고른 로그에서 읽기';
        b.title = '터미널에서 SQL 로그를 드래그해 고른 뒤 누르세요 (편집기에서 고른 글 · 클립보드도 됨)';
        b.addEventListener('click', () => vscode.postMessage({ type: 'readSelection' }));
        box.appendChild(b);
        $list.appendChild(box);
      }
    }
    for (const q of shown) {
      const row = div('row' + (q.id === cur ? ' on' : ''));
      row.dataset.id = String(q.id);
      const t = div('t');
      const verb = document.createElement('span');
      verb.className = 'verb ' + q.verb;
      verb.textContent = q.verb;
      t.appendChild(verb);
      t.appendChild(document.createTextNode(q.title));
      t.title = q.title;
      row.appendChild(t);
      row.appendChild(div('m', [q.mapper, q.tables, q.time, q.info].filter(Boolean).join(' · ')));
      if (q.cond) row.appendChild(div('w', q.cond));
      $list.appendChild(row);
    }
    const q = all.find((x) => x.id === cur && shown.includes(x));
    $head.textContent = '';
    if (q) {
      $head.appendChild(document.createTextNode([q.title, q.mapper, q.time, q.info].filter(Boolean).join(' · ')));
      if (q.warn) {
        const w = document.createElement('span');
        w.className = 'warn';
        w.textContent = ' · ' + q.warn;
        $head.appendChild(w);
      }
      paint($sql, q.sql);
    } else {
      $sql.textContent = '';
    }
    renderRules();
    const on = $list.querySelector('.row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function applyFilter() {
    const words = $filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = all.filter((q) => words.every((w) => q.search.includes(w)));
    if (!shown.some((q) => q.id === cur)) cur = shown.length ? shown[0].id : -1;
    render();
  }

  function move(delta) {
    if (!shown.length) return;
    const i = shown.findIndex((q) => q.id === cur);
    cur = shown[Math.max(0, Math.min(shown.length - 1, (i < 0 ? 0 : i) + delta))].id;
    render();
  }

  const act = (type) => {
    if (shown.some((q) => q.id === cur)) vscode.postMessage({ type, id: cur });
  };

  $filter.addEventListener('input', applyFilter);
  $list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    cur = Number(row.dataset.id);
    render();
    $filter.focus();
  });
  $list.addEventListener('dblclick', (e) => {
    if (e.target.closest('.row')) act('send');
  });
  $('send').addEventListener('click', () => act('send'));
  $('copy').addEventListener('click', () => act('copy'));
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.target && (e.target.id === 'exAdd' || e.target.id === 'inAdd') && e.key !== 'Escape') return;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'PageDown') move(5);
    else if (e.key === 'PageUp') move(-5);
    else if (e.key === 'Enter') act('send');
    else if (e.key === 'Escape') vscode.postMessage({ type: 'close' });
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

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      const keep = m.note ? cur : -1; // 필터를 바꿔 다시 받은 목록이면 고른 쿼리 · 찾기 글을 그대로
      rules = m.filter;
      diagnosis = m.diagnose || [];
      renderRules();
      const $note = $('note');
      $note.textContent = m.note || '';
      $note.className = /못했/.test(m.note || '') ? 'err' : 'ok';
      filtered(m.excluded);
      if (m.note) {
        all = m.items.map((q) => Object.assign(q, { search: [q.title, q.mapper, q.verb, q.tables, q.sql].join('\n').toLowerCase() }));
        cur = keep;
        applyFilter();
        return;
      }
      all = m.items.map((q) => Object.assign(q, { search: [q.title, q.mapper, q.verb, q.tables, q.sql].join('\n').toLowerCase() }));
      $('opened').textContent = m.openedAt + ' 에 연 목록';
      $filter.value = '';
      cur = all.length ? all[0].id : -1;
      applyFilter();
      $filter.focus();
    } else if (m.type === 'copied') {
      $('copy').textContent = '복사됨';
      setTimeout(() => ($('copy').textContent = '복사'), 1200);
    }
  });
  window.addEventListener('focus', () => $filter.focus());
  vscode.postMessage({ type: 'ready' });
})();
