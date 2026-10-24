// IntelliJ 스타일 Search Everywhere 화면 (Webview 안에서 실행되는 순수 JS)
// 확장(Node)과는 postMessage로만 통신한다: search / open / close / toggleNonProject
(function () {
  const vscode = acquireVsCodeApi();

  const TABS = [
    { id: 'all', label: '모두' },
    { id: 'classes', label: '클래스' },
    { id: 'files', label: '파일' },
    { id: 'symbols', label: '심볼' },
    { id: 'actions', label: '액션' },
    { id: 'text', label: '텍스트' },
  ];
  const KIND_LABEL = { classes: '클래스', files: '파일', symbols: '심볼', actions: '액션', text: '텍스트' };
  const KIND_BADGE = { classes: 'C', files: 'F', symbols: 'm', actions: '⚡', text: 'T' };
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
  };

  const $tabs = document.getElementById('tabs');
  const $query = document.getElementById('query');
  const $results = document.getElementById('results');
  const $footer = document.getElementById('footer');
  const $nonProject = document.getElementById('nonProject');

  let tab = 'all';
  let rows = [];
  let selected = 0;
  let runId = 0;
  let shownRunId = 0;
  let debounce;

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
    search(true);
  }

  function moveTab(delta) {
    const i = TABS.findIndex((t) => t.id === tab);
    setTab(TABS[(i + delta + TABS.length) % TABS.length].id);
  }

  // ───────── 검색 ─────────
  function search(immediate) {
    clearTimeout(debounce);
    const run = () => {
      runId++;
      $results.classList.add('busy');
      vscode.postMessage({ type: 'search', runId, tab, query: $query.value });
    };
    immediate ? run() : (debounce = setTimeout(run, 120));
  }

  // ───────── 결과 그리기 ─────────
  function renderResults(query) {
    $results.innerHTML = '';
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = $query.value ? '일치하는 항목이 없습니다' : '검색어를 입력하세요';
      $results.appendChild(empty);
      $footer.textContent = '';
      return;
    }

    let lastKind;
    rows.forEach((r, i) => {
      // '모두' 탭에서는 종류가 바뀔 때 구분 머리글
      if (tab === 'all' && r.kind !== lastKind) {
        const h = document.createElement('div');
        h.className = 'group';
        h.textContent = KIND_LABEL[r.kind] || r.kind;
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
    if (rows.length === 0) return;
    selected = Math.max(0, Math.min(rows.length - 1, i));
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
    const r = rows[selected];
    $footer.textContent = r ? r.footer || '' : '';
  }

  function open(i) {
    if (!rows[i]) return;
    vscode.postMessage({ type: 'open', runId: shownRunId, index: i });
  }

  function pageSize() {
    const row = $results.querySelector('.row');
    return row ? Math.max(1, Math.floor($results.clientHeight / row.offsetHeight) - 1) : 10;
  }

  // ───────── 키보드 ─────────
  $query.addEventListener('input', () => search(false));

  document.addEventListener('keydown', (e) => {
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
        if (e.altKey && (e.key === 'n' || e.key === 'N' || e.code === 'KeyN')) {
          e.preventDefault();
          $nonProject.checked = !$nonProject.checked;
          onNonProjectChange();
        }
    }
  });

  function onNonProjectChange() {
    vscode.postMessage({ type: 'toggleNonProject', value: $nonProject.checked });
    search(true);
  }
  $nonProject.addEventListener('change', onNonProjectChange);
  $nonProject.addEventListener('mouseup', () => setTimeout(() => $query.focus(), 0));

  // 패널이 다시 포커스를 받으면 입력창으로
  window.addEventListener('focus', () => $query.focus());

  // ───────── 확장에서 오는 메시지 ─────────
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'init') {
      tab = m.tab || 'all';
      $nonProject.checked = !!m.includeNonProject;
      if (m.query) $query.value = m.query;
      renderTabs();
      $query.focus();
      $query.select();
      search(true);
    } else if (m.type === 'results') {
      if (m.runId !== runId) return; // 오래된 결과 무시
      shownRunId = m.runId;
      $results.classList.remove('busy');
      rows = m.rows || [];
      selected = 0;
      renderResults(m.query);
      $results.scrollTop = 0;
    }
  });

  renderTabs();
  vscode.postMessage({ type: 'ready' });
})();
