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
      $list.appendChild(div('empty', all.length ? '맞는 쿼리가 없습니다.' : '읽은 쿼리가 없습니다.'));
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
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
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
