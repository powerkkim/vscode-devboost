// 하단 패널 "DB 결과" 화면 (Webview 안에서 도는 순수 JS).
// 확장이 보낸 결과(탭별 표)와 메시지 기록을 그린다. 정렬·셀 선택·복사는 여기서 하고, 이어 받기·CSV 는 확장에 맡긴다.
(function () {
  const vscode = acquireVsCodeApi();
  const $tabs = document.getElementById('tabs');
  const $body = document.getElementById('body');
  const $status = document.getElementById('status');

  let tabs = []; // [{id,title,sql,columns,rows,done,ms,capped}]
  let log = [];
  let plan; // {sql, lines, ms}
  let active = 'log'; // 탭 id, 'plan', 'log'
  let pageSize = 500;
  const sort = {}; // 탭 id → {col, dir(1|-1)}
  const loading = {}; // 탭 id → 이어 받는 중
  const failed = {}; // 탭 id → 이어 받기 실패 메시지
  let selected; // 고른 칸 (td)

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmt = (n) => n.toLocaleString('ko-KR');
  const current = () => tabs.find((t) => t.id === active);

  function renderTabs() {
    $tabs.textContent = '';
    const add = (id, title, tip) => {
      const b = el('button', 'tab' + (id === active ? ' active' : ''), title);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(id === active));
      if (tip) b.title = tip;
      b.addEventListener('click', () => {
        active = id;
        render();
      });
      $tabs.appendChild(b);
    };
    for (const t of tabs) add(t.id, t.title, t.sql);
    if (plan) add('plan', '실행계획', plan.sql);
    add('log', '메시지');
  }

  /** 정렬된 행 번호 목록 (원래 행은 그대로 둔다 — 이어 받은 행이 뒤에 붙으므로) */
  function order(t) {
    const idx = t.rows.map((_, i) => i);
    const s = sort[t.id];
    if (!s) return idx;
    const numeric = t.columns[s.col] && t.columns[s.col].numeric;
    return idx.sort((a, b) => {
      const x = t.rows[a][s.col];
      const y = t.rows[b][s.col];
      if (x === y) return a - b;
      if (x === null) return 1; // NULL 은 항상 뒤
      if (y === null) return -1;
      const c = numeric ? Number(x) - Number(y) : x < y ? -1 : 1;
      return (c || a - b) * s.dir;
    });
  }

  function renderTable(t) {
    if (!t.columns.length) return el('div', 'empty', '칸이 없는 결과입니다.');
    const table = el('table');
    const head = el('tr');
    head.appendChild(el('th', 'rownum', '#'));
    t.columns.forEach((c, i) => {
      const th = el('th', c.numeric ? 'num' : '');
      th.scope = 'col';
      th.appendChild(document.createTextNode(c.name));
      if (c.type) th.appendChild(el('span', 'type', c.type));
      const s = sort[t.id];
      if (s && s.col === i) th.appendChild(el('span', 'sort', s.dir > 0 ? '▲' : '▼'));
      th.title = '눌러서 정렬 (화면에 가져온 행 안에서)';
      th.addEventListener('click', () => {
        // 오름 → 내림 → 원래 순서
        if (!s || s.col !== i) sort[t.id] = { col: i, dir: 1 };
        else if (s.dir > 0) sort[t.id] = { col: i, dir: -1 };
        else delete sort[t.id];
        render();
      });
      head.appendChild(th);
    });
    const thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    const tbody = el('tbody');
    const frag = document.createDocumentFragment();
    order(t).forEach((ri, n) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'rownum', String(n + 1)));
      t.rows[ri].forEach((v, ci) => {
        const numeric = t.columns[ci] && t.columns[ci].numeric;
        const td = el('td', (v === null ? 'null' : '') + (numeric ? ' num' : ''), v === null ? 'NULL' : v);
        if (v !== null && v.length > 40) td.title = v;
        td.dataset.value = v === null ? '' : v;
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    table.appendChild(tbody);
    return table;
  }

  function renderLog() {
    if (!log.length) return el('div', 'empty', '실행한 쿼리의 기록이 여기에 남습니다.');
    const box = el('div', 'log');
    // 최근 것이 위
    for (const e of [...log].reverse()) {
      const row = el('div', 'entry ' + e.kind);
      row.appendChild(el('span', 'time', e.time));
      row.appendChild(el('span', 'conn', e.connectionName));
      row.appendChild(el('span', 'text', e.text));
      if (e.sql) row.appendChild(el('span', 'sql', e.sql));
      box.appendChild(row);
    }
    return box;
  }

  function renderPlan() {
    return el('pre', 'plan', plan.lines.join('\n'));
  }

  /** 표를 탭으로 구분한 글로 (엑셀에 바로 붙여 넣을 수 있게). NULL 은 빈 칸 */
  function tsv(t, withHeader) {
    const lines = withHeader ? [t.columns.map((c) => c.name).join('\t')] : [];
    for (const ri of order(t)) lines.push(t.rows[ri].map((v) => (v === null ? '' : v.replace(/[\t\r\n]+/g, ' '))).join('\t'));
    return lines.join('\n');
  }

  function linkButton(text, onClick, disabled) {
    const b = el('button', '', text);
    b.type = 'button';
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderStatus() {
    $status.textContent = '';
    const t = current();
    if (active === 'plan' && plan) {
      $status.appendChild(el('span', '', `${(plan.ms / 1000).toFixed(2)}초`));
      $status.appendChild(el('span', 'spacer'));
      $status.appendChild(linkButton('복사', () => vscode.postMessage({ type: 'copy', text: plan.lines.join('\n') })));
      return;
    }
    if (!t) return;
    $status.appendChild(el('span', 'count', `${fmt(t.rows.length)}행${t.done ? '' : ' (더 있음)'}`));
    $status.appendChild(el('span', '', `${(t.ms / 1000).toFixed(2)}초`));
    if (!t.done && !t.capped) {
      $status.appendChild(
        linkButton(loading[t.id] ? '가져오는 중…' : `다음 ${fmt(pageSize)}행 가져오기`, () => {
          loading[t.id] = true;
          delete failed[t.id];
          renderStatus();
          vscode.postMessage({ type: 'more', id: t.id });
        }, loading[t.id])
      );
    }
    if (t.capped) $status.appendChild(el('span', '', `화면에는 ${fmt(t.rows.length)}행까지만 싣습니다. 조건을 좁혀 다시 실행하세요.`));
    if (failed[t.id]) $status.appendChild(el('span', 'fail', failed[t.id]));
    $status.appendChild(el('span', 'spacer'));
    $status.appendChild(linkButton('결과 복사', () => vscode.postMessage({ type: 'copy', text: tsv(t, false) })));
    $status.appendChild(linkButton('헤더 포함 복사', () => vscode.postMessage({ type: 'copy', text: tsv(t, true) })));
    $status.appendChild(linkButton('INSERT문으로 복사', () => vscode.postMessage({ type: 'copyInsert', id: t.id, order: order(t) })));
    $status.appendChild(linkButton('CSV 내보내기', () => vscode.postMessage({ type: 'csv', id: t.id })));
  }

  function render() {
    if (active === 'plan' && !plan) active = 'log';
    if (active !== 'log' && active !== 'plan' && !current()) active = tabs.length ? tabs[0].id : 'log';
    selected = undefined;
    renderTabs();
    $body.textContent = '';
    const t = current();
    $body.appendChild(active === 'plan' && plan ? renderPlan() : t ? renderTable(t) : renderLog());
    renderStatus();
  }

  // 칸을 누르면 고르고, Ctrl+C 로 그 칸을 복사한다
  $body.addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td || td.classList.contains('rownum')) return;
    if (selected) selected.classList.remove('selected');
    selected = td;
    td.classList.add('selected');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selected && !String(window.getSelection())) {
      e.preventDefault();
      vscode.postMessage({ type: 'copy', text: selected.dataset.value });
    }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'state') {
      tabs = m.tabs || [];
      log = m.log || [];
      plan = m.plan;
      active = m.active;
      pageSize = m.pageSize || pageSize;
      for (const k of Object.keys(sort)) if (!tabs.some((t) => String(t.id) === k)) delete sort[k];
      render();
    } else if (m.type === 'append') {
      const t = tabs.find((x) => x.id === m.id);
      if (!t) return;
      t.rows.push(...m.rows);
      t.done = m.done;
      t.capped = m.capped;
      delete loading[m.id];
      if (active === m.id) {
        const top = $body.scrollTop;
        render();
        $body.scrollTop = top; // 보던 자리 유지
      }
    } else if (m.type === 'moreFailed') {
      delete loading[m.id];
      failed[m.id] = m.message;
      if (active === m.id) renderStatus();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
