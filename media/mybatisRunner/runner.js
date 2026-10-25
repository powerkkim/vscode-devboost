// MyBatis SQL 실행 화면 (Webview). 확장(runnerPanel.ts)이 보내는 state 를 그린다.
// 입력칸은 쿼리나 파라미터 목록이 바뀔 때만 새로 만든다 → 타이핑 중 포커스를 잃지 않음.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = null;
  let paramSig = '';
  const timers = {};

  const TYPES = [
    ['auto', '자동'],
    ['string', '문자'],
    ['number', '숫자'],
    ['date', '날짜'],
    ['list', '목록'],
    ['json', 'JSON'],
    ['null', 'null'],
    ['empty', "''"],
  ];
  const USE_LABEL = { bind: '#{}', raw: '${}', test: '조건', collection: '목록' };
  const HINT = {
    auto: '빈칸 = null',
    string: '문자열 그대로',
    number: '숫자',
    date: '2026-10-25 또는 2026-10-25 13:00:00',
    list: '1, 2, 3 또는 ["a","b"]',
    json: '{"id":1} / [{"id":1}]',
    null: '',
    empty: '',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'indent') el.style.paddingLeft = `${v}px`; // style 속성은 CSP 로 막혀 있어 CSSOM 으로
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  const post = (m) => vscode.postMessage(m);

  // ── SQL 간단 색칠 (키워드·문자열·바인드 변수·주석)
  const KW = /\b(SELECT|DISTINCT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|LIKE|BETWEEN|EXISTS|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AS|GROUP|BY|ORDER|HAVING|UNION|ALL|MINUS|INTERSECT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|MERGE|USING|MATCHED|WHEN|THEN|ELSE|END|CASE|WITH|ASC|DESC|NVL|DECODE|TO_DATE|TO_TIMESTAMP|TO_CHAR|COUNT|SUM|MAX|MIN|AVG|ROWNUM|OVER|PARTITION|CONNECT|START|PRIOR|FETCH|FIRST|NEXT|ROWS|ONLY|OFFSET|DUAL|VARIABLE|EXEC|NUMBER|VARCHAR2|CLOB)\b/gi;
  function highlight(sql) {
    const out = [];
    const re = /('(?:[^']|'')*')|(--[^\n]*|\/\*[\s\S]*?\*\/)|(:[A-Za-z_]\w*)|([^'\-/:]+|[\-/:])/g;
    let m;
    while ((m = re.exec(sql))) {
      if (m[1]) out.push(`<span class="s">${esc(m[1])}</span>`);
      else if (m[2]) out.push(`<span class="c">${esc(m[2])}</span>`);
      else if (m[3]) out.push(`<span class="b">${esc(m[3])}</span>`);
      else out.push(esc(m[4]).replace(KW, (k) => `<span class="k">${k}</span>`));
    }
    return out.join('');
  }

  function notice(text, kind) {
    const bar = document.getElementById('notice');
    if (!bar) return;
    bar.textContent = text;
    bar.className = `notice ${kind || 'info'} show`;
    clearTimeout(timers.__notice);
    timers.__notice = setTimeout(() => (bar.className = 'notice'), 4000);
  }

  // ── 파라미터
  function paramRow(p) {
    const select = h(
      'select',
      { class: 'ptype', title: '값 종류' },
      TYPES.map(([v, l]) => h('option', { value: v, selected: p.type === v }, l))
    );
    const input = h('input', {
      class: 'pval',
      type: 'text',
      value: p.value || '',
      placeholder: HINT[p.type] || '',
      spellcheck: 'false',
      'data-path': p.path,
    });
    const send = () => post({ type: 'input', path: p.path, paramType: select.value, value: input.value });
    input.addEventListener('input', () => {
      clearTimeout(timers[p.path]);
      timers[p.path] = setTimeout(send, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(timers[p.path]);
        send();
      }
    });
    select.addEventListener('change', () => {
      input.placeholder = HINT[select.value] || '';
      input.disabled = select.value === 'null' || select.value === 'empty';
      send();
    });
    input.disabled = p.type === 'null' || p.type === 'empty';
    const uses = p.uses.map((u) => h('span', { class: `use use-${u}`, title: u === 'raw' ? '값이 SQL 에 그대로 들어감 (따옴표 없음)' : '' }, USE_LABEL[u] || u));
    const remembered = p.remembered === 'name' ? h('span', { class: 'rem', title: '다른 쿼리에서 같은 이름으로 넣은 값' }, '공통') : null;
    return h(
      'tr',
      {},
      h('td', { class: 'pname' }, h('a', { href: '#', title: `${p.line}행`, onclick: (e) => (e.preventDefault(), post({ type: 'reveal', line: p.line })) }, p.path), p.jdbcType ? h('span', { class: 'jt' }, p.jdbcType) : null),
      h('td', { class: 'puses' }, uses, remembered),
      h('td', {}, select),
      h('td', { class: 'pinput' }, input)
    );
  }

  // ── 분기
  const OV = [
    [null, '자동'],
    ['on', '켜기'],
    ['off', '끄기'],
  ];
  function branchRow(b, overrides) {
    const icon = b.on ? '●' : b.how === 'unknown' ? '?' : '○';
    const cls = `br ${b.on ? 'on' : 'off'} ${b.how}`;
    const label =
      b.tag === 'otherwise' ? 'otherwise' : b.tag === 'foreach' ? `foreach ${b.expr}` : b.tag === 'include' ? `include ${b.expr}` : b.tag === 'bind' ? `bind ${b.expr}` : `${b.tag} ${b.expr}`;
    const togglable = b.tag === 'if' || b.tag === 'when';
    const current = b.how === 'manual' ? (b.on ? 'on' : 'off') : null;
    const seg = togglable
      ? h(
          'span',
          { class: 'seg' },
          OV.map(([v, l]) =>
            h('button', { class: (current === v ? 'sel ' : '') + (v || 'auto'), title: v ? `강제로 ${l}` : '값으로 자동 판단', onclick: () => post({ type: 'override', key: b.key, state: v }) }, l)
          )
        )
      : null;
    const hits = b.evals > 1 && togglable ? h('span', { class: 'hits', title: 'foreach 안에서 참이 된 횟수' }, `${b.hits}/${b.evals}`) : null;
    return h(
      'div',
      { class: cls, indent: 8 + b.depth * 14 },
      h('span', { class: 'dot' }, icon),
      h(
        'a',
        { class: 'expr', href: '#', title: `${label}\n${b.file ? b.file + ' ' : ''}${b.line}행으로 이동`, onclick: (e) => (e.preventDefault(), post({ type: 'reveal', file: b.fsPath, line: b.line })) },
        label
      ),
      hits,
      b.note ? h('span', { class: 'note' }, b.note) : null,
      b.file ? h('span', { class: 'from' }, b.file) : null,
      seg
    );
  }

  function render(s) {
    const sig = s.key + '|' + s.params.map((p) => p.path).join(',');
    const rebuildParams = sig !== paramSig;
    paramSig = sig;
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.path : null;

    if (!document.getElementById('root') || rebuildParams) {
      app.innerHTML = '';
      app.append(layout(s));
    }
    // 헤더
    document.getElementById('title').innerHTML =
      `<span class="type type-${s.stmtType}">${s.stmtType.toUpperCase()}</span> <b>${esc(s.namespace.split('.').pop())}</b>.${esc(s.id)}`;
    const fileLink = document.getElementById('file');
    fileLink.textContent = `${s.file}:${s.line}`;
    document.getElementById('modeLiteral').classList.toggle('sel', s.mode === 'literal');
    document.getElementById('modeBind').classList.toggle('sel', s.mode === 'bind');

    // 파라미터: 포커스 중인 칸은 건드리지 않는다
    if (!rebuildParams) {
      for (const p of s.params) {
        const input = app.querySelector(`input[data-path="${CSS.escape(p.path)}"]`);
        if (input && p.path !== focused && input.value !== (p.value || '')) input.value = p.value || '';
      }
    }
    document.getElementById('pcount').textContent = s.params.length ? `${s.params.length}` : '';

    // 분기
    const bl = document.getElementById('branches');
    bl.innerHTML = '';
    const tog = s.branches.filter((b) => b.tag === 'if' || b.tag === 'when');
    const unknown = s.branches.filter((b) => b.how === 'unknown').length;
    document.getElementById('bcount').textContent = tog.length
      ? `${tog.filter((b) => b.on).length}/${tog.length} 켜짐${unknown ? ` · 자동 평가 못 함 ${unknown}` : ''}`
      : '';
    if (s.branches.length === 0) bl.append(h('div', { class: 'muted pad' }, '동적 조건이 없는 쿼리입니다.'));
    s.branches.forEach((b) => bl.append(branchRow(b)));

    // 경고
    const wl = document.getElementById('warnings');
    wl.innerHTML = '';
    const ws = [...s.warnings];
    if (s.indexing) ws.unshift('다른 mapper 파일을 읽는 중… (다른 파일의 <sql> 조각은 잠시 뒤 반영)');
    wl.style.display = ws.length ? '' : 'none';
    ws.forEach((w) => wl.append(h('div', { class: 'warn' }, '⚠ ', w)));

    // SQL
    document.getElementById('sql').innerHTML = highlight(s.sql) || '<span class="muted">(빈 SQL)</span>';
    const bindBox = document.getElementById('binds');
    bindBox.innerHTML = '';
    if (s.mode === 'bind') {
      bindBox.append(
        h('div', { class: 'muted small hint' }, 'VARIABLE 로 바인드 변수를 만들고 EXEC 로 값을 넣은 뒤 쿼리를 실행하는 스크립트입니다. 워크시트에서 F5(스크립트 실행)로 돌립니다.')
      );
    }
    const target = document.getElementById('target');
    target.textContent = s.oracle.installed
      ? s.oracle.target
        ? `보낼 곳: ${s.oracle.target}`
        : '보낼 곳: 새 워크시트 (접속에서 Open SQL Worksheet 로 연 워크시트가 있으면 그곳으로)'
      : 'Oracle SQL Developer 확장이 없어 일반 SQL 편집기로 엽니다';
    const runBtn = document.getElementById('run');
    const how = s.mode === 'bind' ? ' (F5)' : '';
    runBtn.textContent = s.stmtType === 'select' ? `▶ 워크시트에서 실행${how}` : `▶ ${s.stmtType.toUpperCase()} 실행…${how}`;
    runBtn.title = s.mode === 'bind' ? '워크시트에 넣고 스크립트 실행(F5): VARIABLE·EXEC 로 값을 바인드한 뒤 쿼리 실행' : '워크시트에 넣고 문장 실행(Ctrl+Enter)';
    runBtn.classList.toggle('danger', s.stmtType !== 'select');
  }

  function layout(s) {
    const params = h('tbody', {}, s.params.map(paramRow));
    return h(
      'div',
      { id: 'root' },
      h(
        'header',
        {},
        h('div', { id: 'title' }),
        h('a', { id: 'file', href: '#', title: '쿼리 위치로 이동', onclick: (e) => (e.preventDefault(), post({ type: 'reveal', line: s.line })) }),
        h(
          'span',
          { class: 'modes', title: '값을 SQL 에 직접 넣을지, :이름 바인드 변수로 남길지' },
          h('button', { id: 'modeLiteral', onclick: () => post({ type: 'mode', mode: 'literal' }) }, '값 넣기'),
          h('button', { id: 'modeBind', onclick: () => post({ type: 'mode', mode: 'bind' }) }, '바인드 변수')
        )
      ),
      h(
        'div',
        { class: 'cols' },
        h(
          'div',
          { class: 'left' },
          h(
            'section',
            {},
            h('div', { class: 'sec-h' }, h('span', {}, '파라미터 ', h('span', { id: 'pcount', class: 'badge' })), h('button', { class: 'link', onclick: () => post({ type: 'clear' }) }, '모두 비우기')),
            s.params.length
              ? h('table', { class: 'params' }, params)
              : h('div', { class: 'muted pad' }, '입력할 파라미터가 없습니다.')
          ),
          h(
            'section',
            {},
            h(
              'div',
              { class: 'sec-h' },
              h('span', {}, '조건 ', h('span', { id: 'bcount', class: 'badge' })),
              h(
                'span',
                {},
                h('button', { class: 'link', title: '수동 지정을 모두 풀고 값으로 판단', onclick: () => post({ type: 'overrideAll', state: null }) }, '모두 자동'),
                h('button', { class: 'link', title: '모든 if/when 켜기 (가장 긴 SQL)', onclick: () => post({ type: 'overrideAll', state: 'on' }) }, '모두 켜기'),
                h('button', { class: 'link', onclick: () => post({ type: 'overrideAll', state: 'off' }) }, '모두 끄기')
              )
            ),
            h('div', { id: 'branches' })
          )
        ),
        h(
          'div',
          { class: 'right' },
          h('div', { id: 'warnings' }),
          h(
            'section',
            { class: 'sqlsec' },
            h(
              'div',
              { class: 'actions' },
              h('button', { id: 'run', class: 'primary', onclick: () => post({ type: 'send', action: 'run' }) }, '▶ 워크시트에서 실행'),
              h('button', { onclick: () => post({ type: 'send', action: 'insert' }), title: '워크시트에 넣기만 하고 실행은 직접 (값 넣기: Ctrl+Enter / 바인드 변수: F5)' }, '워크시트에 넣기'),
              h(
                'button',
                { onclick: () => post({ type: 'send', action: 'explain' }), title: '바인드 변수 형태(:이름)의 SQL 로 실행 계획 (F10) — 운영에서 MyBatis 가 실행하는 방식과 같은 조건. 값 입력 없이 계획을 만듦' },
                '실행 계획'
              ),
              h('button', { onclick: () => post({ type: 'copy' }) }, '복사')
            ),
            h('div', { id: 'target', class: 'muted small' }),
            h('pre', { id: 'sql' }),
            h('div', { id: 'binds' })
          )
        )
      ),
      h('div', { id: 'notice', class: 'notice' })
    );
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      state = m;
      render(m);
    } else if (m.type === 'error') {
      paramSig = '';
      app.innerHTML = '';
      app.append(h('div', { class: 'empty' }, m.message));
    } else if (m.type === 'notice') {
      notice(m.text, m.kind);
    }
  });

  post({ type: 'ready' });
})();
