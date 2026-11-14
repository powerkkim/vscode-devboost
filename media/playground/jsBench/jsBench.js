// JavaScript 작업대 화면. 확장(panel.ts)과 메시지로 주고받는다.
// 쓰던 코드 · 데이터 · 고른 탭은 setState 로 기억해, 탭을 가렸다 와도(화면이 새로 그려져도) 그대로다.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const UNDO_LIMIT = 30;
  const EMPTY_OUTPUT = 'Ctrl+Enter 로 돌리면 결과가 여기에 나옵니다.\n왼쪽 예제를 고르면 바로 돌려 보여 줍니다.';
  const EMPTY_TABLE = 'console.table(배열) 을 쓰거나 마지막 줄에 배열을 두면 표로 보입니다.';

  const code = $('code'), data = $('data'), list = $('list'), output = $('output'), status = $('status');
  let examples = [];
  let shown = []; // 지금 목록에 보이는 예제 번호
  let selected = -1;
  let tables = [];
  let running = false;
  let afterRun = null; // 실행 중에 예제를 또 고르면 끝난 뒤에 그것을 돌린다
  const undo = [];
  const saved = vscode.getState() || {};

  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  const show = (el, on) => el.classList.toggle('hidden', !on);

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.setState({ code: code.value, data: data.value, lang: radio('lang'), leftTab: radio('leftTab'), search: $('search').value }), 300);
  }

  function setStatus(text, error) {
    status.textContent = text || '';
    status.className = error ? 'error' : text && /^끝/.test(text) ? 'ok' : '';
  }

  function setRunning(on) {
    running = on;
    $('run').disabled = on;
    $('stop').disabled = !on;
    $('pMake').disabled = on;
    $('convert').disabled = on;
  }

  // ── 왼쪽 · 결과 탭
  function leftTab() {
    const tab = radio('leftTab');
    show($('examplesPane'), tab === 'examples');
    show($('pipelinePane'), tab === 'pipeline');
    if (tab === 'pipeline') columns();
  }
  function resultTab() {
    const tab = radio('resultTab');
    show(output, tab === 'output');
    show($('tablePane'), tab === 'table');
    show($('tablePick'), tab === 'table' && tables.length > 1);
    show($('copyOutput'), tab === 'output');
  }

  // ── 예제
  function renderList() {
    const words = $('search').value.toLowerCase().split(/\s+/).filter(Boolean);
    list.textContent = '';
    shown = [];
    let group = '';
    const frag = document.createDocumentFragment();
    examples.forEach((e, i) => {
      if (words.length && !words.every((w) => e.hay.includes(w))) return;
      if (e.group !== group) {
        group = e.group;
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = group;
        frag.appendChild(g);
      }
      const row = document.createElement('div');
      row.className = 'item' + (i === selected ? ' sel' : '');
      row.dataset.i = String(i);
      row.textContent = e.title;
      row.title = e.title;
      if (e.viewOnly) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '화면 전용';
        row.appendChild(tag);
      }
      frag.appendChild(row);
      shown.push(i);
    });
    if (!shown.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = examples.length ? '맞는 예제가 없습니다' : '';
      frag.appendChild(none);
    }
    list.appendChild(frag);
  }

  function pick(i, scroll) {
    if (i < 0 || i >= examples.length) return;
    selected = i;
    for (const el of list.querySelectorAll('.item')) {
      const on = Number(el.dataset.i) === i;
      el.classList.toggle('sel', on);
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    }
    const e = examples[i];
    $('desc').textContent = e.description || e.title;
    fill(e.code, e.data);
    if (e.viewOnly) {
      const view = () => {
        tables = [];
        showResult('브라우저 · Vue · React 화면 안에서만 도는 코드라 작업대에서는 실행하지 않습니다.\n"코드 복사" 로 가져가 화면 소스에 붙여 쓰세요.', []);
        setStatus('화면 전용 예제라 실행하지 않았습니다.');
      };
      if (running) {
        afterRun = view;
        vscode.postMessage({ type: 'stop' });
      } else view();
      return;
    }
    run();
  }

  // ── 코드 · 데이터
  function fill(newCode, newData) {
    if (code.value === newCode && data.value === newData) return;
    undo.push([code.value, data.value]);
    if (undo.length > UNDO_LIMIT) undo.shift();
    $('undo').disabled = false;
    code.value = newCode;
    data.value = newData;
    code.scrollTop = data.scrollTop = 0;
    dataChanged();
    save();
  }

  function run() {
    const go = () => {
      setRunning(true);
      setStatus('실행하는 중…');
      vscode.postMessage({ type: 'run', code: code.value, data: data.value, typescript: radio('lang') === 'ts' });
    };
    if (running) {
      afterRun = go;
      vscode.postMessage({ type: 'stop' });
    } else go();
  }

  function showResult(text, newTables) {
    tables = newTables || [];
    output.textContent = text || EMPTY_OUTPUT;
    output.classList.toggle('dim', !text);
    const pickBox = $('tablePick');
    pickBox.textContent = '';
    tables.forEach((t, i) => pickBox.add(new Option(`표 ${i + 1} (${t.rows.length + t.more}줄)`, String(i))));
    if (tables.length) pickBox.value = String(tables.length - 1);
    showTable(tables.length - 1);
  }

  function showTable(index) {
    const wrap = $('tableWrap'), note = $('tableNote');
    wrap.textContent = '';
    show(note, false);
    const t = tables[index];
    if (!t) {
      wrap.textContent = EMPTY_TABLE;
      wrap.className = 'dim';
      return;
    }
    wrap.className = '';
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const c of t.columns) {
      const th = document.createElement('th');
      th.textContent = c;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const r of t.rows) {
      const tr = body.insertRow();
      for (const v of r) tr.insertCell().textContent = v;
    }
    wrap.appendChild(table);
    if (t.more > 0) {
      note.textContent = `앞 ${t.rows.length}줄만 보입니다. ${t.more}줄 더 있습니다.`;
      show(note, true);
    }
  }

  // ── 고르기로 만들기
  /** 입력 데이터의 칸 이름: JSON 객체 배열이면 키를 나온 순서대로, 객체 하나면 그 키, 엑셀 표(탭)면 첫 줄 */
  function columnNames(text) {
    const t = text.trim();
    if (!t) return [];
    const out = [];
    const add = (o) => Object.keys(o).forEach((k) => out.includes(k) || out.push(k));
    try {
      const root = JSON.parse(t);
      if (Array.isArray(root)) root.forEach((r) => r && typeof r === 'object' && !Array.isArray(r) && add(r));
      else if (root && typeof root === 'object') add(root);
      return out;
    } catch (e) {
      if (!t.includes('\t')) return [];
      return t.split(/\r?\n/)[0].split('\t').map((c, i) => c.trim() || 'COL' + (i + 1));
    }
  }
  function columns() {
    const names = columnNames(data.value);
    show($('noData'), !names.length);
    const box = $('columns');
    box.textContent = '';
    names.forEach((n) => box.appendChild(new Option(n, n)));
  }
  let columnsTimer;
  function dataChanged() {
    clearTimeout(columnsTimer);
    columnsTimer = setTimeout(() => radio('leftTab') === 'pipeline' && columns(), 400);
  }
  function spec() {
    const v = (id) => $(id).value.trim() || undefined;
    return {
      filterColumn: v('pFilterColumn'), filterOp: $('pFilterOp').value, filterValue: $('pFilterValue').value,
      distinctColumn: v('pDistinct'), groupColumn: v('pGroup'), aggregate: $('pAgg').value || undefined, aggColumn: v('pAggColumn'),
      sortColumn: v('pSort'), sortDescending: $('pOrder').value === 'desc', limit: Math.max(0, Math.floor(Number($('pLimit').value) || 0)),
    };
  }

  // ── 이벤트
  for (const el of document.querySelectorAll('input[name="leftTab"]')) el.addEventListener('change', () => (leftTab(), save()));
  for (const el of document.querySelectorAll('input[name="resultTab"]')) el.addEventListener('change', resultTab);
  for (const el of document.querySelectorAll('input[name="lang"]')) el.addEventListener('change', save);
  $('search').addEventListener('input', () => (renderList(), save()));
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      if (shown.length) pick(shown.includes(selected) ? selected : shown[0], true), list.focus();
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.item');
    if (row) pick(Number(row.dataset.i));
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = shown.indexOf(selected);
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next !== undefined && next !== selected) pick(next, true);
  });
  code.addEventListener('input', save);
  data.addEventListener('input', () => (dataChanged(), save()));
  for (const area of [code, data]) {
    area.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    });
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
  $('run').addEventListener('click', run);
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('undo').addEventListener('click', () => {
    const last = undo.pop();
    if (!last) return;
    [code.value, data.value] = last;
    $('undo').disabled = !undo.length;
    dataChanged();
    save();
  });
  $('copyCode').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: code.value, what: '코드를' }));
  $('copyOutput').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: output.classList.contains('dim') ? '' : output.textContent, what: '출력을' }));
  $('insert').addEventListener('click', () => vscode.postMessage({ type: 'insert', code: code.value }));
  $('tablePick').addEventListener('change', (e) => showTable(Number(e.target.value)));
  $('convert').addEventListener('change', (e) => {
    const mode = e.target.value;
    e.target.value = '';
    if (!mode || running) return;
    if (!data.value.trim()) return setStatus('입력 데이터가 비었습니다.', true);
    setRunning(true);
    setStatus('바꾸는 중…');
    vscode.postMessage({ type: 'convert', mode, data: data.value });
  });
  $('pFilterOp').addEventListener('change', (e) => ($('pFilterValue').disabled = e.target.value === 'EMPTY' || e.target.value === 'NOT_EMPTY'));
  $('pMake').addEventListener('click', () => vscode.postMessage({ type: 'generate', spec: spec() }));

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'init') {
      examples = m.examples.map((e) => Object.assign(e, { hay: (e.group + '\n' + e.title + '\n' + e.description + '\n' + e.code).toLowerCase() }));
      for (const [k, label] of Object.entries(m.ops)) $('pFilterOp').add(new Option(label, k));
      $('pAgg').add(new Option('(안 씀)', ''));
      for (const [k, label] of Object.entries(m.aggs)) $('pAgg').add(new Option(label, k));
      renderList();
      $('desc').textContent = m.failedToRead
        ? '예제 모음을 읽지 못했습니다. 코드는 그대로 실행할 수 있습니다.'
        : `예제를 고르면 코드 · 입력 데이터가 채워지고 바로 실행되어 오른쪽에 결과가 나옵니다. 고친 뒤에는 Ctrl+Enter 로 다시 돌리세요. 예제 ${examples.length}개.`;
      if (m.initial) use(m.initial);
    } else if (m.type === 'use') {
      use(m);
    } else if (m.type === 'running') {
      setRunning(true);
    } else if (m.type === 'generated') {
      fill(m.code, data.value);
      run();
    } else if (m.type === 'status') {
      setStatus(m.text, m.error);
    } else if (m.type === 'done') {
      setRunning(false);
      if (afterRun) {
        const next = afterRun;
        afterRun = null;
        return next();
      }
      if (m.data !== undefined) fill(code.value, m.data);
      if (m.output !== undefined) {
        showResult(m.output, m.tables);
        setRadio('resultTab', tables.length && !m.error ? 'table' : 'output');
        resultTab();
      }
      setStatus(m.status, m.error);
    }
  });

  function use(initial) {
    fill(initial.code, data.value);
    setRadio('lang', initial.typescript ? 'ts' : 'js');
    save();
    code.focus();
  }

  // ── 처음
  code.value = saved.code || '';
  data.value = saved.data || '';
  if (saved.lang) setRadio('lang', saved.lang);
  if (saved.leftTab) setRadio('leftTab', saved.leftTab);
  $('search').value = saved.search || '';
  showResult('', []);
  leftTab();
  resultTab();
  vscode.postMessage({ type: 'ready' });
})();
