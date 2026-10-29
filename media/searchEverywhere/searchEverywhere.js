// IntelliJ 스타일 Search Everywhere 화면 (Webview 안에서 실행되는 순수 JS)
// 확장(Node)과는 postMessage로만 통신한다: search / open / close / toggleNonProject
(function () {
  const vscode = acquireVsCodeApi();

  const TABS = [
    { id: 'all', label: '모두' },
    { id: 'classes', label: '클래스' },
    { id: 'files', label: '파일' },
    { id: 'symbols', label: '심볼' },
    { id: 'mappers', label: 'Mapper' },
    { id: 'spring', label: 'Spring' },
    { id: 'actions', label: '액션' },
    { id: 'text', label: '텍스트' },
  ];
  const KIND_LABEL = { classes: '클래스', files: '파일', symbols: '심볼', mappers: 'Mapper', spring: 'Spring', actions: '액션', text: '텍스트' };
  const KIND_BADGE = { classes: 'C', files: 'F', symbols: 'm', mappers: 'M', spring: 'S', actions: '⚡', text: 'T' };
  // 심볼 종류별 배지 (IntelliJ: C=클래스, I=인터페이스, E=enum, m=메서드, f=필드, v=변수)
  const ICON_BADGE = {
    'symbol-class': ['C', 'class'],
    'symbol-interface': ['I', 'class'],
    'symbol-enum': ['E', 'class'],
    'symbol-method': ['m', 'method'],
    'symbol-field': ['f', 'field'],
    'symbol-variable': ['v', 'field'],
    terminal: ['>', 'action'],
    gear: ['⚙', 'action'],
    keyboard: ['⌨', 'action'],
    'file-code': ['X', 'class'],
    database: ['q', 'method'],
    link: ['@', 'action'],
  };

  const $tabs = document.getElementById('tabs');
  const $query = document.getElementById('query');
  const $results = document.getElementById('results');
  const $footer = document.getElementById('footer');
  const $scope = document.getElementById('scope');
  const $fileMask = document.getElementById('fileMask');
  const $fileMaskList = document.getElementById('fileMaskList');
  const $optCase = document.getElementById('optCase');
  const $optWord = document.getElementById('optWord');
  const $optRegex = document.getElementById('optRegex');
  const $controls = document.getElementById('controls');
  const $optFilter = document.getElementById('optFilter');
  const $filterbar = document.getElementById('filterbar');
  const $incl = document.getElementById('incl');
  const $excl = document.getElementById('excl');
  const $inclList = document.getElementById('inclList');
  const $useCurDir = document.getElementById('useCurDir');
  const $clearPaths = document.getElementById('clearPaths');
  const $timing = document.getElementById('timing');

  let tab = 'all';
  let rows = []; // 확장이 보낸 결과 (open 할 때 이 번호를 보낸다)
  let groups = []; // 종류별 개수 [{kind, shown, total, capped}]
  let view = []; // 화면에 그린 줄: { idx } = 결과 줄, { more: kind, ... } = "더 보기" 줄
  let selected = 0; // view 의 번호
  let limit; // "더 보기"로 늘린 표시 개수 (검색어·탭·옵션이 바뀌면 초기화)
  let maxResults = 50;
  let pendingSelect; // "더 보기" 후 고를 결과 번호
  let pendingKeep; // 다시 검색(rerun) 뒤에도 고를 줄
  let runId = 0;
  let shownRunId = 0;
  let shownSeq; // 지금 화면에 그린 결과 묶음 번호 (열 때 같이 보냄)
  let debounce;
  // 범위·텍스트 옵션 (확장에서 init으로 받고, 바꾸면 search 메시지에 실어 보낸다)
  let options = {
    scope: 'project',
    text: { fileMask: '', caseSensitive: false, wholeWord: false, regex: false },
    paths: { include: '', exclude: '' },
  };
  let filterOpen = false;
  // 속도 측정: 검색 요청을 보낸 시각(runId별), 창 여는 데 걸린 시간
  const sentAt = {};
  let showTiming = false;
  let openMs;

  // ───────── 탭 ─────────
  function renderTabs() {
    $tabs.innerHTML = '';
    for (const t of TABS) {
      const b = document.createElement('button');
      b.className = 'tab' + (t.id === tab ? ' active' : '');
      b.textContent = t.label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === tab));
      b.tabIndex = -1;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 입력창 포커스 유지
        setTab(t.id);
      });
      $tabs.appendChild(b);
    }
  }

  function setTab(id) {
    if (tab === id) return;
    tab = id;
    renderTabs();
    updateControls();
    search(true);
  }

  /** 탭에 따라 오른쪽 컨트롤 표시: 액션=없음, 텍스트=범위+파일타입+Cc/W/.*, 나머지=범위만 */
  function updateControls() {
    $controls.classList.toggle('hidden', tab === 'actions');
    $controls.classList.toggle('text-mode', tab === 'text');
    $filterbar.classList.toggle('hidden', !filterOpen || tab === 'actions');
  }

  function readOptions() {
    options = {
      scope: $scope.value,
      text: {
        fileMask: $fileMask.value.trim(),
        caseSensitive: $optCase.classList.contains('on'),
        wholeWord: $optWord.classList.contains('on'),
        regex: $optRegex.classList.contains('on'),
      },
      paths: { include: $incl.value.trim(), exclude: $excl.value.trim() },
    };
    updateFilterBadge();
    return options;
  }

  function renderOptions() {
    $scope.value = options.scope;
    $fileMask.value = options.text.fileMask || '';
    $optCase.classList.toggle('on', !!options.text.caseSensitive);
    $optWord.classList.toggle('on', !!options.text.wholeWord);
    $optRegex.classList.toggle('on', !!options.text.regex);
    const p = options.paths || { include: '', exclude: '' };
    $incl.value = p.include || '';
    $excl.value = p.exclude || '';
    // 필터 값이 남아 있으면 줄을 펼쳐서 걸려 있다는 걸 보이게 한다
    if (p.include || p.exclude) setFilterOpen(true);
    updateFilterBadge();
  }

  // ───────── 포함/제외 경로 ─────────
  function setFilterOpen(open) {
    filterOpen = open;
    $filterbar.classList.toggle('hidden', !open);
    $optFilter.classList.toggle('on', open);
  }

  /** 필터 값이 있으면 버튼에 점 표시 (줄을 접어 둬도 걸려 있다는 걸 알 수 있게) */
  function updateFilterBadge() {
    const active = !!($incl.value.trim() || $excl.value.trim());
    $optFilter.classList.toggle('active', active);
    $optFilter.title = active
      ? `포함: ${$incl.value.trim() || '(전체)'}\n제외: ${$excl.value.trim() || '(없음)'}\n(Alt+P)`
      : '포함/제외 경로 (Alt+P)';
  }

  let pathDebounce;
  for (const el of [$incl, $excl]) {
    el.addEventListener('input', () => {
      updateFilterBadge();
      clearTimeout(pathDebounce);
      pathDebounce = setTimeout(() => search(true), 250);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(pathDebounce);
        search(true);
        $query.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        $query.focus();
      } else if (e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        setFilterOpen(false);
        $query.focus();
      }
      e.stopPropagation(); // 경로 입력 중에는 ↑↓/Tab 같은 전역 키를 쓰지 않음
    });
  }
  $optFilter.addEventListener('mousedown', (e) => e.preventDefault());
  $optFilter.addEventListener('click', () => {
    setFilterOpen(!filterOpen);
    (filterOpen ? $incl : $query).focus();
  });
  $useCurDir.addEventListener('mousedown', (e) => e.preventDefault());
  $useCurDir.addEventListener('click', () => vscode.postMessage({ type: 'currentFolder' }));
  $clearPaths.addEventListener('mousedown', (e) => e.preventDefault());
  $clearPaths.addEventListener('click', () => {
    $incl.value = '';
    $excl.value = '';
    updateFilterBadge();
    search(true);
    $query.focus();
  });

  function optionsChanged() {
    readOptions();
    search(true);
    $query.focus();
  }

  function moveTab(delta) {
    const i = TABS.findIndex((t) => t.id === tab);
    setTab(TABS[(i + delta + TABS.length) % TABS.length].id);
  }

  // ───────── 검색 ─────────
  function search(immediate, keepLimit) {
    clearTimeout(debounce);
    if (!keepLimit) {
      limit = undefined;
      pendingSelect = undefined; // "더 보기" 결과를 기다리던 중 다른 검색을 시작하면 버린다
      pendingKeep = undefined;
    }
    const run = () => {
      runId++;
      sentAt[runId] = performance.now();
      $results.classList.add('busy');
      vscode.postMessage({ type: 'search', runId, tab, query: $query.value, options: readOptions(), limit });
    };
    immediate ? run() : (debounce = setTimeout(run, 120));
  }

  // ───────── 결과 그리기 ─────────
  const fmt = (n) => n.toLocaleString('ko-KR');
  function countText(g) {
    return g.capped ? `${fmt(g.total)}건 이상` : `${fmt(g.total)}개`;
  }

  /** 결과 줄 사이에 "더 보기" 줄을 끼워 화면 목록(view)을 만든다 */
  function buildView() {
    view = [];
    const byKind = new Map(groups.map((g) => [g.kind, g]));
    const moreRow = (g) => {
      if (!g) return;
      if (tab === 'all') {
        // 모두 탭: 그 종류의 탭으로 이동
        if (g.total > g.shown || g.capped) view.push({ more: g.kind, text: `${KIND_LABEL[g.kind] || g.kind} 더 보기 — ${countText(g)} 중 ${fmt(g.shown)}개 표시 (Enter: ${KIND_LABEL[g.kind] || g.kind} 탭)` });
      } else if (g.total > g.shown) {
        view.push({ more: g.kind, text: `더 보기 — ${countText(g)} 중 ${fmt(g.shown)}개 표시 (Enter: ${fmt(Math.min(maxResults, g.total - g.shown))}개 더)` });
      } else if (g.capped) {
        view.push({ note: true, text: `결과가 ${countText(g)}이라 일부만 모았습니다. 포함 경로·파일 타입으로 좁혀 보세요` });
      }
    };
    rows.forEach((r, i) => {
      view.push({ idx: i });
      const next = rows[i + 1];
      if (!next || next.kind !== r.kind) moreRow(byKind.get(r.kind));
    });
  }

  function renderResults(query) {
    $results.innerHTML = '';
    buildView();
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = $query.value ? '일치하는 항목이 없습니다' : '검색어를 입력하세요';
      $results.appendChild(empty);
      $footer.textContent = '';
      return;
    }

    let lastKind;
    const byKind = new Map(groups.map((g) => [g.kind, g]));
    view.forEach((v, i) => {
      if (v.more || v.note) {
        const row = document.createElement('div');
        row.className = 'row more' + (v.note ? ' note' : '') + (i === selected ? ' selected' : '');
        row.dataset.index = String(i);
        row.textContent = v.text;
        if (v.more) {
          row.addEventListener('mousemove', () => select(i, false));
          row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            select(i, false);
          });
          row.addEventListener('click', () => open(i));
        }
        $results.appendChild(row);
        return;
      }
      const r = rows[v.idx];
      // '모두' 탭에서는 종류가 바뀔 때 구분 머리글 (보인 개수 / 전체 개수)
      if (tab === 'all' && r.kind !== lastKind) {
        const h = document.createElement('div');
        h.className = 'group';
        const g = byKind.get(r.kind);
        h.textContent = (KIND_LABEL[r.kind] || r.kind) + (g && (g.total > g.shown || g.capped) ? `  ${fmt(g.shown)} / ${countText(g)}` : '');
        $results.appendChild(h);
        lastKind = r.kind;
      }

      const row = document.createElement('div');
      row.className = 'row' + (i === selected ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.dataset.index = String(i);

      const badge = document.createElement('span');
      const byIcon = ICON_BADGE[r.icon];
      badge.className = 'badge ' + (byIcon ? 'icon-' + byIcon[1] : 'kind-' + r.kind);
      badge.textContent = byIcon ? byIcon[0] : KIND_BADGE[r.kind] || '?';
      row.appendChild(badge);

      const main = document.createElement('span');
      main.className = 'main';
      const label = document.createElement('span');
      label.className = 'label';
      appendHighlighted(label, r.label, query);
      main.appendChild(label);
      if (r.secondary) {
        const sec = document.createElement('span');
        sec.className = 'secondary';
        sec.textContent = r.secondary;
        main.appendChild(sec);
      }
      row.appendChild(main);

      if (r.right) {
        const right = document.createElement('span');
        right.className = 'right';
        right.textContent = r.right;
        row.appendChild(right);
      }

      row.addEventListener('mousemove', () => select(i, false));
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select(i, false);
      });
      row.addEventListener('click', () => open(i));
      $results.appendChild(row);
    });
    updateFooter();
  }

  /** 검색어와 일치하는 부분을 <mark>로 감싼다. 연속 일치가 없으면 글자 단위(퍼지)로 표시 */
  function appendHighlighted(el, text, query) {
    const q = (query || '').trim();
    if (!q) {
      el.textContent = text;
      return;
    }
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    const idx = lower.indexOf(ql);
    const marks = new Array(text.length).fill(false);
    if (idx >= 0) {
      for (let k = idx; k < idx + ql.length; k++) marks[k] = true;
    } else {
      // 퍼지: 검색어 글자가 순서대로 전부 있을 때만 표시 (일부만 맞으면 표시 안 함)
      const found = [];
      let ti = 0;
      for (const ch of ql) {
        const f = lower.indexOf(ch, ti);
        if (f < 0) {
          found.length = 0;
          break;
        }
        found.push(f);
        ti = f + 1;
      }
      found.forEach((f) => (marks[f] = true));
    }
    let buf = '';
    let cur = false;
    const flush = () => {
      if (!buf) return;
      if (cur) {
        const m = document.createElement('mark');
        m.textContent = buf;
        el.appendChild(m);
      } else {
        el.appendChild(document.createTextNode(buf));
      }
      buf = '';
    };
    for (let k = 0; k < text.length; k++) {
      if (marks[k] !== cur) {
        flush();
        cur = marks[k];
      }
      buf += text[k];
    }
    flush();
  }

  function select(i, scroll = true) {
    if (view.length === 0) return;
    const dir = i >= selected ? 1 : -1;
    selected = Math.max(0, Math.min(view.length - 1, i));
    // 안내 줄(note)은 건너뛴다
    while (view[selected] && view[selected].note) {
      const n = selected + dir;
      if (n < 0 || n >= view.length) {
        selected -= dir;
        break;
      }
      selected = n;
    }
    $results.querySelectorAll('.row').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.index) === selected);
    });
    if (scroll) {
      const el = $results.querySelector('.row.selected');
      el && el.scrollIntoView({ block: 'nearest' });
    }
    updateFooter();
  }

  function updateFooter() {
    const v = view[selected];
    const r = v && v.idx !== undefined ? rows[v.idx] : undefined;
    $footer.textContent = r ? r.footer || '' : '';
  }

  function open(i) {
    const v = view[i];
    if (!v) return;
    if (v.more) {
      if (tab === 'all') {
        setTab(v.more); // 그 종류의 탭에서 전체를 본다
      } else {
        const g = groups.find((x) => x.kind === v.more);
        limit = (g ? g.shown : rows.length) + maxResults;
        pendingSelect = g ? g.shown : rows.length; // 더 불러온 첫 줄로 이동
        search(true, true);
      }
      return;
    }
    if (v.note || !rows[v.idx]) return;
    vscode.postMessage({ type: 'open', runId: shownRunId, seq: shownSeq, index: v.idx });
  }

  function pageSize() {
    const row = $results.querySelector('.row');
    return row ? Math.max(1, Math.floor($results.clientHeight / row.offsetHeight) - 1) : 10;
  }

  // ───────── 키보드 ─────────
  $query.addEventListener('input', () => search(false));

  document.addEventListener('keydown', (e) => {
    // 범위 드롭다운에 포커스가 있으면 ↑↓/Enter는 드롭다운이 쓰고, Esc/Tab만 처리
    if (e.target === $scope && !['Escape', 'Tab'].includes(e.key) && !e.altKey) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        select(selected + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        select(selected - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        select(selected + pageSize());
        break;
      case 'PageUp':
        e.preventDefault();
        select(selected - pageSize());
        break;
      case 'Enter':
        e.preventDefault();
        open(selected);
        break;
      case 'Escape':
        e.preventDefault();
        vscode.postMessage({ type: 'close' });
        break;
      case 'Tab':
        e.preventDefault(); // IntelliJ처럼 Tab / Shift+Tab 으로 탭 이동
        moveTab(e.shiftKey ? -1 : 1);
        break;
      default:
        if (!e.altKey) break;
        if (e.code === 'KeyP' && tab !== 'actions') {
          e.preventDefault();
          setFilterOpen(!filterOpen);
          (filterOpen ? $incl : $query).focus();
        } else if (e.code === 'KeyN') {
          e.preventDefault();
          $scope.value = $scope.value === 'projectAndLibs' ? 'production' : 'projectAndLibs';
          optionsChanged();
        } else if (tab === 'text' && e.code === 'KeyC') {
          e.preventDefault();
          $optCase.classList.toggle('on');
          optionsChanged();
        } else if (tab === 'text' && e.code === 'KeyW') {
          e.preventDefault();
          $optWord.classList.toggle('on');
          optionsChanged();
        } else if (tab === 'text' && e.code === 'KeyX') {
          e.preventDefault();
          $optRegex.classList.toggle('on');
          optionsChanged();
        }
    }
  });

  $scope.addEventListener('change', optionsChanged);
  $fileMask.addEventListener('change', optionsChanged);
  $fileMask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      optionsChanged();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      $query.focus();
    }
    e.stopPropagation(); // 파일타입 입력 중에는 전역 키(↑↓/Tab) 동작 안 함
  });
  for (const b of [$optCase, $optWord, $optRegex]) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      b.classList.toggle('on');
      optionsChanged();
    });
  }

  // 패널이 다시 포커스를 받으면 입력창으로
  window.addEventListener('focus', () => $query.focus());

  // ───────── 확장에서 오는 메시지 ─────────
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'init') {
      showTiming = !!m.timing;
      openMs = m.openMs;
      if (m.maxResults) maxResults = m.maxResults;
      if (m.scopes) {
        $scope.innerHTML = '';
        for (const sc of m.scopes) {
          const o = document.createElement('option');
          o.value = sc.id;
          o.textContent = sc.label;
          $scope.appendChild(o);
        }
      }
      if (m.fileMasks) {
        $fileMaskList.innerHTML = '';
        for (const fm of m.fileMasks) {
          const o = document.createElement('option');
          o.value = fm;
          $fileMaskList.appendChild(o);
        }
      }
      if (m.recentIncludes) {
        $inclList.innerHTML = '';
        for (const v of m.recentIncludes) {
          const o = document.createElement('option');
          o.value = v;
          $inclList.appendChild(o);
        }
      }
      if (m.options) {
        options = m.options;
      } else if (m.includeNonProject) {
        options.scope = 'projectAndLibs';
      }
      renderOptions();
      updateControls();
      $timing.textContent = showTiming && openMs !== undefined ? `창 열기 ${openMs}ms` : '';
      tab = m.tab || 'all';
      if (m.query) $query.value = m.query;
      renderTabs();
      $query.focus();
      $query.select();
      search(true);
    } else if (m.type === 'currentFolder') {
      if (m.path) {
        $incl.value = m.path;
        setFilterOpen(true);
        updateFilterBadge();
        search(true);
      }
      $query.focus();
    } else if (m.type === 'rerun') {
      // 확장이 같은 검색을 다시 하라고 함 (메서드·필드 색인 완성, 숨겼다 다시 보임). 보던 줄·"더 보기" 개수는 유지
      if ($query.value) {
        pendingKeep = rows[(view[selected] || {}).idx];
        search(true, true);
      }
    } else if (m.type === 'focus') {
      // 패널이 다시 보일 때: 검색창으로 커서, 기존 검색어는 전체 선택해서 바로 덮어쓸 수 있게
      $query.focus();
      $query.select();
    } else if (m.type === 'results') {
      if (m.runId !== runId) return; // 오래된 결과 무시
      // 같은 검색의 먼저 온 결과(partial)를 보고 있었으면 고른 줄과 스크롤을 유지한다
      const sameRun = shownRunId === m.runId;
      const pv = sameRun ? view[selected] : undefined;
      const prev = pv && pv.idx !== undefined ? rows[pv.idx] : undefined;
      const scroll = sameRun || pendingSelect !== undefined ? $results.scrollTop : 0;
      shownRunId = m.runId;
      shownSeq = m.seq;
      // 결과가 나왔으면 흐리게 두지 않는다
      $results.classList.remove('busy');
      rows = m.rows || [];
      groups = m.groups || [];
      selected = 0;
      renderResults(m.query); // view 를 새로 만든다
      let want = -1;
      if (pendingKeep && !prev) {
        // 다시 검색(rerun) 전에 보던 줄을 찾아 그대로 고른다
        const k = pendingKeep;
        pendingKeep = undefined;
        const i = rows.findIndex((r) => r.label === k.label && r.right === k.right && r.kind === k.kind);
        if (i >= 0) want = i;
      }
      if (want < 0 && pendingSelect !== undefined) {
        // "더 보기": 새로 불러온 첫 줄로 (먼저 온 partial 에도, 최종 결과에도 같은 자리)
        want = Math.min(pendingSelect, rows.length - 1);
        if (!m.partial) pendingSelect = undefined;
      } else if (prev) {
        const i = rows.findIndex((r) => r.label === prev.label && r.right === prev.right && r.kind === prev.kind);
        if (i >= 0) want = i;
      }
      if (want >= 0) {
        const vi = view.findIndex((v) => v.idx === want);
        if (vi >= 0) select(vi, false);
      }
      $results.scrollTop = scroll;
      if (want >= 0) {
        const el = $results.querySelector('.row.selected');
        el && el.scrollIntoView({ block: 'nearest' });
      }
      renderTiming(m);
    }
  });

  /**
   * 하단 오른쪽에 속도 표시. 예) 클래스 2ms · 파일 3ms · 텍스트 85ms | 전체 512ms
   * 전체 = 검색 요청을 보낸 순간부터 화면에 그릴 때까지 (확장 처리 + 메시지 왕복 + 그리기)
   */
  let lastIndex = '';
  function renderTiming(m) {
    if (!showTiming) {
      $timing.textContent = '';
      return;
    }
    const total = sentAt[m.runId] !== undefined ? Math.round(performance.now() - sentAt[m.runId]) : undefined;
    delete sentAt[m.runId];
    const parts = (m.timings || []).map((t) => {
      const note = t.note === 'ripgrep' ? '(rg)' : t.note === '캐시' ? '(캐시)' : '';
      return `${t.part} ${t.ms}ms${note}`;
    });
    let text = parts.join(' · ');
    if (total !== undefined) text += `${text ? ' | ' : ''}전체 ${total}ms`;
    if (openMs !== undefined) text = `창 열기 ${openMs}ms | ` + text;
    // 색인 크기 (항목 수 · 대략의 메모리)
    if (m.index) {
      lastIndex = m.index;
    }
    if (lastIndex) text += ` | ${lastIndex}`;
    $timing.textContent = text;
    // 기준: 0.1초 이하 초록, 0.3초 이하 기본, 그 이상 주황
    $timing.className = 'footer-timing' + (total === undefined ? '' : total <= 100 ? ' fast' : total <= 300 ? '' : ' slow');
    $timing.title = (m.timings || [])
      .map((t) => `${t.part}: ${t.ms}ms, ${t.count}건${t.note ? ' (' + t.note + ')' : ''}`)
      .join('\n');
  }

  renderTabs();
  vscode.postMessage({ type: 'ready' });
})();
