// API 콘솔 화면. 모음·환경은 화면이 고치고(확장에 저장을 맡김), 보내기·파일·클립보드는 확장이 한다.
(function () {
  const vscode = acquireVsCodeApi();
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const BODY_MODES = [
    ['none', '없음'],
    ['json', 'JSON'],
    ['text', '글'],
    ['form', 'form'],
    ['multipart', '파일 첨부(multipart)'],
  ];

  /** 화면 상태 */
  const S = {
    version: '',
    collections: [],
    environments: [],
    activeEnvironment: undefined,
    history: [],
    cookies: 0,
    /** 고른 요청의 id. 모음에 없는 요청(기록에서 연 것)은 draft 에 둔다 */
    selected: undefined,
    draft: undefined,
    tab: 'params',
    resTab: 'body',
    jsonView: 'tree',
    filter: '',
    sideHidden: false,
    histOpen: true,
    renaming: undefined,
    /** 요청 id → 마지막 응답 */
    responses: {},
    sending: undefined,
    find: '',
    findAt: 0,
    envDialog: false,
    envEditing: undefined,
  };
  const saved = vscode.getState() || {};

  /* ---------------------------------------------------------------- 도구 */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === undefined || kid === null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }
  let idSeq = 0;
  const newId = () => Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  const emptyRequest = (name) => ({ id: newId(), kind: 'request', name: name || '새 요청', method: 'GET', url: '', params: [], headers: [], bodyMode: 'none', bodyText: '', bodyForm: [], auth: { type: 'none' }, note: '' });
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function findNode(nodes, id) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { node: n, parent: nodes, index: i };
      if (n.kind === 'folder') {
        const hit = findNode(n.items, id);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  const current = () => (S.draft && S.draft.id === S.selected ? S.draft : (findNode(S.collections, S.selected) || {}).node);
  const isDraft = () => !!S.draft && S.draft.id === S.selected;

  let saveTimer;
  /** 고친 것을 확장에 넘겨 저장 (조금 모아서) */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      vscode.postMessage({ type: 'save', data: { collections: S.collections, environments: S.environments, activeEnvironment: S.activeEnvironment } });
    }, 300);
    vscode.setState({ selected: S.selected, tab: S.tab, sideHidden: S.sideHidden, histOpen: S.histOpen, jsonView: S.jsonView });
  }

  let toastTimer;
  function toast(text) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    document.body.appendChild(h('div', { class: 'toast', text }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => document.querySelectorAll('.toast').forEach((t) => t.remove()), 2200);
  }

  function closeMenu() {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  /** 작은 메뉴. items: [글, 함수] 또는 '-' (구분선) */
  function menu(anchor, items) {
    closeMenu();
    const m = h(
      'div',
      { class: 'menu' },
      items.map((it) =>
        it === '-'
          ? h('hr')
          : h('div', {
              text: it[0],
              onclick: () => {
                closeMenu();
                it[1]();
              },
            })
      )
    );
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.min(r.bottom + 2, window.innerHeight - m.offsetHeight - 8) + 'px';
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('[data-menu]')) closeMenu();
  });

  const pending = {};
  /** 확장에 묻고 답을 기다린다 (token 으로 짝) */
  function ask(type, extra) {
    const token = newId();
    return new Promise((resolve) => {
      pending[token] = resolve;
      vscode.postMessage(Object.assign({ type, token }, extra));
    });
  }

  /* ---------------------------------------------------------------- 왼쪽 목록 */
  const $app = document.getElementById('app');
  const $side = h('div', { class: 'side' });
  const $main = h('div', { class: 'main' });
  $app.append($side, $main);

  function matches(n, q) {
    if (!q) return true;
    if (n.kind === 'folder') return n.name.toLowerCase().includes(q) || n.items.some((x) => matches(x, q));
    return (n.name + ' ' + n.url + ' ' + n.method).toLowerCase().includes(q);
  }

  function select(id) {
    if (S.draft && S.draft.id !== id) S.draft = undefined;
    S.selected = id;
    S.find = '';
    persist();
    renderSide();
    renderMain();
  }

  function addRequest(parent, base) {
    const r = base ? Object.assign(clone(base), { id: newId(), kind: 'request' }) : emptyRequest();
    parent.push(r);
    S.draft = undefined;
    S.selected = r.id;
    S.renaming = base ? undefined : r.id;
    persist();
    renderSide();
    renderMain();
    return r;
  }

  function addFolder(parent, name) {
    const f = { kind: 'folder', id: newId(), name: name || '새 폴더', items: [] };
    parent.push(f);
    S.renaming = f.id;
    persist();
    renderSide();
    return f;
  }

  /** 새 요청을 넣을 곳: 고른 요청이 있는 폴더, 없으면 첫 모음 (없으면 만든다) */
  function homeFolder() {
    const hit = S.selected && findNode(S.collections, S.selected);
    if (hit) return hit.node.kind === 'folder' ? hit.node.items : hit.parent === S.collections ? firstCollection().items : hit.parent;
    return firstCollection().items;
  }
  function firstCollection() {
    let c = S.collections.find((n) => n.kind === 'folder');
    if (!c) {
      c = { kind: 'folder', id: newId(), name: '내 API', items: [] };
      S.collections.push(c);
    }
    return c;
  }

  function removeNode(id) {
    const hit = findNode(S.collections, id);
    if (!hit) return;
    const inside = hit.node.kind === 'folder' && S.selected && findNode(hit.node.items, S.selected);
    hit.parent.splice(hit.index, 1);
    if (S.selected === id || inside) S.selected = undefined;
    persist();
    renderSide();
    renderMain();
  }

  function cloneNode(n) {
    const c = clone(n);
    (function walk(x) {
      x.id = newId();
      if (x.kind === 'folder') x.items.forEach(walk);
    })(c);
    return c;
  }

  function moveNode(id, targetId, into) {
    const src = findNode(S.collections, id);
    if (!src || id === targetId) return;
    if (src.node.kind === 'folder' && findNode(src.node.items, targetId)) return;
    src.parent.splice(src.index, 1);
    const dst = findNode(S.collections, targetId);
    if (!dst) S.collections.push(src.node);
    else if (into && dst.node.kind === 'folder') {
      dst.node.items.push(src.node);
      dst.node.collapsed = false;
    } else dst.parent.splice(dst.index, 0, src.node);
    persist();
    renderSide();
  }

  let dragId;
  function nodeRow(n, depth, parent) {
    const q = S.filter.trim().toLowerCase();
    const row = h('div', { class: 'node ' + n.kind + (n.id === S.selected ? ' on' : ''), style: `padding-left:${6 + depth * 12}px`, draggable: 'true', dataset: { id: n.id } });
    row.addEventListener('dragstart', (e) => {
      dragId = n.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === n.id) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const into = n.kind === 'folder' && e.clientY > r.top + r.height * 0.3;
      row.classList.toggle('drop-into', into);
      row.classList.toggle('drop-before', !into);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into', 'drop-before'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const into = row.classList.contains('drop-into');
      row.classList.remove('drop-into', 'drop-before');
      if (dragId) moveNode(dragId, n.id, into);
      dragId = undefined;
    });

    if (S.renaming === n.id) {
      const before = n.name;
      const input = h('input', { type: 'text', value: n.name });
      const done = (keep) => {
        if (S.renaming !== n.id) return;
        S.renaming = undefined;
        // 고치지 않고 나가면 그대로 둔다 (그사이 cURL 붙여넣기 등으로 이름이 바뀌었을 수 있다)
        if (keep && input.value.trim() && input.value !== before) n.name = input.value.trim();
        persist();
        renderSide();
        if (n.id === S.selected) renderMain();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') done(false);
        e.stopPropagation();
      });
      input.addEventListener('blur', () => done(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      row.append(h('span', { class: 'tw' }), input);
      setTimeout(() => {
        input.focus();
        input.select();
      });
      return row;
    }

    const more = (e) => {
      e.stopPropagation();
      const items = [];
      if (n.kind === 'folder') {
        items.push(['요청 추가', () => ((n.collapsed = false), addRequest(n.items))], ['폴더 추가', () => ((n.collapsed = false), addFolder(n.items))], '-');
      }
      items.push(
        ['이름 바꾸기', () => ((S.renaming = n.id), renderSide())],
        [
          '복제',
          () => {
            const c = cloneNode(n);
            c.name += ' 복사';
            parent.splice(parent.indexOf(n) + 1, 0, c);
            persist();
            renderSide();
          },
        ],
        ['내보내기', () => vscode.postMessage({ type: 'export', id: n.id })],
        '-',
        ['삭제', () => removeNode(n.id)]
      );
      menu(e.currentTarget, items);
    };

    if (n.kind === 'folder') {
      const open = !n.collapsed || !!q;
      row.append(h('span', { class: 'tw', text: open ? '▾' : '▸' }), h('span', { class: 'nm', text: n.name, title: n.name }));
      row.append(h('span', { class: 'acts' }, h('button', { class: 'link', title: '요청 추가', text: '+', onclick: (e) => (e.stopPropagation(), (n.collapsed = false), addRequest(n.items)) }), h('button', { class: 'link', title: '더 보기', text: '⋯', 'data-menu': '1', onclick: more })));
      row.addEventListener('click', () => {
        n.collapsed = !n.collapsed;
        persist();
        renderSide();
      });
    } else {
      row.append(h('span', { class: 'mt ' + n.method, text: n.method === 'DELETE' ? 'DEL' : n.method.slice(0, 5) }), h('span', { class: 'nm', text: n.name, title: `${n.name}\n${n.url}` }));
      row.append(h('span', { class: 'acts' }, h('button', { class: 'link', title: '더 보기', text: '⋯', 'data-menu': '1', onclick: more })));
      row.addEventListener('click', () => select(n.id));
    }
    row.addEventListener('dblclick', () => {
      S.renaming = n.id;
      renderSide();
    });
    return row;
  }

  function renderTree(nodes, depth, out) {
    const q = S.filter.trim().toLowerCase();
    for (const n of nodes) {
      if (!matches(n, q)) continue;
      out.push(nodeRow(n, depth, nodes));
      if (n.kind === 'folder' && (!n.collapsed || q)) renderTree(n.items, depth + 1, out);
    }
  }

  function renderSide() {
    $side.className = 'side' + (S.sideHidden ? ' hidden' : '');
    const focusedFilter = document.activeElement && document.activeElement.id === 'filter';
    const rows = [];
    renderTree(S.collections, 0, rows);
    const tree = h('div', { class: 'tree' }, rows.length ? rows : h('div', { class: 'empty', text: S.filter ? '맞는 요청이 없습니다.' : '모음이 없습니다. + 로 모음을 만들거나, 가져오기로 Postman 모음을 불러오세요.' }));
    tree.addEventListener('dragover', (e) => dragId && e.target === tree && e.preventDefault());
    tree.addEventListener('drop', (e) => {
      if (e.target !== tree || !dragId) return;
      moveNode(dragId, undefined, false);
      dragId = undefined;
    });
    const hist = S.history.map((x) =>
      h(
        'div',
        {
          class: 'node',
          style: 'padding-left:8px',
          title: `${new Date(x.at).toLocaleString()}${x.environment ? ' · ' + x.environment : ''}\n${x.url}`,
          onclick: () => {
            // 기록에서 연 요청은 모음에 없는 임시 요청으로
            S.draft = Object.assign(clone(x.request), { id: newId(), kind: 'request' });
            S.selected = S.draft.id;
            renderSide();
            renderMain();
          },
        },
        h('span', { class: 'mt ' + x.method, text: x.method === 'DELETE' ? 'DEL' : x.method.slice(0, 5) }),
        h('span', { class: 'nm', text: x.url.replace(/^[a-z]+:\/\/[^/]+/i, '') || x.url }),
        h('span', { class: 'st status s' + String(x.status)[0], text: String(x.status) })
      )
    );
    $side.replaceChildren(
      h(
        'div',
        { class: 'side-head' },
        h('span', { class: 'title', text: 'API 콘솔' }),
        h('span', { class: 'ver', text: S.version ? 'v' + S.version : '' }),
        h('button', { class: 'link', title: '새 요청', text: '+ 요청', onclick: () => addRequest(homeFolder()) }),
        h('button', {
          class: 'link',
          title: '모음 · 가져오기 · 내보내기',
          text: '⋯',
          'data-menu': '1',
          onclick: (e) =>
            menu(e.currentTarget, [
              ['새 모음', () => addFolder(S.collections, '새 모음')],
              ['cURL 붙여넣기로 요청 만들기', curlDialog],
              '-',
              ['가져오기 (Postman 모음 · 내보낸 파일)', () => vscode.postMessage({ type: 'import' })],
              ['전체 내보내기', () => vscode.postMessage({ type: 'export' })],
              '-',
              [`쿠키 비우기 (${S.cookies})`, () => vscode.postMessage({ type: 'clearCookies' })],
            ]),
        })
      ),
      h('div', { class: 'side-search' }, h('input', { id: 'filter', type: 'text', placeholder: '이름 · 주소로 찾기', value: S.filter, oninput: (e) => ((S.filter = e.target.value), renderSide()) })),
      tree,
      h(
        'div',
        { class: 'sec', onclick: () => ((S.histOpen = !S.histOpen), persist(), renderSide()) },
        h('span', { text: `${S.histOpen ? '▾' : '▸'} 최근 실행 ${S.history.length}` }),
        S.history.length ? h('button', { class: 'link', text: '비우기', onclick: (e) => (e.stopPropagation(), vscode.postMessage({ type: 'clearHistory' })) }) : null
      ),
      S.histOpen ? h('div', { class: 'hist' }, hist) : null
    );
    if (focusedFilter) {
      const f = document.getElementById('filter');
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    }
  }

  function curlDialog() {
    const ta = h('textarea', { class: 'code', placeholder: "curl 'https://…' -H '…' --data-raw '…'", style: 'height:100%;min-height:0' });
    const err = h('span', { class: 'err' });
    const close = () => ov.remove();
    const ov = h(
      'div',
      { class: 'overlay', onclick: (e) => e.target === ov && close() },
      h(
        'div',
        { class: 'dialog', style: 'height:min(360px,80vh)' },
        h('div', { class: 'dialog-head' }, h('span', { text: 'cURL 붙여넣기' }), h('button', { class: 'link', text: '✕', onclick: close })),
        h('div', { style: 'flex:1;min-height:0;padding:10px 12px' }, ta),
        h(
          'div',
          { style: 'display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--line)' },
          err,
          h('span', { class: 'grow' }),
          h('button', {
            class: 'primary',
            text: '요청으로 만들기',
            onclick: async () => {
              const got = await ask('parseCurl', { text: ta.value });
              if (!got.request) {
                err.textContent = 'cURL 명령으로 읽을 수 없습니다.';
                return;
              }
              close();
              addRequest(homeFolder(), got.request);
            },
          })
        )
      )
    );
    document.body.appendChild(ov);
    ta.focus();
  }

  /* ---------------------------------------------------------------- 요청 편집 */
  /** 표 편집기: 켜기 · 이름 · 값 · 지우기. 마지막 빈 줄에 쓰기 시작하면 다음 빈 줄이 생긴다 */
  function kvTable(rows, opts) {
    const table = h('table', { class: 'kv' });
    const blank = () => ({ key: '', value: '', enabled: true });
    const draw = () => {
      table.replaceChildren();
      const all = rows.concat([blank()]);
      all.forEach((r, i) => {
        const isNew = i === rows.length;
        const tr = h('tr', { class: r.enabled ? '' : 'off' });
        const commit = () => {
          if (isNew && !rows.includes(r)) {
            rows.push(r);
            draw();
            // 방금 쓰던 칸으로 돌아간다
            const inputs = table.querySelectorAll('tr')[i].querySelectorAll('input[type=text]');
            const el = inputs[tr._col || 0];
            if (el) {
              el.focus();
              el.setSelectionRange(el.value.length, el.value.length);
            }
          }
          opts.onChange();
        };
        const key = h('input', { type: 'text', value: r.key, placeholder: opts.keyHint || '이름', oninput: (e) => ((r.key = e.target.value), (tr._col = 0), commit()) });
        const val = h('input', { type: 'text', value: r.value, placeholder: r.file ? '파일 경로' : opts.valueHint || '값', oninput: (e) => ((r.value = e.target.value), (tr._col = 1), commit()) });
        const cells = [h('td', { class: 'c' }, isNew ? null : h('input', { type: 'checkbox', checked: r.enabled, title: '보낼 때 포함', onchange: (e) => ((r.enabled = e.target.checked), tr.classList.toggle('off', !r.enabled), opts.onChange()) })), h('td', { class: 'k' }, key), h('td', {}, val)];
        const extra = [];
        if (opts.files && !isNew) {
          extra.push(
            h('button', {
              class: 'link',
              title: r.file ? '글 칸으로' : '파일 칸으로',
              text: r.file ? '파일' : '글',
              onclick: () => {
                r.file = !r.file;
                if (!r.file) delete r.file;
                opts.onChange();
                draw();
              },
            })
          );
          if (r.file)
            extra.push(
              h('button', {
                class: 'link',
                title: '파일 고르기',
                text: '찾기',
                onclick: async () => {
                  const got = await ask('pickFile', {});
                  r.value = got.path;
                  opts.onChange();
                  draw();
                },
              })
            );
        }
        if (!isNew)
          extra.push(
            h('button', {
              class: 'link',
              title: '줄 지우기',
              text: '✕',
              onclick: () => {
                rows.splice(rows.indexOf(r), 1);
                opts.onChange();
                draw();
              },
            })
          );
        cells.push(h('td', { class: 'x' }, extra));
        tr.append(...cells);
        table.appendChild(tr);
      });
    };
    draw();
    return table;
  }

  const count = (rows) => rows.filter((r) => r.enabled && r.key.trim()).length;

  function tabLabel(r, id) {
    if (id === 'params') return ['파라미터', count(r.params)];
    if (id === 'headers') return ['헤더', count(r.headers)];
    if (id === 'body') return ['Body', r.bodyMode === 'none' ? 0 : BODY_MODES.find((m) => m[0] === r.bodyMode)[1]];
    if (id === 'auth') return ['인증', r.auth.type === 'none' ? 0 : r.auth.type === 'bearer' ? 'Bearer' : 'Basic'];
    return ['메모', r.note.trim() ? '●' : 0];
  }

  function renderTabs(r) {
    const el = document.getElementById('req-tabs');
    if (!el) return;
    el.replaceChildren(
      ...['params', 'headers', 'body', 'auth', 'note'].map((id) => {
        const [name, n] = tabLabel(r, id);
        return h('div', { class: 'tab' + (S.tab === id ? ' on' : ''), onclick: () => ((S.tab = id), persist(), renderTabs(r), renderReqBody(r)) }, name, n ? h('span', { class: 'n', text: String(n) }) : null);
      })
    );
  }

  /** 고친 뒤: 저장을 맡기고 탭의 개수 표시를 맞춘다 (입력 칸은 다시 그리지 않는다) */
  function changed(r, alsoSide) {
    if (!isDraft()) persist();
    renderTabs(r);
    if (alsoSide) renderSide();
  }

  function renderReqBody(r) {
    const el = document.getElementById('req-body');
    if (!el) return;
    const onChange = () => changed(r);
    if (S.tab === 'params') {
      el.replaceChildren(kvTable(r.params, { onChange }), h('div', { class: 'hint', text: '주소 뒤에 ?이름=값 으로 붙습니다. 주소 칸에 ?… 를 붙여넣으면 이 표로 옮겨집니다.' }));
    } else if (S.tab === 'headers') {
      el.replaceChildren(kvTable(r.headers, { onChange, keyHint: '헤더 이름' }), h('div', { class: 'hint', text: 'Content-Type 과 Authorization 은 Body · 인증 탭에서 정한 대로 붙습니다. 여기에 직접 적으면 그 값이 우선입니다.' }));
    } else if (S.tab === 'body') {
      const modes = h(
        'div',
        { class: 'modes' },
        BODY_MODES.map(([id, name]) =>
          h(
            'label',
            {},
            h('input', {
              type: 'radio',
              name: 'bodyMode',
              checked: r.bodyMode === id,
              onchange: () => {
                r.bodyMode = id;
                changed(r);
                renderReqBody(r);
              },
            }),
            ' ' + name
          )
        )
      );
      let editor;
      if (r.bodyMode === 'json' || r.bodyMode === 'text') {
        const ta = h('textarea', { class: 'code', spellcheck: 'false', placeholder: r.bodyMode === 'json' ? '{\n  "이름": "값"\n}' : '', oninput: (e) => ((r.bodyText = e.target.value), changed(r)) });
        ta.value = r.bodyText;
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
            r.bodyText = ta.value;
            changed(r);
          }
        });
        if (r.bodyMode === 'json')
          modes.appendChild(
            h('button', {
              class: 'link',
              text: '정리',
              title: 'JSON 을 보기 좋게 (변수 {{…}} 가 따옴표 밖에 있으면 그대로 둡니다)',
              onclick: () => {
                try {
                  ta.value = r.bodyText = JSON.stringify(JSON.parse(r.bodyText), null, 2);
                  changed(r);
                } catch (e) {
                  toast('JSON 모양이 아닙니다: ' + e.message);
                }
              },
            })
          );
        editor = ta;
      } else if (r.bodyMode === 'form') editor = kvTable(r.bodyForm, { onChange });
      else if (r.bodyMode === 'multipart') editor = kvTable(r.bodyForm, { onChange, files: true });
      else editor = h('div', { class: 'hint', text: '본문 없이 보냅니다.' });
      el.replaceChildren(modes, editor);
      if (r.method === 'GET' && r.bodyMode !== 'none') el.appendChild(h('div', { class: 'hint', text: 'GET 은 본문을 보내지 않습니다. 메서드를 바꾸세요.' }));
    } else if (S.tab === 'auth') {
      const types = h(
        'div',
        { class: 'modes' },
        [
          ['none', '없음'],
          ['bearer', 'Bearer 토큰'],
          ['basic', 'Basic (아이디 · 비밀번호)'],
        ].map(([id, name]) =>
          h(
            'label',
            {},
            h('input', {
              type: 'radio',
              name: 'authType',
              checked: r.auth.type === id,
              onchange: () => {
                r.auth.type = id;
                changed(r);
                renderReqBody(r);
              },
            }),
            ' ' + name
          )
        )
      );
      const field = (label, key, hint) => [h('span', { class: 'dim', text: label }), h('input', { type: 'text', value: r.auth[key] || '', placeholder: hint, oninput: (e) => ((r.auth[key] = e.target.value), changed(r)) })];
      const form = h('div', { class: 'form' });
      if (r.auth.type === 'bearer') form.append(...field('토큰', 'token', '{{token}}'));
      if (r.auth.type === 'basic') form.append(...field('아이디', 'username', ''), ...field('비밀번호', 'password', ''));
      el.replaceChildren(types, form, h('div', { class: 'hint', text: `로그인 응답이 내려 준 쿠키(세션)는 닫을 때까지 자동으로 이어 보냅니다. 지금 ${S.cookies}개. 토큰은 환경 변수에 넣고 {{token}} 으로 쓰면 환경마다 바꿀 수 있습니다.` }));
    } else {
      const ta = h('textarea', { class: 'note', placeholder: '이 API 가 무엇인지, 필수 값, 주의할 점 등을 적어 둡니다.', oninput: (e) => ((r.note = e.target.value), changed(r)) });
      ta.value = r.note;
      el.replaceChildren(ta);
    }
  }

  function doSend() {
    const r = current();
    if (!r) return;
    if (S.sending) {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    const key = newId();
    S.sending = { key, id: r.id, at: Date.now() };
    vscode.postMessage({ type: 'send', key, request: r, envId: S.activeEnvironment });
    renderSendButton();
    renderResponse();
  }

  function renderSendButton() {
    const b = document.getElementById('send');
    if (!b) return;
    const mine = S.sending && S.sending.id === S.selected;
    b.textContent = mine ? '취소' : '보내기';
    b.className = mine ? '' : 'primary';
  }

  function envSelect() {
    const sel = h(
      'select',
      {
        title: '환경 (변수 묶음)',
        onchange: (e) => {
          S.activeEnvironment = e.target.value || undefined;
          persist();
        },
      },
      h('option', { value: '', text: '환경 없음' }),
      S.environments.map((e) => h('option', { value: e.id, text: e.name + (e.confirm ? ' ⚠' : '') }))
    );
    sel.value = S.activeEnvironment && S.environments.some((e) => e.id === S.activeEnvironment) ? S.activeEnvironment : '';
    return sel;
  }

  function renderMain() {
    const r = current();
    if (!r) {
      $main.replaceChildren(
        h(
          'div',
          { class: 'top' },
          h('button', { class: 'link', title: '목록 접기 · 펴기', text: '☰', onclick: toggleSide }),
          h('span', { class: 'grow' }),
          envSelect(),
          h('button', { class: 'link', text: '환경 편집', onclick: openEnvDialog })
        ),
        h('div', { class: 'empty' }, '왼쪽에서 요청을 고르거나 ', h('button', { text: '+ 새 요청', onclick: () => addRequest(homeFolder()) }), ' 을 만드세요. 브라우저 개발자 도구의 "Copy as cURL" 을 주소 칸에 붙여넣어도 됩니다.')
      );
      return;
    }
    const name = h('input', { class: 'name', type: 'text', value: r.name, title: '요청 이름', oninput: (e) => ((r.name = e.target.value), changed(r, true)) });
    const method = h('select', { title: '메서드', onchange: (e) => ((r.method = e.target.value), changed(r, true), renderReqBody(r)) }, (METHODS.includes(r.method) ? METHODS : METHODS.concat([r.method])).map((m) => h('option', { value: m, text: m })));
    method.value = r.method;
    const url = h('input', { class: 'url', type: 'text', value: r.url, placeholder: '{{baseUrl}}/api/…  (cURL 을 붙여넣어도 됩니다)', spellcheck: 'false' });
    url.addEventListener('input', () => {
      r.url = url.value;
      changed(r, true);
    });
    url.addEventListener('keydown', (e) => e.key === 'Enter' && doSend());
    url.addEventListener('paste', async (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (/^\s*curl(\.exe)?\s/i.test(text)) {
        // cURL 을 붙여넣으면 요청 전체를 그것으로 채운다
        e.preventDefault();
        const got = await ask('parseCurl', { text });
        if (!got.request) return toast('cURL 명령으로 읽을 수 없습니다.');
        const keep = { id: r.id, kind: 'request', name: r.name === '새 요청' ? got.request.name : r.name, note: r.note };
        Object.assign(r, got.request, keep);
        changed(r, true);
        renderMain();
        toast('cURL 에서 요청을 채웠습니다');
      } else if (text.includes('?') && !url.value) {
        // 주소에 붙은 ?a=1&b=2 는 파라미터 표로 옮긴다
        e.preventDefault();
        const q = text.trim().indexOf('?');
        const head = text.trim().slice(0, q);
        const tail = text.trim().slice(q + 1).split('#')[0];
        r.url = url.value = head;
        for (const p of tail.split('&').filter(Boolean)) {
          const i = p.indexOf('=');
          const dec = (x) => {
            try {
              return decodeURIComponent(x.replace(/\+/g, ' '));
            } catch (_) {
              return x;
            }
          };
          r.params.push({ key: dec(i < 0 ? p : p.slice(0, i)), value: i < 0 ? '' : dec(p.slice(i + 1)), enabled: true });
        }
        changed(r, true);
        renderReqBody(r);
      }
    });
    const more = h('button', {
      class: 'link',
      text: '⋯',
      title: 'cURL · 복제',
      'data-menu': '1',
      onclick: (e) =>
        menu(e.currentTarget, [
          ['cURL 로 복사', () => vscode.postMessage({ type: 'copyCurl', request: r, envId: S.activeEnvironment })],
          ['cURL 붙여넣기로 새 요청', curlDialog],
          '-',
          ['복제', () => addRequest(homeFolder(), Object.assign(clone(r), { name: r.name + ' 복사' }))],
        ]),
    });
    $main.replaceChildren(
      h(
        'div',
        { class: 'top' },
        h('button', { class: 'link', title: '목록 접기 · 펴기', text: '☰', onclick: toggleSide }),
        name,
        isDraft()
          ? h('button', {
              text: '모음에 저장',
              title: '기록에서 연 요청입니다. 모음에 넣어 두려면 저장하세요',
              onclick: () => {
                const d = S.draft;
                S.draft = undefined;
                firstCollection().items.push(d);
                S.selected = d.id;
                persist();
                renderSide();
                renderMain();
              },
            })
          : null,
        envSelect(),
        h('button', { class: 'link', text: '환경 편집', onclick: openEnvDialog })
      ),
      h('div', { class: 'reqline' }, method, url, h('button', { id: 'send', class: 'primary', text: '보내기', title: 'Ctrl+Enter', onclick: doSend }), more),
      h('div', { class: 'tabs', id: 'req-tabs' }),
      h('div', { class: 'req-body', id: 'req-body' }),
      h('div', { class: 'res', id: 'res' })
    );
    renderTabs(r);
    renderReqBody(r);
    renderSendButton();
    renderResponse();
    if (S.renaming !== r.id && !r.url) url.focus();
  }

  function toggleSide() {
    S.sideHidden = !S.sideHidden;
    persist();
    renderSide();
  }

  /* ---------------------------------------------------------------- 응답 */
  const fmtSize = (n) => (n < 1024 ? n + 'B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + 'KB' : (n / 1024 / 1024).toFixed(2) + 'MB');

  /** JSON 나무: 줄 하나씩, 접힌 것은 펼칠 때 그린다 */
  function jsonNode(key, value, depth, last) {
    const wrap = h('div', {});
    const line = h('div', { class: 'ln' });
    const comma = last ? '' : ',';
    const keyEl = key === undefined ? [] : [h('span', { class: 'key', text: JSON.stringify(key) }), ': '];
    if (value !== null && typeof value === 'object') {
      const isArr = Array.isArray(value);
      const keys = isArr ? value.map((_, i) => i) : Object.keys(value);
      const [open, close] = isArr ? ['[', ']'] : ['{', '}'];
      if (!keys.length) {
        line.append(...keyEl, open + close + comma);
        wrap.appendChild(line);
        return wrap;
      }
      let expanded = depth < 2;
      const kids = h('div', { class: 'kids' });
      const tail = h('div', { class: 'ln', text: close + comma });
      const tg = h('span', { class: 'tg' });
      const summary = h('span', { class: 'more' });
      let drawn = 0;
      const drawMore = () => {
        // 큰 배열은 100개씩
        const upto = Math.min(keys.length, drawn + 100);
        kids.querySelectorAll(':scope > .more').forEach((m) => m.remove());
        for (let i = drawn; i < upto; i++) kids.appendChild(jsonNode(isArr ? undefined : keys[i], value[keys[i]], depth + 1, i === keys.length - 1));
        drawn = upto;
        if (drawn < keys.length) kids.appendChild(h('div', { class: 'ln more', text: `… ${keys.length - drawn}개 더 보기`, onclick: drawMore }));
      };
      const apply = () => {
        tg.textContent = expanded ? '▾' : '▸';
        kids.style.display = tail.style.display = expanded ? '' : 'none';
        summary.textContent = expanded ? '' : ` ${isArr ? keys.length + '개' : '…'} ${close}${comma}`;
        if (expanded && !drawn) drawMore();
      };
      const toggle = () => {
        expanded = !expanded;
        apply();
      };
      tg.addEventListener('click', toggle);
      summary.addEventListener('click', toggle);
      line.append(tg, ...keyEl, open, summary);
      wrap.append(line, kids, tail);
      apply();
      return wrap;
    }
    const cls = typeof value === 'string' ? 'str' : typeof value === 'number' ? 'num' : 'lit';
    line.append(...keyEl, h('span', { class: cls, text: JSON.stringify(value) }), comma);
    wrap.appendChild(line);
    return wrap;
  }

  /** 글에서 찾는 말을 표시해 넣는다. 맞은 개수를 돌려준다 */
  function paintFind(pre, text, find, at) {
    pre.textContent = '';
    if (!find) {
      pre.textContent = text;
      return 0;
    }
    const lower = text.toLowerCase();
    const f = find.toLowerCase();
    let from = 0;
    let n = 0;
    let cur;
    for (let i = lower.indexOf(f); i >= 0 && n < 2000; i = lower.indexOf(f, i + f.length)) {
      pre.appendChild(document.createTextNode(text.slice(from, i)));
      const mark = h('mark', { text: text.slice(i, i + f.length) });
      if (n === at) {
        mark.className = 'cur';
        cur = mark;
      }
      pre.appendChild(mark);
      from = i + f.length;
      n++;
    }
    pre.appendChild(document.createTextNode(text.slice(from)));
    if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }));
    return n;
  }

  function renderResponse() {
    const el = document.getElementById('res');
    const r = current();
    if (!el || !r) return;
    const sending = S.sending && S.sending.id === r.id;
    const res = S.responses[r.id];
    const tabs = h('div', { class: 'tabs' });
    const body = h('div', { class: 'res-body' });
    el.replaceChildren(tabs, body);

    if (sending) {
      tabs.append(h('div', { class: 'tab on', text: '응답' }));
      body.append(h('div', {}, h('span', { class: 'spin' }), '보내는 중…'));
      return;
    }
    if (!res) {
      tabs.append(h('div', { class: 'tab on', text: r.example ? `저장해 둔 예시 (${r.example.status})` : '응답' }));
      if (r.example) {
        tabs.append(h('div', { class: 'right' }, h('span', { class: 'dim', text: new Date(r.example.savedAt).toLocaleString() }), h('button', { class: 'link', text: '예시 지우기', onclick: () => (delete r.example, changed(r), renderResponse()) })));
        body.append(h('pre', { class: 'raw', text: r.example.body }));
      } else body.append(h('div', { class: 'dim', text: '보내기(Ctrl+Enter)를 누르면 응답이 여기에 나옵니다.' }));
      return;
    }
    if (!res.ok) {
      tabs.append(h('div', { class: 'tab on', text: '응답' }));
      body.append(h('div', { class: res.cancelled ? 'dim' : 'err', text: res.error }));
      return;
    }

    const isJson = res.json !== undefined;
    const tab = (id, name, n) => h('div', { class: 'tab' + (S.resTab === id ? ' on' : ''), onclick: () => ((S.resTab = id), renderResponse()) }, name, n ? h('span', { class: 'n', text: String(n) }) : null);
    const right = h('div', { class: 'right' });
    const findInfo = h('span', { class: 'dim' });
    if (S.resTab === 'body' && res.text !== null) {
      const search = h('input', { class: 'res-search', type: 'text', placeholder: '응답에서 찾기', value: S.find });
      search.addEventListener('input', () => {
        S.find = search.value;
        S.findAt = 0;
        drawBody();
      });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && S.findCount) {
          S.findAt = (S.findAt + (e.shiftKey ? S.findCount - 1 : 1)) % S.findCount;
          drawBody();
        } else if (e.key === 'Escape') {
          search.value = S.find = '';
          drawBody();
        }
        e.stopPropagation();
      });
      right.append(search, findInfo);
      if (isJson) right.append(h('button', { class: 'link', text: S.jsonView === 'tree' ? '원문' : '접어 보기', onclick: () => ((S.jsonView = S.jsonView === 'tree' ? 'raw' : 'tree'), persist(), renderResponse()) }));
      right.append(
        h('button', { class: 'link', text: '복사', onclick: () => vscode.postMessage({ type: 'copy', text: res.pretty }) }),
        h('button', {
          class: 'link',
          text: '예시로 저장',
          title: '이 응답을 요청과 함께 남겨 둡니다 (다음에 열면 보임)',
          onclick: () => {
            r.example = { status: res.status, body: res.pretty.length > 200000 ? res.pretty.slice(0, 200000) + '\n… (잘림)' : res.pretty, savedAt: Date.now() };
            changed(r);
            toast(isDraft() ? '예시를 붙였습니다. "모음에 저장"을 눌러야 남습니다' : '예시로 저장했습니다');
          },
        })
      );
    }
    right.append(h('span', { class: 'status s' + String(res.status)[0], text: `${res.status} ${res.statusText}` }), h('span', { class: 'dim', text: `${res.ms}ms · ${fmtSize(res.size)}` }));
    tabs.append(tab('body', '응답'), tab('headers', '헤더', res.headers.length), tab('sent', '보낸 요청'), right);

    function drawBody() {
      body.replaceChildren();
      if (res.redirects.length) body.append(h('div', { class: 'dim', style: 'margin-bottom:6px', text: `리다이렉트 ${res.redirects.length}번 → ${res.url}` }));
      if (res.truncated) body.append(h('div', { class: 'err', style: 'margin-bottom:6px', text: `응답이 커서 앞부분 ${fmtSize(res.size)} 만 받았습니다 (설정 devBoost.apiConsole.maxResponseMb).` }));
      if (res.text === null) {
        body.append(h('div', {}, h('span', { class: 'dim', text: `글로 보여 줄 수 없는 응답입니다 (${res.contentType || '종류 없음'}, ${fmtSize(res.size)}). ` }), h('button', { text: '파일로 저장', onclick: () => vscode.postMessage({ type: 'saveBody' }) })));
        return;
      }
      if (!res.text.length) {
        body.append(h('div', { class: 'dim', text: '본문이 없는 응답입니다.' }));
        return;
      }
      if (isJson && S.jsonView === 'tree' && !S.find) {
        findInfo.textContent = '';
        body.append(h('div', { class: 'jt' }, jsonNode(undefined, res.json, 0, true)));
        return;
      }
      const pre = h('pre', { class: 'raw' });
      S.findCount = paintFind(pre, res.pretty, S.find, S.findAt);
      findInfo.textContent = S.find ? (S.findCount ? `${S.findAt + 1}/${S.findCount}` : '없음') : '';
      body.append(pre);
    }

    if (S.resTab === 'headers') {
      body.append(h('div', { class: 'hd' }, res.headers.flatMap(([k, v]) => [h('div', { class: 'hk', text: k }), h('div', { class: 'hv', text: v })])));
    } else if (S.resTab === 'sent') {
      body.append(
        h('div', { class: 'mono', style: 'margin-bottom:8px;word-break:break-all', text: `${res.sent.method} ${res.sent.url}` }),
        h('div', { class: 'hd' }, Object.entries(res.sent.headers).flatMap(([k, v]) => [h('div', { class: 'hk', text: k }), h('div', { class: 'hv', text: v })])),
        res.sent.body ? h('pre', { class: 'raw', style: 'margin-top:10px', text: res.sent.body }) : null
      );
    } else drawBody();
  }

  /* ---------------------------------------------------------------- 환경 편집 */
  function openEnvDialog() {
    S.envEditing = S.activeEnvironment && S.environments.some((e) => e.id === S.activeEnvironment) ? S.activeEnvironment : (S.environments[0] || {}).id;
    drawEnvDialog();
  }

  function drawEnvDialog() {
    document.querySelectorAll('.overlay.env').forEach((o) => o.remove());
    const close = () => {
      ov.remove();
      renderMain();
    };
    const env = S.environments.find((e) => e.id === S.envEditing);
    const list = h(
      'div',
      { class: 'envs' },
      S.environments.map((e) => h('div', { class: 'node' + (e.id === S.envEditing ? ' on' : ''), style: 'padding-left:10px', onclick: () => ((S.envEditing = e.id), drawEnvDialog()) }, h('span', { class: 'nm', text: e.name + (e.confirm ? ' ⚠' : '') }))),
      h(
        'div',
        { style: 'padding:8px 10px' },
        h('button', {
          text: '+ 환경',
          onclick: () => {
            const e = { id: newId(), name: S.environments.length ? '새 환경' : '로컬', variables: S.environments.length ? [] : [{ key: 'baseUrl', value: 'http://localhost:8080', enabled: true }] };
            S.environments.push(e);
            S.envEditing = e.id;
            if (!S.activeEnvironment) S.activeEnvironment = e.id;
            persist();
            drawEnvDialog();
          },
        })
      )
    );
    const edit = h('div', { class: 'env-edit' });
    if (env) {
      edit.append(
        h(
          'div',
          { class: 'row' },
          h('input', { type: 'text', value: env.name, style: 'flex:1;font-weight:600', oninput: (e) => ((env.name = e.target.value), persist()), onblur: drawEnvDialog }),
          h(
            'button',
            {
              text: '복제',
              onclick: () => {
                const c = Object.assign(clone(env), { id: newId(), name: env.name + ' 복사' });
                S.environments.push(c);
                S.envEditing = c.id;
                persist();
                drawEnvDialog();
              },
            }
          ),
          h('button', {
            text: '삭제',
            onclick: () => {
              S.environments = S.environments.filter((e) => e !== env);
              if (S.activeEnvironment === env.id) S.activeEnvironment = undefined;
              S.envEditing = (S.environments[0] || {}).id;
              persist();
              drawEnvDialog();
            },
          })
        ),
        h('div', { class: 'row' }, h('label', {}, h('input', { type: 'checkbox', checked: !!env.confirm, onchange: (e) => ((env.confirm = e.target.checked || undefined), persist(), drawEnvDialog()) }), ' 보내기 전에 확인 (운영처럼 되돌릴 수 없는 곳)')),
        kvTable(env.variables, { onChange: persist, keyHint: '변수 이름 (예: baseUrl)' }),
        h('div', { class: 'hint', text: '주소 · 헤더 · 본문 어디서든 {{변수이름}} 으로 씁니다. 변수 값은 이 컴퓨터에만 저장되고, 내보내기 파일에는 이름만 들어갑니다.' })
      );
    } else edit.append(h('div', { class: 'empty', text: '환경은 변수 묶음입니다. 로컬 · 개발 · 운영처럼 만들어 두고 바꿔 가며 씁니다. 왼쪽의 + 환경 으로 시작하세요.' }));
    const ov = h('div', { class: 'overlay env', onclick: (e) => e.target === ov && close() }, h('div', { class: 'dialog' }, h('div', { class: 'dialog-head' }, h('span', { text: '환경' }), h('button', { class: 'link', text: '✕', onclick: close })), h('div', { class: 'dialog-body' }, list, edit)));
    document.body.appendChild(ov);
  }

  /* ---------------------------------------------------------------- 키 · 확장에서 온 것 */
  document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doSend();
    } else if (e.key === 'Escape') {
      closeMenu();
      const ov = document.querySelector('.overlay');
      if (ov) {
        ov.remove();
        renderMain();
      }
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.token && pending[m.token]) {
      const done = pending[m.token];
      delete pending[m.token];
      done(m);
      return;
    }
    if (m.type === 'init') {
      S.version = m.version;
      S.collections = m.data.collections;
      S.environments = m.data.environments;
      S.activeEnvironment = m.data.activeEnvironment;
      S.history = m.data.history;
      S.cookies = m.cookies;
      S.tab = saved.tab || 'params';
      S.sideHidden = !!saved.sideHidden;
      S.histOpen = saved.histOpen !== false;
      S.jsonView = saved.jsonView || 'tree';
      if (saved.selected && findNode(S.collections, saved.selected)) S.selected = saved.selected;
      else S.selected = (firstRequest(S.collections) || {}).id;
      renderSide();
      renderMain();
    } else if (m.type === 'response') {
      if (!S.sending || S.sending.key !== m.key) return;
      const id = S.sending.id;
      S.sending = undefined;
      if (m.ok && m.text !== null) {
        m.pretty = m.text;
        if (/json/i.test(m.contentType) || /^\s*[[{]/.test(m.text)) {
          try {
            m.json = JSON.parse(m.text);
            m.pretty = JSON.stringify(m.json, null, 2);
          } catch (_) {
            // JSON 이 아니면 글 그대로
          }
        }
      }
      if (m.ok) S.cookies = m.cookies;
      S.responses[id] = m;
      S.resTab = 'body';
      S.find = '';
      renderSendButton();
      if (id === S.selected) renderResponse();
    } else if (m.type === 'history') {
      S.history = m.history;
      renderSide();
    } else if (m.type === 'imported') {
      S.collections.push(...m.collections);
      S.environments.push(...m.environments);
      if (!S.activeEnvironment && m.environments.length) S.activeEnvironment = m.environments[0].id;
      persist();
      renderSide();
      renderMain();
      const n = countRequests(m.collections);
      toast(`가져왔습니다: 요청 ${n}개${m.environments.length ? `, 환경 ${m.environments.length}개` : ''}`);
    } else if (m.type === 'cookies') {
      S.cookies = m.cookies;
      renderSide();
    } else if (m.type === 'toast') {
      toast(m.text);
    }
  });

  function firstRequest(nodes) {
    for (const n of nodes) {
      if (n.kind === 'request') return n;
      const r = firstRequest(n.items);
      if (r) return r;
    }
    return undefined;
  }
  function countRequests(nodes) {
    return nodes.reduce((a, n) => a + (n.kind === 'request' ? 1 : countRequests(n.items)), 0);
  }

  vscode.postMessage({ type: 'ready' });
})();
