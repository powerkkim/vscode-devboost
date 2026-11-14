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
    /** 왼쪽 목록: 'col' 모음, 'cap' 브라우저 캡처 */
    mode: 'col',
    capture: { running: false, rows: [] },
    capSel: undefined,
    /** 고른 호출의 상세 (확장에서 받아 온 것) */
    capDetail: undefined,
    capFilter: '',
    capTab: 'res',
    /** 고른 호출과 주소가 맞는 모음의 요청 { id, vars } */
    capMatch: undefined,
    /** 요청 id → Controller 에서 새로 읽은 요청 (예전에 넣은 것과 달라졌을 때) */
    refill: {},
    /** 브라우저에서 이어받은 인증 */
    follow: { on: true, hosts: [] },
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
  /** 안의 것을 바꿔 넣는다. 없는 것(null · false)은 뺀다 — replaceChildren 은 null 을 "null" 글자로 넣는다 */
  function put(el, ...kids) {
    el.replaceChildren(...kids.flat().filter((k) => k !== undefined && k !== null && k !== false));
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
    vscode.setState({ selected: S.selected, tab: S.tab, sideHidden: S.sideHidden, histOpen: S.histOpen, jsonView: S.jsonView, mode: S.mode });
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
          : !it[1]
          ? h('div', { class: 'info', text: it[0] })
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

  /** 주소의 {id} 자리 이름들 ({{변수}} 는 아니다) */
  function pathNames(url) {
    const out = [];
    for (const m of String(url || '').split(/[?#]/)[0].matchAll(/(?<!\{)\{([A-Za-z_][\w.-]*)(?::[^{}]*)?\}(?!\})/g)) if (!out.includes(m[1])) out.push(m[1]);
    return out;
  }
  /** 주소에 맞춰 경로 값 표를 맞춘다. 표가 바뀌었으면 true */
  function syncPathVars(r) {
    const names = pathNames(r.url);
    const before = (r.pathVars || []).map((v) => v.key).join('\n');
    if (!names.length) {
      delete r.pathVars;
      return before !== '';
    }
    r.pathVars = names.map((n) => (r.pathVars || []).find((v) => v.key === n) || { key: n, value: '', enabled: true });
    return before !== names.join('\n');
  }

  /** 지금 환경 (없으면 "로컬"을 만들어 고른다) */
  function ensureEnv() {
    let env = S.environments.find((e) => e.id === S.activeEnvironment);
    if (!env) {
      env = S.environments[0];
      if (!env) {
        env = { id: newId(), name: '로컬', variables: [] };
        S.environments.push(env);
      }
      S.activeEnvironment = env.id;
    }
    return env;
  }
  function setVar(env, key, value) {
    const row = env.variables.find((v) => v.key.trim() === key);
    if (row) {
      row.value = value;
      row.enabled = true;
    } else env.variables.push({ key, value, enabled: true });
  }
  /** 값을 환경 변수로 저장 (이름을 물어본다) */
  async function saveAsVar(suggest, value) {
    const got = await ask('input', { title: '환경 변수로 저장', prompt: '변수 이름 — 주소 · 헤더 · 본문에서 {{이름}} 으로 씁니다', value: suggest });
    const key = (got.value || '').trim();
    if (!key) return;
    const env = ensureEnv();
    setVar(env, key, value);
    persist();
    renderMain();
    toast(`환경 "${env.name}" 에 {{${key}}} 를 저장했습니다`);
  }
  /** 이 요청의 응답이 올 때마다 그 자리의 값을 변수로 저장하게 한다 (지금 값도 바로 넣는다) */
  async function addExtract(r, suggest, path, value) {
    const got = await ask('input', { title: '응답이 올 때마다 변수로 저장', prompt: `변수 이름 — 이 요청의 응답에서 ${path} 를 꺼내 넣습니다`, value: suggest });
    const key = (got.value || '').trim();
    if (!key) return;
    if (!r.extract) r.extract = [];
    const row = r.extract.find((x) => x.key.trim() === key);
    if (row) Object.assign(row, { value: path, enabled: true });
    else r.extract.push({ key, value: path, enabled: true });
    const env = ensureEnv();
    setVar(env, key, value);
    changed(r);
    persist();
    renderMain();
    toast(`{{${key}}} — 이 요청의 응답이 올 때마다 저장합니다`);
  }

  /** 예전 값은 살리고 모양은 새 것으로: 객체는 새 뼈대의 키, 값은 예전에 적어 둔 것 */
  function mergeJson(fresh, old) {
    if (Array.isArray(fresh)) return Array.isArray(old) && old.length ? old.map((x) => mergeJson(fresh[0], x)) : fresh;
    if (fresh && typeof fresh === 'object') {
      if (!old || typeof old !== 'object' || Array.isArray(old)) return fresh;
      const out = {};
      for (const k of Object.keys(fresh)) out[k] = k in old ? mergeJson(fresh[k], old[k]) : fresh[k];
      return out;
    }
    if (old === undefined || (old !== null && typeof old === 'object')) return fresh;
    return old;
  }
  const mergeRows = (fresh, old) => fresh.map((f) => old.find((o) => o.key === f.key) || f).concat(old.filter((o) => o.key.trim() && !fresh.some((f) => f.key === o.key)));
  function shapeOf(v) {
    if (Array.isArray(v)) return [v.length ? shapeOf(v[0]) : null];
    if (v && typeof v === 'object') return Object.keys(v).sort().map((k) => [k, shapeOf(v[k])]);
    return 0;
  }
  /** Controller 에서 읽은 모양 (값은 빼고): 달라졌는지 볼 때 쓴다 */
  function signature(r) {
    let body = r.bodyMode;
    if (r.bodyMode === 'json') {
      try {
        body = shapeOf(JSON.parse(r.bodyText));
      } catch (_) {
        body = 'json?';
      }
    } else if (r.bodyMode === 'form' || r.bodyMode === 'multipart') body = r.bodyForm.map((x) => x.key + (x.file ? '@' : '')).sort();
    const keys = (rows) => (rows || []).map((x) => x.key).filter(Boolean).sort();
    return JSON.stringify([r.method, r.url, keys(r.params), keys(r.headers), r.bodyMode, body]);
  }
  /** fresh 에 있는 것이 old 에 다 있는가 (직접 보탠 파라미터 · 헤더는 다른 것으로 치지 않는다) */
  function sameAsController(old, fresh) {
    const o = JSON.parse(signature(old));
    const f = JSON.parse(signature(fresh));
    const has = (a, b) => b.every((k) => a.includes(k));
    return o[0] === f[0] && o[1] === f[1] && has(o[2], f[2]) && has(o[3], f[3]) && o[4] === f[4] && JSON.stringify(o[5]) === JSON.stringify(f[5]);
  }
  function applyRefill(r) {
    const fresh = S.refill[r.id];
    if (!fresh) return;
    delete S.refill[r.id];
    r.method = fresh.method;
    r.url = fresh.url;
    r.params = mergeRows(fresh.params, r.params);
    r.headers = mergeRows(fresh.headers, r.headers);
    const oldPath = r.pathVars || [];
    r.pathVars = (fresh.pathVars || []).map((f) => oldPath.find((o) => o.key === f.key && o.value) || f);
    syncPathVars(r);
    if (fresh.bodyMode === 'json') {
      let merged = fresh.bodyText;
      try {
        merged = JSON.stringify(mergeJson(JSON.parse(fresh.bodyText), r.bodyMode === 'json' ? JSON.parse(r.bodyText) : undefined), null, 2);
      } catch (_) {
        // 예전 본문이 JSON 이 아니면 새 뼈대로
      }
      r.bodyText = merged;
    } else if (fresh.bodyMode === 'form' || fresh.bodyMode === 'multipart') r.bodyForm = mergeRows(fresh.bodyForm, r.bodyForm);
    r.bodyMode = fresh.bodyMode;
    r.note = fresh.note;
    changed(r, true);
    renderMain();
    toast('Controller 에 맞춰 다시 채웠습니다 (적어 둔 값은 그대로)');
  }

  /** 캡처한 호출의 값(경로 · 파라미터 · 본문)을 모음의 요청에 채워서 연다 */
  function fillFromCapture(c, match) {
    const hit = findNode(S.collections, match.id);
    if (!hit) return toast('모음에서 사라진 요청입니다.');
    const r = hit.node;
    syncPathVars(r);
    for (const v of r.pathVars || []) if (v.key in match.vars) v.value = match.vars[v.key];
    const q = c.url.split('#')[0].split('?')[1] || '';
    const dec = (x) => {
      try {
        return decodeURIComponent(x.replace(/\+/g, ' '));
      } catch (_) {
        return x;
      }
    };
    const seen = [];
    for (const p of q.split('&').filter(Boolean)) {
      const i = p.indexOf('=');
      const key = dec(i < 0 ? p : p.slice(0, i));
      const value = i < 0 ? '' : dec(p.slice(i + 1));
      seen.push(key);
      const row = r.params.find((x) => x.key === key);
      if (row) Object.assign(row, { value, enabled: true });
      else r.params.push({ key, value, enabled: true });
    }
    // 브라우저가 보내지 않은 선택 파라미터는 꺼 둔다
    if (q) for (const row of r.params) if (!seen.includes(row.key)) row.enabled = false;
    if (c.reqBody && r.method !== 'GET') {
      try {
        r.bodyText = JSON.stringify(JSON.parse(c.reqBody), null, 2);
        r.bodyMode = 'json';
      } catch (_) {
        // JSON 이 아닌 본문은 요청의 것을 그대로 둔다
      }
    }
    S.mode = 'col';
    S.draft = undefined;
    S.selected = r.id;
    reveal(r.id);
    persist();
    renderSide();
    renderMain();
    toast(`브라우저가 보낸 값으로 채웠습니다: ${r.name}`);
  }

  const fmtAgo = (at) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 60 ? '방금' : s < 3600 ? Math.round(s / 60) + '분 전' : s < 86400 ? Math.round(s / 3600) + '시간 전' : Math.round(s / 86400) + '일 전';
  };

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

  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode;
    persist();
    renderSide();
    renderMain();
  }
  function modeTabs() {
    const n = S.capture.rows.length;
    return h(
      'div',
      { class: 'mode-tabs' },
      h('div', { class: 'tab' + (S.mode === 'col' ? ' on' : ''), text: '모음', onclick: () => setMode('col') }),
      h('div', { class: 'tab' + (S.mode === 'cap' ? ' on' : ''), title: '브라우저의 서버 호출을 받아 보고 요청으로 옮깁니다', onclick: () => setMode('cap') }, S.capture.running ? h('span', { class: 'rec' }) : null, '브라우저 캡처', n ? h('span', { class: 'n', text: String(n) }) : null)
    );
  }

  function renderSide() {
    $side.className = 'side' + (S.sideHidden ? ' hidden' : '');
    if (S.mode === 'cap') return renderCaptureSide();
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
    put($side, 
      h(
        'div',
        { class: 'side-head' },
        h('span', { class: 'brand', text: 'DevBoost', title: 'DevBoost 의 API 콘솔' }),
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
      modeTabs(),
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

  /* ---------------------------------------------------------------- 브라우저 캡처 */
  const shortUrl = (u) => u.replace(/^[a-z]+:\/\/[^/]+/i, '') || u;

  function captureHead() {
    return h(
      'div',
      { class: 'side-head' },
      h('span', { class: 'brand', text: 'DevBoost', title: 'DevBoost 의 API 콘솔' }),
        h('span', { class: 'title', text: 'API 콘솔' }),
      h('span', { class: 'ver', text: S.version ? 'v' + S.version : '' }),
      h('button', {
        class: 'link',
        title: '시작 주소 · HAR · 비우기',
        text: '⋯',
        'data-menu': '1',
        onclick: (e) =>
          menu(e.currentTarget, [
            ['HAR 가져오기 (개발자 도구에서 저장한 파일)', () => vscode.postMessage({ type: 'importHar' })],
            ['시작 주소 바꾸기', () => vscode.postMessage({ type: 'captureStart', askUrl: true })],
            '-',
            [`목록 비우기 (${S.capture.rows.length})`, () => vscode.postMessage({ type: 'captureClear' })],
          ]),
      })
    );
  }

  function renderCaptureSide() {
    const focused = document.activeElement && document.activeElement.id === 'cap-filter';
    const q = S.capFilter.trim().toLowerCase();
    const rows = S.capture.rows.filter((x) => !q || (x.method + ' ' + x.url + ' ' + (x.status || '')).toLowerCase().includes(q));
    const list = h(
      'div',
      { class: 'tree' },
      rows.length
        ? rows.map((x) =>
            h(
              'div',
              { class: 'node cap' + (x.id === S.capSel ? ' on' : ''), style: 'padding-left:8px', title: `${new Date(x.at).toLocaleTimeString()}\n${x.url}`, onclick: () => selectCapture(x.id) },
              h('span', { class: 'mt ' + x.method, text: x.method === 'DELETE' ? 'DEL' : x.method.slice(0, 5) }),
              h('span', { class: 'nm', text: shortUrl(x.url) }),
              x.failed ? h('span', { class: 'st err', text: '실패' }) : x.status ? h('span', { class: 'st status s' + String(x.status)[0], text: String(x.status) }) : h('span', { class: 'st dim', text: '…' })
            )
          )
        : h(
            'div',
            { class: 'empty' },
            S.capture.rows.length
              ? '맞는 호출이 없습니다.'
              : S.capture.running
              ? '열린 브라우저에서 화면을 쓰면 서버 호출(XHR · fetch)이 여기에 쌓입니다.'
              : '캡처를 시작하면 전용 브라우저가 열립니다. 거기서 평소처럼 로그인하고 화면을 쓰면 서버 호출이 여기에 쌓이고, 토큰과 쿠키는 자동으로 이어받아 내 요청에도 붙습니다.'
          )
    );
    put($side, 
      captureHead(),
      modeTabs(),
      h(
        'div',
        { class: 'cap-bar' },
        S.capture.running
          ? h('button', { text: '■ 캡처 끝내기', title: '캡처를 끝내고 브라우저를 닫습니다', onclick: () => vscode.postMessage({ type: 'captureStop' }) })
          : h('button', { class: 'primary', text: '● 캡처 시작', title: '전용 브라우저를 열고 서버 호출을 받습니다', onclick: () => vscode.postMessage({ type: 'captureStart' }) }),
        h('button', { text: 'HAR', title: '브라우저 개발자 도구의 네트워크 탭에서 저장한 HAR 파일을 불러옵니다', onclick: () => vscode.postMessage({ type: 'importHar' }) })
      ),
      h('div', { class: 'side-search' }, h('input', { id: 'cap-filter', type: 'text', placeholder: '주소 · 메서드 · 상태로 찾기', value: S.capFilter, oninput: (e) => ((S.capFilter = e.target.value), renderCaptureSide()) })),
      list
    );
    if (focused) {
      const f = document.getElementById('cap-filter');
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    }
  }

  async function selectCapture(id) {
    S.capSel = id;
    S.find = '';
    renderCaptureSide();
    await loadCaptureDetail();
  }
  async function loadCaptureDetail() {
    const id = S.capSel;
    if (!id) return;
    const got = await ask('captureDetail', { id });
    if (S.capSel !== id) return;
    S.capDetail = got.entry || undefined;
    S.capMatch = undefined;
    if (S.mode === 'cap') renderMain();
    if (!S.capDetail) return;
    const m = await ask('matchCapture', { id, requests: allRequests(S.collections, []).map((r) => ({ id: r.id, method: r.method, url: r.url })) });
    if (S.capSel !== id || !m.match) return;
    S.capMatch = m.match;
    if (S.mode === 'cap') renderMain();
  }

  /** 캡처한 응답 본문을 글로 (base64 면 풀어서) */
  function capturedBody(c) {
    if (c.resBody === undefined) return undefined;
    if (!c.resBase64) return c.resBody;
    if (!/json|text|xml|javascript|html/i.test(c.mime || '')) return null;
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(c.resBody), (ch) => ch.charCodeAt(0)));
    } catch (_) {
      return null;
    }
  }
  const varNameOf = (header) => (/^authorization$/i.test(header) ? 'token' : header.replace(/^x-/i, '').replace(/[-_]+(.)/g, (_, ch) => ch.toUpperCase()).replace(/^(.)/, (ch) => ch.toLowerCase()));

  /** 헤더 표: 줄마다 값 복사 · 변수로 저장 */
  function headerGrid(headers) {
    return h(
      'div',
      { class: 'hd act' },
      headers.flatMap(([k, v]) => [
        h('div', { class: 'hk', text: k }),
        h(
          'div',
          { class: 'hv' },
          v,
          h('button', {
            class: 'link',
            text: '⋯',
            title: '복사 · 변수로 저장',
            'data-menu': '1',
            onclick: (e) =>
              menu(e.currentTarget, [
                ['값 복사', () => vscode.postMessage({ type: 'copy', text: v })],
                ['환경 변수로 저장…', () => saveAsVar(varNameOf(k), /^authorization$/i.test(k) ? v.replace(/^Bearer\s+/i, '') : v)],
              ]),
          })
        ),
      ])
    );
  }

  async function captureAsRequest(save) {
    const c = S.capDetail;
    if (!c) return;
    const got = await ask('captureToRequest', { id: c.id, envId: S.activeEnvironment });
    if (!got.request) return toast('목록에서 사라진 호출입니다.');
    const r = Object.assign(got.request, { kind: 'request' });
    // 브라우저가 받은 응답은 예시로 붙여 둔다
    const body = capturedBody(c);
    if (c.status && typeof body === 'string' && body.length) {
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch (_) {
        // JSON 이 아니면 그대로
      }
      r.example = { status: c.status, body: pretty.length > 200000 ? pretty.slice(0, 200000) + '\n… (잘림)' : pretty, savedAt: c.at };
    }
    syncPathVars(r);
    S.mode = 'col';
    if (save) {
      addRequest(homeFolder(), r);
      toast('모음에 넣었습니다');
    } else {
      S.draft = r;
      S.selected = r.id;
      persist();
      renderSide();
      renderMain();
    }
  }

  function renderCaptureMain() {
    const top = h('div', { class: 'top' }, h('button', { class: 'link', title: '목록 접기 · 펴기', text: '☰', onclick: toggleSide }), h('span', { class: 'grow' }), followChip(), envSelect(), h('button', { class: 'link', text: '환경 편집', onclick: openEnvDialog }));
    const c = S.capDetail && S.capDetail.id === S.capSel ? S.capDetail : undefined;
    if (!c) {
      put($main, 
        top,
        h(
          'div',
          { class: 'empty' },
          h('div', { text: '브라우저에서 일어난 서버 호출을 그대로 받아 봅니다 (개발자 도구의 네트워크 탭과 같은 내용).' }),
          h('div', { text: '1. 왼쪽의 "캡처 시작" → 전용 브라우저가 열립니다. 평소처럼 로그인하고 화면을 씁니다.' }),
          h('div', { text: '2. 호출이 왼쪽에 쌓입니다. 고르면 요청 · 응답 · 헤더가 보이고, "요청으로 열기"로 바로 다시 보낼 수 있습니다.' }),
          h('div', { text: '3. 토큰 · 쿠키는 자동으로 이어받습니다. 모음의 요청을 보낼 때도 같은 로그인 상태로 나갑니다.' }),
          h('div', { class: 'dim', style: 'margin-top:8px', text: '브라우저를 띄울 수 없는 환경이면 개발자 도구에서 저장한 HAR 파일을 "HAR"로 불러오세요.' })
        )
      );
      return;
    }
    const body = capturedBody(c);
    let json;
    let pretty = typeof body === 'string' ? body : '';
    if (typeof body === 'string' && (/json/i.test(c.mime || '') || /^\s*[[{]/.test(body))) {
      try {
        json = JSON.parse(body);
        pretty = JSON.stringify(json, null, 2);
      } catch (_) {
        // JSON 이 아니면 글 그대로
      }
    }
    const tab = (id, name, n) => h('div', { class: 'tab' + (S.capTab === id ? ' on' : ''), onclick: () => ((S.capTab = id), renderMain()) }, name, n ? h('span', { class: 'n', text: String(n) }) : null);
    const right = h('div', { class: 'right' });
    if (S.capTab === 'res' && json !== undefined) right.append(h('button', { class: 'link', text: S.jsonView === 'tree' ? '원문' : '접어 보기', onclick: () => ((S.jsonView = S.jsonView === 'tree' ? 'raw' : 'tree'), persist(), renderMain()) }));
    if (S.capTab === 'res' && pretty) right.append(h('button', { class: 'link', text: '복사', onclick: () => vscode.postMessage({ type: 'copy', text: pretty }) }));
    if (c.failed) right.append(h('span', { class: 'err', text: c.failed }));
    else if (c.status) right.append(h('span', { class: 'status s' + String(c.status)[0], text: `${c.status} ${c.statusText || ''}` }));
    else right.append(h('span', { class: 'dim', text: '응답을 기다리는 중…' }));
    if (c.ms !== undefined) right.append(h('span', { class: 'dim', text: `${c.ms}ms${c.size ? ' · ' + fmtSize(c.size) : ''}` }));
    const pane = h('div', { class: 'res-body' });
    if (S.capTab === 'res') {
      if (c.resSkipped) pane.append(h('div', { class: 'dim', text: `응답이 커서 본문은 받지 않았습니다 (${fmtSize(c.size || 0)}, 설정 devBoost.apiConsole.maxResponseMb).` }));
      else if (body === undefined) pane.append(h('div', { class: 'dim', text: c.done ? '본문이 없거나 받지 못한 응답입니다.' : '응답을 기다리는 중…' }));
      else if (body === null) pane.append(h('div', { class: 'dim', text: `글로 보여 줄 수 없는 응답입니다 (${c.mime || '종류 없음'}).` }));
      else if (!body.length) pane.append(h('div', { class: 'dim', text: '본문이 없는 응답입니다.' }));
      else if (json !== undefined && S.jsonView === 'tree') pane.append(h('div', { class: 'jt' }, jsonNode(undefined, json, 0, true)));
      else pane.append(h('pre', { class: 'raw', text: pretty }));
    } else if (S.capTab === 'resHeaders') pane.append(headerGrid(c.resHeaders || []));
    else if (S.capTab === 'reqHeaders') pane.append(headerGrid(c.reqHeaders));
    else {
      let text = c.reqBody || '';
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch (_) {
        // JSON 이 아니면 그대로
      }
      pane.append(text ? h('pre', { class: 'raw', text }) : h('div', { class: 'dim', text: '본문 없이 보낸 요청입니다.' }));
    }
    put($main, 
      top,
      h(
        'div',
        { class: 'reqline cap' },
        h('span', { class: 'mt ' + c.method, text: c.method }),
        h('span', { class: 'url mono', text: c.url, title: c.url }),
        (() => {
          const hit = S.capMatch && findNode(S.collections, S.capMatch.id);
          return hit ? h('button', { class: 'primary', text: `내 요청에 채우기: ${hit.node.name}`, title: '모음에 있는 같은 주소의 요청에 이 호출의 경로 값 · 파라미터 · 본문을 채워서 엽니다', onclick: () => fillFromCapture(c, S.capMatch) }) : null;
        })(),
        h('button', { class: S.capMatch && findNode(S.collections, S.capMatch.id) ? '' : 'primary', text: '요청으로 열기', title: '이 호출과 같은 요청을 만들어 바로 고치고 다시 보냅니다', onclick: () => captureAsRequest(false) }),
        h('button', { text: '모음에 넣기', title: '이 호출을 모음에 요청으로 저장합니다', onclick: () => captureAsRequest(true) })
      ),
      h('div', { class: 'tabs' }, tab('res', '응답'), tab('resHeaders', '응답 헤더', (c.resHeaders || []).length), tab('reqHeaders', '요청 헤더', c.reqHeaders.length), tab('reqBody', '요청 본문', c.reqBody ? '●' : 0), right),
      pane
    );
  }

  /** 브라우저에서 이어받은 인증 표시 (누르면 내용 · 켜고 끄기) */
  function followChip() {
    const has = S.follow.hosts.length > 0;
    const label = !S.follow.on ? '인증 이어받기 꺼짐' : has ? '인증 이어받는 중' : '인증 이어받기';
    return h(
      'button',
      {
        class: 'chip' + (S.follow.on && has ? ' on' : ''),
        title: '브라우저 캡처에서 본 토큰 · 쿠키를 내 요청에도 붙입니다',
        'data-menu': '1',
        onclick: (e) => {
          const items = [];
          if (has) for (const f of S.follow.hosts) items.push([`${f.host}: ${f.headers.concat(f.cookies ? ['쿠키 ' + f.cookies + '개'] : []).join(', ')} (${fmtAgo(f.at)})`]);
          else items.push(['아직 이어받은 인증이 없습니다. "브라우저 캡처"에서 로그인해 보세요.']);
          items.push('-', [S.follow.on ? '이어받기 끄기' : '이어받기 켜기', () => vscode.postMessage({ type: 'setFollow', on: !S.follow.on })]);
          if (has) items.push(['이어받은 인증 지우기', () => vscode.postMessage({ type: 'clearFollow' })]);
          if (!S.capture.running) items.push('-', ['브라우저 캡처 시작', () => (setMode('cap'), vscode.postMessage({ type: 'captureStart' }))]);
          menu(e.currentTarget, items);
        },
      },
      h('span', { class: 'key', text: '🔑' }),
      label
    );
  }

  /* ---------------------------------------------------------------- Controller 에서 온 요청 */
  function allRequests(nodes, out) {
    for (const n of nodes) {
      if (n.kind === 'request') out.push(n);
      else allRequests(n.items, out);
    }
    return out;
  }
  function findFolderNamed(nodes, name) {
    for (const n of nodes) {
      if (n.kind !== 'folder') continue;
      if (n.name === name) return n;
      const hit = findFolderNamed(n.items, name);
      if (hit) return hit;
    }
    return undefined;
  }
  /** 고른 것이 보이게 바깥 폴더들을 편다 */
  function reveal(id, nodes) {
    for (const n of nodes || S.collections) {
      if (n.id === id) return true;
      if (n.kind === 'folder' && reveal(id, n.items)) {
        n.collapsed = false;
        return true;
      }
    }
    return false;
  }
  function addEndpoints(m) {
    if (!m.requests.length) return;
    const env = ensureEnv();
    let madeBase = false;
    if (!env.variables.some((v) => v.enabled && v.key.trim() === 'baseUrl')) {
      env.variables.unshift({ key: 'baseUrl', value: m.baseUrl, enabled: true });
      madeBase = true;
    }
    const existing = allRequests(S.collections, []);
    let added = 0;
    let first;
    for (const r of m.requests) {
      let hit = existing.find((x) => x.origin && x.origin === r.origin);
      if (hit) {
        // 예전에 넣은 뒤로 Controller 가 바뀌었으면 다시 채울 수 있게 알린다
        if (sameAsController(hit, r)) delete S.refill[hit.id];
        else S.refill[hit.id] = r;
      }
      if (!hit) {
        let folder = findFolderNamed(S.collections, m.folder);
        if (!folder) {
          folder = { kind: 'folder', id: newId(), name: m.folder, items: [] };
          firstCollection().items.push(folder);
        }
        hit = Object.assign(r, { kind: 'request' });
        folder.items.push(hit);
        added++;
      }
      first = first || hit;
    }
    S.mode = 'col';
    S.draft = undefined;
    S.filter = '';
    S.renaming = undefined;
    S.selected = first.id;
    reveal(first.id);
    persist();
    renderSide();
    renderMain();
    const on = document.querySelector('.tree .node.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    const base = madeBase ? ` · 환경 "${env.name}" 에 baseUrl = ${m.baseUrl}` : '';
    if (m.requests.length === 1) toast((added ? `"${m.folder}" 폴더에 넣었습니다` : '모음에 있는 요청을 열었습니다') + base + (m.warning ? ` · ${m.warning} (메모 탭 참고)` : ''));
    else toast(`${added}개를 넣었습니다` + (added < m.requests.length ? ` (${m.requests.length - added}개는 이미 있음)` : '') + base);
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
      put(table);
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
    if (id === 'params') return ['파라미터', count(r.params) + (r.pathVars || []).length];
    if (id === 'headers') return ['헤더', count(r.headers)];
    if (id === 'body') return ['Body', r.bodyMode === 'none' ? 0 : BODY_MODES.find((m) => m[0] === r.bodyMode)[1]];
    if (id === 'auth') return ['인증', r.auth.type === 'none' ? 0 : r.auth.type === 'bearer' ? 'Bearer' : 'Basic'];
    if (id === 'extract') return ['변수 저장', count(r.extract || [])];
    return ['메모', r.note.trim() ? '●' : 0];
  }

  function renderTabs(r) {
    const el = document.getElementById('req-tabs');
    if (!el) return;
    put(el, 
      ...['params', 'headers', 'body', 'auth', 'extract', 'note'].map((id) => {
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
      syncPathVars(r);
      const kids = [];
      if (r.pathVars) {
        kids.push(
          h('div', { class: 'sub', text: '경로 값' }),
          h(
            'table',
            { class: 'kv path' },
            r.pathVars.map((v) => h('tr', {}, h('td', { class: 'c' }), h('td', { class: 'k' }, h('span', { class: 'mono', text: `{${v.key}}` })), h('td', {}, h('input', { type: 'text', value: v.value, placeholder: '주소의 이 자리에 들어갈 값', oninput: (e) => ((v.value = e.target.value), changed(r)) })), h('td', { class: 'x' })))
          ),
          h('div', { class: 'sub', text: '파라미터' })
        );
      }
      kids.push(kvTable(r.params, { onChange }), h('div', { class: 'hint', text: '주소 뒤에 ?이름=값 으로 붙습니다. 주소 칸에 ?… 를 붙여넣으면 이 표로 옮겨집니다. 주소에 {id} 처럼 적으면 경로 값 칸이 생깁니다.' }));
      put(el, ...kids);
    } else if (S.tab === 'headers') {
      put(el, kvTable(r.headers, { onChange, keyHint: '헤더 이름' }), h('div', { class: 'hint', text: 'Content-Type 과 Authorization 은 Body · 인증 탭에서 정한 대로 붙습니다. 여기에 직접 적으면 그 값이 우선입니다.' }));
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
      put(el, modes, editor);
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
      put(el, types, form, h('div', { class: 'hint', text: `로그인 응답이 내려 준 쿠키(세션)는 닫을 때까지 자동으로 이어 보냅니다. 지금 ${S.cookies}개. 토큰은 환경 변수에 넣고 {{token}} 으로 쓰면 환경마다 바꿀 수 있습니다.` }));
    } else if (S.tab === 'extract') {
      if (!r.extract) r.extract = [];
      put(el, 
        kvTable(r.extract, { onChange, keyHint: '변수 이름 (예: token)', valueHint: '응답에서의 위치 (예: data.accessToken)' }),
        h('div', { class: 'hint', text: '응답이 올 때마다 그 값을 환경 변수에 넣습니다. 다른 요청에서 {{변수이름}} 으로 이어 씁니다 (등록 응답의 id 로 조회, 로그인 응답의 토큰 등).' }),
        h('div', { class: 'hint', text: '위치: data.items[0].id 처럼 점과 [번호]. 응답 헤더는 @header.이름. 응답의 값을 눌러 "응답이 올 때마다 변수로 저장"을 고르면 여기에 들어옵니다.' })
      );
    } else {
      const ta = h('textarea', { class: 'note', placeholder: '이 API 가 무엇인지, 필수 값, 주의할 점 등을 적어 둡니다.', oninput: (e) => ((r.note = e.target.value), changed(r)) });
      ta.value = r.note;
      put(el, ta);
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
    if (S.mode === 'cap') return renderCaptureMain();
    const r = current();
    if (!r) {
      put($main, 
        h(
          'div',
          { class: 'top' },
          h('button', { class: 'link', title: '목록 접기 · 펴기', text: '☰', onclick: toggleSide }),
          h('span', { class: 'grow' }),
          followChip(),
          envSelect(),
          h('button', { class: 'link', text: '환경 편집', onclick: openEnvDialog })
        ),
        h(
          'div',
          { class: 'empty' },
          h('div', {}, '왼쪽에서 요청을 고르거나 ', h('button', { text: '+ 새 요청', onclick: () => addRequest(homeFolder()) }), ' 을 만드세요.'),
          h('div', { text: '· Controller 파일의 매핑 메서드 위에 있는 "API 콘솔"을 누르면 그 요청이 채워져 들어옵니다.' }),
          h('div', { text: '· "브라우저 캡처"에서 화면이 실제로 보낸 호출을 받아 요청으로 옮길 수 있습니다.' }),
          h('div', { text: '· 브라우저 개발자 도구의 "Copy as cURL" 을 주소 칸에 붙여넣어도 됩니다.' })
        )
      );
      return;
    }
    const name = h('input', { class: 'name', type: 'text', value: r.name, title: '요청 이름', oninput: (e) => ((r.name = e.target.value), changed(r, true)) });
    const method = h('select', { title: '메서드', onchange: (e) => ((r.method = e.target.value), changed(r, true), renderReqBody(r)) }, (METHODS.includes(r.method) ? METHODS : METHODS.concat([r.method])).map((m) => h('option', { value: m, text: m })));
    method.value = r.method;
    const url = h('input', { class: 'url', type: 'text', value: r.url, placeholder: '{{baseUrl}}/api/…  (cURL 을 붙여넣어도 됩니다)', spellcheck: 'false' });
    url.addEventListener('input', () => {
      r.url = url.value;
      // 주소에 {id} 자리가 생기거나 없어지면 경로 값 표를 맞춘다
      const pathChanged = syncPathVars(r);
      changed(r, true);
      if (pathChanged && S.tab === 'params') renderReqBody(r);
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
    put($main, 
      h(
        'div',
        { class: 'top' },
        h('button', { class: 'link', title: '목록 접기 · 펴기', text: '☰', onclick: toggleSide }),
        name,
        isDraft()
          ? h('button', {
              text: '모음에 저장',
              title: '모음에 없는 요청입니다 (기록 · 캡처에서 연 것). 모음에 넣어 두려면 저장하세요',
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
        followChip(),
        envSelect(),
        h('button', { class: 'link', text: '환경 편집', onclick: openEnvDialog })
      ),
      S.refill[r.id]
        ? h(
            'div',
            { class: 'tip bar' },
            'Controller 가 이 요청을 넣은 뒤로 바뀌었습니다 (주소 · 파라미터 · 본문). ',
            h('button', { class: 'link', text: '다시 채우기', title: '새 모양으로 맞춥니다. 적어 둔 값은 그대로 둡니다', onclick: () => applyRefill(r) }),
            h('button', { class: 'link', text: '그대로 두기', onclick: () => (delete S.refill[r.id], renderMain()) })
          )
        : null,
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
  function jsonNode(key, value, depth, last, path, owner) {
    path = path || '';
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
        for (let i = drawn; i < upto; i++) kids.appendChild(jsonNode(isArr ? undefined : keys[i], value[keys[i]], depth + 1, i === keys.length - 1, path + (isArr ? `[${i}]` : /^[A-Za-z_$][\w$-]*$/.test(keys[i]) ? (path ? '.' : '') + keys[i] : `[${JSON.stringify(keys[i])}]`), owner));
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
    const plain = typeof value === 'string' ? value : String(value);
    line.append(
      ...keyEl,
      h('span', {
        class: cls + ' val',
        text: JSON.stringify(value),
        title: '누르면 복사 · 환경 변수로 저장',
        'data-menu': '1',
        onclick: (e) =>
          menu(
            e.currentTarget,
            [
              ['값 복사', () => vscode.postMessage({ type: 'copy', text: plain })],
              ['환경 변수로 저장…', () => saveAsVar(typeof key === 'string' ? key : 'value', plain)],
            ].concat(owner && path ? [['응답이 올 때마다 변수로 저장…', () => addExtract(owner, typeof key === 'string' ? key : 'value', path, plain)]] : [])
          ),
      }),
      comma
    );
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
    put(el, tabs, body);

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
      put(body);
      if (res.redirects.length) body.append(h('div', { class: 'dim', style: 'margin-bottom:6px', text: `리다이렉트 ${res.redirects.length}번 → ${res.url}` }));
      if ((res.status === 401 || res.status === 403) && !(res.followed || []).length && !S.capture.running)
        body.append(
          h(
            'div',
            { class: 'tip' },
            `${res.status} — 로그인이 필요한 API 로 보입니다. `,
            h('button', { class: 'link', text: '브라우저 캡처', onclick: () => (setMode('cap'), vscode.postMessage({ type: 'captureStart' })) }),
            '에서 로그인하면 그 토큰 · 쿠키를 이어받아 보냅니다.'
          )
        );
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
        body.append(h('div', { class: 'jt' }, jsonNode(undefined, res.json, 0, true, '', r)));
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
        (res.followed || []).length ? h('div', { class: 'dim', style: 'margin-bottom:8px', text: `브라우저에서 이어받아 붙인 헤더: ${res.followed.join(', ')}` }) : null,
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
      S.mode = saved.mode === 'cap' ? 'cap' : 'col';
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
      if (m.ok && m.extracted && m.extracted.length) {
        const got = m.extracted.filter((x) => x.value !== undefined);
        const miss = m.extracted.filter((x) => x.value === undefined);
        if (got.length) {
          const env = ensureEnv();
          for (const x of got) setVar(env, x.key, x.value);
          persist();
        }
        toast((got.length ? `변수 저장: ${got.map((x) => `{{${x.key}}}`).join(', ')}` : '') + (miss.length ? `${got.length ? ' · ' : ''}응답에 없는 값: ${miss.map((x) => x.key).join(', ')}` : ''));
      }
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
    } else if (m.type === 'follow') {
      S.follow = { on: m.on, hosts: m.hosts };
      renderMain();
    } else if (m.type === 'capture') {
      S.capture = { running: m.running, rows: m.rows };
      if (S.capSel && !m.rows.some((x) => x.id === S.capSel)) S.capSel = S.capDetail = undefined;
      renderSide();
      if (S.mode === 'cap') renderMain();
    } else if (m.type === 'captureRows') {
      for (const row of m.rows) {
        const i = S.capture.rows.findIndex((x) => x.id === row.id);
        if (i >= 0) S.capture.rows[i] = row;
        else S.capture.rows.unshift(row);
      }
      if (S.capture.rows.length > 300) S.capture.rows.length = 300;
      renderSide();
      if (S.mode === 'cap' && m.rows.some((x) => x.id === S.capSel)) loadCaptureDetail();
    } else if (m.type === 'addEndpoints') {
      addEndpoints(m);
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
