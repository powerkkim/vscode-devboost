// DB 스키마 화면 (Webview). 확장(schemaPanel.ts)이 보내는 state 를 그린다.
// 위: 수집 단계(① 범위 → ② 본 쿼리 → ③ 기본값 → ④ 저장), 아래: 가져온 데이터 + 테이블 정의서 추출.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  // 알림은 다시 그리기(render)와 상관없이 남아 있도록 app 밖에 둔다
  const noticeBar = document.createElement('div');
  noticeBar.className = 'notice';
  document.body.append(noticeBar);
  const post = (m) => vscode.postMessage(m);
  let state = null;
  /** 정의서로 뽑을 테이블 (파일별로 기억) */
  let selected = new Set();
  let selectedFile = null;
  /** 지금 화면이 알고 있는 스키마 판 (저장·파일 선택 때 바뀜) */
  let seenRev = null;
  let knownTables = new Set();
  let filter = '';
  let includeViews = false;
  let openTable = null;
  const details = {};
  const timers = {};

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };
  const fmt = (n) => (n ?? 0).toLocaleString('ko-KR');

  function notice(text, kind) {
    const bar = noticeBar;
    bar.textContent = text;
    bar.className = `notice ${kind || 'info'} show`;
    clearTimeout(timers.notice);
    timers.notice = setTimeout(() => (bar.className = 'notice'), kind === 'warn' ? 9000 : 5000);
  }

  // ───────────────── 수집
  function stepHead(no, title, done, sub) {
    return h('div', { class: 'step-h' }, h('span', { class: `no${done ? ' done' : ''}` }, done ? '✔' : no), h('b', {}, title), sub ? h('span', { class: 'muted' }, sub) : null);
  }

  function problems(list) {
    if (!list || !list.length) return null;
    return h('div', { class: 'probs' }, list.map((p) => h('div', { class: p.level === 'error' ? 'err' : 'warn' }, p.level === 'error' ? '✖ ' : '⚠ ', p.message)));
  }

  function mainStatus(m) {
    if (!m) return h('div', { class: 'muted small' }, '아직 가져오지 않음');
    if (m.kind === 'json') return h('div', { class: 'ok' }, '✔ 저장 규격(JSON) 파일');
    const s = m.summary;
    const errors = (m.problems || []).some((p) => p.level === 'error');
    const exp = s && s.rows !== undefined ? s.rows : undefined;
    const bad = exp !== undefined && exp !== m.rows;
    return h(
      'div',
      {},
      h(
        'div',
        { class: errors ? 'bad-line' : 'ok' },
        errors ? '✖ ' : '✔ ',
        s && s.schema ? `${s.schema} · ` : '',
        s ? `접두어 ${s.prefixes.length ? s.prefixes.join(', ') : '전체'} · ` : '',
        `테이블 ${fmt(m.tables)} · `,
        h('span', { class: bad ? 'bad' : '' }, `컬럼 ${fmt(m.rows)}${bad ? ` / ${fmt(exp)}` : ''}`),
        ` · 제약 ${fmt(m.constraints)} · 인덱스 ${fmt(m.indexes)} · 기본값 ${fmt(m.defaults)}`
      ),
      problems(m.problems)
    );
  }

  function codeStatus(c) {
    if (!c) return null;
    return h('div', {}, h('div', { class: 'ok' }, `✔ 공통코드 ${fmt(c.codes)}개`), problems(c.problems));
  }

  /** 입력칸의 지금 값 (저장 지연과 관계없이 버튼에 실어 보냄) */
  function currentInputs() {
    const p = app.querySelector('input.prefix');
    const l = document.getElementById('label');
    return { prefixes: p ? p.value.split(/[,\s]+/) : undefined, label: l ? l.value : undefined };
  }

  function queryButtons(s) {
    const o = s.oracle;
    return h(
      'div',
      { class: 'btns' },
      h('button', { class: 'primary', onclick: () => post({ type: 'send', run: true, ...currentInputs() }), title: o.target ? `보낼 곳: ${o.target}` : '접속에서 Open SQL Worksheet 로 연 워크시트가 있으면 그곳으로, 없으면 새 워크시트' }, '▶ 워크시트에서 실행'),
      h('button', { onclick: () => post({ type: 'send', run: false, ...currentInputs() }) }, '워크시트에 넣기'),
      h('button', { onclick: () => post({ type: 'copySql', ...currentInputs() }), title: 'DBeaver 등 다른 도구에서 실행할 때' }, '쿼리 복사'),
      h('span', { class: 'sep' }),
      h('button', { class: 'accent', onclick: () => post({ type: 'importClipboard' }), title: '결과 그리드 전체(헤더 포함)를 복사한 뒤 누르세요' }, '📋 클립보드에서 가져오기')
    );
  }

  function collectSection(s) {
    const st = s.staged;
    const m = st.main;
    const mainOk = m && !(m.problems || []).some((p) => p.level === 'error');
    const canSave = mainOk || (st.codes && s.current);
    const prefixInput = h('input', {
      type: 'text', class: 'prefix', value: s.ui.prefixes.join(', '), placeholder: '비우면 전체 (예: TB_, TC_)', spellcheck: 'false',
      oninput: (e) => {
        clearTimeout(timers.prefix);
        timers.prefix = setTimeout(() => post({ type: 'settings', prefixes: e.target.value.split(/[,\s]+/), label: document.getElementById('label').value }), 400);
      },
    });
    const labelInput = h('input', {
      type: 'text', id: 'label', class: 'label', value: s.ui.label, placeholder: '개발 / 검증 / 운영', spellcheck: 'false',
      oninput: (e) => {
        clearTimeout(timers.label);
        timers.label = setTimeout(() => post({ type: 'settings', prefixes: prefixInput.value.split(/[,\s]+/), label: e.target.value }), 400);
      },
    });
    // 실제 파일 이름과 같은 규칙 (merge.ts schemaFileName)
    const safe = (x) => x.replace(/[\\/:*?"<>|\s]+/g, '_');
    const target = m && m.summary && m.summary.schema ? `.devboost/schema/${safe(m.summary.schema)}${s.ui.label ? '@' + safe(s.ui.label) : ''}.json` : '.devboost/schema/<스키마>.json';
    return h(
      'section',
      { class: 'collect' },
      h('div', { class: 'sec-h' }, h('span', {}, '수집'), h('span', { class: 'muted small' }, 'DB 에 직접 접속하지 않습니다. 아래 쿼리를 실행하고 결과를 복사해 오면 됩니다.')),
      h(
        'div',
        { class: 'step' },
        stepHead('1', '범위', s.ui.prefixes.length > 0),
        h(
          'div',
          { class: 'row' },
          h('label', {}, '테이블 접두어'),
          prefixInput,
          h('label', {}, '환경'),
          labelInput
        ),
        h('div', { class: 'muted small' }, s.ui.prefixes.length ? `${s.ui.prefixes.join(', ')} 로 시작하는 테이블만 가져옵니다. 저장할 때 이 접두어 테이블만 교체하고 나머지는 그대로 둡니다.` : '모든 테이블을 가져옵니다.')
      ),
      h('div', { class: 'step' }, stepHead('2', '수집 쿼리', mainOk, '컬럼마다 한 행: 테이블·컬럼·기본값·PK/UK/FK·인덱스를 한 번에'), queryButtons(s), mainStatus(m), codeStatus(st.codes)),
      h(
        'div',
        { class: 'step' },
        stepHead('3', '저장', false),
        h(
          'div',
          { class: 'btns' },
          h('button', { class: 'primary', disabled: !canSave, onclick: () => post({ type: 'save' }) }, '저장'),
          h('span', { class: 'muted small' }, target),
          h('span', { class: 'sep' }),
          h('button', { class: 'link', onclick: () => post({ type: 'importFile' }), title: '행이 많아 CSV 로 내보냈을 때' }, '파일에서 가져오기'),
          m || st.codes ? h('button', { class: 'link', onclick: () => post({ type: 'clearStaged' }) }, '가져온 결과 비우기') : null
        )
      )
    );
  }

  // ───────────────── 가져온 데이터
  function visibleTables(cur) {
    const f = filter.trim().toUpperCase();
    return cur.tables.filter((t) => (includeViews || t.kind === 'table') && (!f || t.name.includes(f) || t.comment.toUpperCase().includes(f)));
  }

  function detailRow(t) {
    const d = details[t.name];
    if (!d) return h('tr', { class: 'detail' }, h('td', { colspan: 6 }, h('div', { class: 'muted pad' }, '불러오는 중…')));
    return h(
      'tr',
      { class: 'detail' },
      h(
        'td',
        { colspan: 6 },
        h(
          'table',
          { class: 'cols' },
          h('tr', {}, ['No', '컬럼명', '설명', '타입', 'NULL', '기본값', 'PK', 'FK'].map((x) => h('th', {}, x))),
          d.columns.map((c, i) =>
            h('tr', {}, h('td', {}, i + 1), h('td', { class: 'mono' }, c.name), h('td', {}, c.comment), h('td', { class: 'mono' }, c.type), h('td', {}, c.nullable ? 'Y' : 'N'), h('td', { class: 'mono' }, c.default), h('td', {}, c.pk ? 'Y' : ''), h('td', { class: 'mono' }, c.fk))
          )
        ),
        d.indexes.length
          ? h('div', { class: 'idx' }, '인덱스: ', d.indexes.map((x, i) => h('span', { class: 'mono' }, (i ? ' · ' : '') + `${x.name}${x.unique ? ' (U)' : ''} [${x.columns}]`)))
          : null
      )
    );
  }

  function dataSection(s) {
    const cur = s.current;
    if (!cur) {
      return h('section', {}, h('div', { class: 'sec-h' }, h('span', {}, '가져온 데이터')), h('div', { class: 'muted pad' }, '저장된 스키마가 없습니다. 위에서 수집해 저장하면 여기에 테이블 목록이 나옵니다.'));
    }
    if (selectedFile !== cur.file) {
      selectedFile = cur.file;
      selected = new Set(cur.tables.filter((t) => t.kind === 'table').map((t) => t.name));
      knownTables = new Set(cur.tables.map((t) => t.name));
      openTable = null;
    } else {
      // 같은 파일을 다시 저장해 새로 생긴 테이블은 선택에 넣는다
      for (const t of cur.tables) {
        if (!knownTables.has(t.name)) {
          knownTables.add(t.name);
          if (t.kind === 'table') selected.add(t.name);
        }
      }
    }
    const vis = visibleTables(cur);
    const picked = vis.filter((t) => selected.has(t.name));
    const src = cur.source;
    const fileSelect = h(
      'select',
      { onchange: (e) => post({ type: 'select', file: e.target.value }) },
      s.files.map((f) => h('option', { value: f.file, selected: f.file === cur.file }, `${f.schema}${f.label ? ' · ' + f.label : ''} (테이블 ${f.tables})`))
    );
    const allBox = h('input', {
      type: 'checkbox', checked: vis.length > 0 && picked.length === vis.length,
      onchange: (e) => {
        vis.forEach((t) => (e.target.checked ? selected.add(t.name) : selected.delete(t.name)));
        render();
      },
    });
    const rows = [];
    for (const t of vis) {
      rows.push(
        h(
          'tr',
          { class: `t${openTable === t.name ? ' open' : ''}` },
          h('td', {}, h('input', { type: 'checkbox', checked: selected.has(t.name), onchange: (e) => (e.target.checked ? selected.add(t.name) : selected.delete(t.name), render()) })),
          h(
            'td',
            { class: 'mono name' },
            h('a', {
              href: '#',
              onclick: (e) => {
                e.preventDefault();
                openTable = openTable === t.name ? null : t.name;
                if (openTable && !details[t.name]) post({ type: 'detail', table: t.name });
                render();
              },
            }, (openTable === t.name ? '▾ ' : '▸ ') + t.name),
            t.kind === 'view' ? h('span', { class: 'badge' }, '뷰') : null
          ),
          h('td', {}, t.comment),
          h('td', { class: 'num' }, t.columns),
          h('td', { class: 'mono small' }, t.pk),
          h('td', {})
        )
      );
      if (openTable === t.name) rows.push(detailRow(t));
    }
    const exp = s.lastExport;
    return h(
      'section',
      { class: 'data' },
      h('div', { class: 'sec-h' }, h('span', {}, '가져온 데이터'), fileSelect),
      h(
        'div',
        { class: 'muted small info' },
        `${src.schema}${src.database ? ' @ ' + src.database : ''}${src.label ? ' · ' + src.label : ''} · 수집 ${(src.collectedAt || '').replace('T', ' ').slice(0, 16)} · 접두어 ${src.prefixes && src.prefixes.length ? src.prefixes.join(', ') : '전체'} · 테이블 ${fmt(cur.tables.filter((t) => t.kind === 'table').length)} · 뷰 ${fmt(cur.tables.filter((t) => t.kind === 'view').length)} · 기본값 ${fmt(cur.defaults)}${cur.codes ? ' · 공통코드 ' + fmt(cur.codes) : ''}`
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('input', {
          type: 'text', class: 'filter', placeholder: '테이블명·설명 검색', value: filter, spellcheck: 'false',
          oninput: (e) => {
            filter = e.target.value;
            clearTimeout(timers.filter);
            timers.filter = setTimeout(() => {
              render();
              const f = app.querySelector('input.filter');
              if (f) {
                f.focus();
                f.setSelectionRange(f.value.length, f.value.length);
              }
            }, 150);
          },
        }),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: includeViews, onchange: (e) => ((includeViews = e.target.checked), render()) }), '뷰 포함'),
        h('span', { class: 'muted small' }, `${fmt(picked.length)}개 선택`),
        h('span', { class: 'sep' }),
        h('button', { class: 'primary', disabled: picked.length === 0, onclick: () => post({ type: 'exportDoc', tables: picked.map((t) => t.name) }) }, '테이블 정의서로 추출 (Excel)')
      ),
      exp
        ? h(
            'div',
            { class: 'exported' },
            `✔ 테이블 ${exp.tables}개 정의서 저장됨 · `,
            exp.files.map((f) => [h('a', { href: '#', title: f.path, onclick: (e) => (e.preventDefault(), post({ type: 'openPath', path: f.path, external: true })) }, `${f.label} 열기`), ' · ']),
            h('a', { href: '#', onclick: (e) => (e.preventDefault(), post({ type: 'openPath', path: exp.files[0].path })) }, '폴더 열기')
          )
        : null,
      h(
        'table',
        { class: 'tables' },
        h('tr', {}, h('th', {}, allBox), h('th', {}, '테이블명'), h('th', {}, '설명'), h('th', { class: 'num' }, '컬럼'), h('th', {}, 'PK'), h('th', {})),
        rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted pad' }, '조건에 맞는 테이블이 없습니다.'))
      )
    );
  }

  function render() {
    if (!state) return;
    const s = state;
    app.innerHTML = '';
    app.append(
      ...[
      h('header', {}, h('b', {}, 'DB 스키마'), h('span', { class: 'muted small' }, '스키마 가져오기 · 테이블 정의서')),
      s.hasWorkspace ? null : h('div', { class: 'warn-box' }, '워크스페이스 폴더를 열어야 스키마를 저장할 수 있습니다.'),
      collectSection(s),
      dataSection(s),
      ].filter(Boolean)
    );
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      // 보고 있는 스키마가 바뀌면(다른 파일·다시 저장) 받아 둔 상세는 버리고, 열려 있던 표는 다시 받는다
      const rev = m.current ? m.current.rev : null;
      if (rev !== seenRev) {
        seenRev = rev;
        for (const k of Object.keys(details)) delete details[k];
        if (openTable && m.current && m.current.tables.some((t) => t.name === openTable)) post({ type: 'detail', table: openTable });
      }
      state = m;
      const focusedPrefix = document.activeElement && document.activeElement.classList.contains('prefix');
      const focusedLabel = document.activeElement && document.activeElement.id === 'label';
      if (focusedPrefix || focusedLabel) return; // 입력 중에는 다시 그리지 않음 (포커스 유지)
      render();
    } else if (m.type === 'detail') {
      details[m.table] = m;
      render();
    } else if (m.type === 'notice') {
      notice(m.text, m.kind);
    }
  });

  post({ type: 'ready' });
})();
