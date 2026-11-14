// 정규식 작업대 화면. 확장(panel.ts)과 메시지로 주고받는다.
// 패턴 · 플래그 · 시험 글 · 만들기 탭 · 직접 만들기의 조합은 setState 로 기억해, 탭을 가렸다 와도 그대로다.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const RUN_DELAY = 150;
  const MAX_ROWS = 300; // 그룹 표에 그릴 최대 줄
  const KIND_LABEL = { KOREAN: '한글', UPPER: '영문 대문자', LOWER: '영문 소문자', DIGIT: '숫자', SPACE: '공백', SYMBOL: '특수문자' };
  const SOURCES = { KINDS: '종류에서 고르기', WORDS: '정해진 낱말', ANY: '아무 글자', EXCEPT: '이 글자 빼고' };
  const REPEATS = { ONCE: '한 번', OPTIONAL: '있어도 없어도', ONE_OR_MORE: '하나 이상', ZERO_OR_MORE: '없거나 여러 번', EXACTLY: '정확히 N번', AT_LEAST: 'N번 이상', RANGE: 'N~M번' };

  const pattern = $('pattern'), sample = $('sample'), marks = $('marks'), check = $('check'), replacement = $('replacement');
  const saved = vscode.getState() || {};
  let presets = [];
  let parts = saved.parts || [];
  let filledSample = saved.filledSample ?? null; // 만들기가 채운 시험 글 (사용자가 고치면 더는 덮지 않는다)
  let runId = 0;
  let lastResult = null;

  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
  const show = (el, on) => el.classList.toggle('hidden', !on);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };
  const flags = () => checked('flag').join('');
  const setFlags = (letters) => document.querySelectorAll('input[name="flag"]').forEach((x) => (x.checked = letters.includes(x.value)));

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () =>
        vscode.setState({
          pattern: pattern.value, flags: flags(), sample: sample.value, check: check.value, replacement: replacement.value, filledSample,
          make: radio('make'), resTab: radio('resTab'), fold: $('makeBody').classList.contains('hidden'), parts,
          cWhole: $('cWhole').checked, cWord: $('cWord').checked, cNeeds: checked('cNeed'), cMin: $('cMin').value,
          good: $('good').value, bad: $('bad').value, presetSearch: $('presetSearch').value,
        }),
      300
    );
  }
  function setStatus(text, error) {
    $('status').textContent = text || '';
    $('status').className = error ? 'error' : '';
  }

  // ── 계산
  let runTimer;
  function changed() {
    save();
    code();
    clearTimeout(runTimer);
    runTimer = setTimeout(run, RUN_DELAY);
  }
  function run() {
    const id = ++runId;
    if (!pattern.value) {
      render({ problem: 'NONE', matches: [], count: 0 }, true);
      return;
    }
    vscode.postMessage({ type: 'run', id, q: { pattern: pattern.value, flags: flags(), text: sample.value, replacement: replacement.value, check: check.value } });
  }
  function code() {
    vscode.postMessage({ type: 'code', flavor: $('flavor').value, pattern: pattern.value, flags: flags(), replacement: radio('resTab') === 'replace' ? replacement.value : '' });
  }

  function render(r, empty, timeoutMs) {
    lastResult = r;
    pattern.classList.toggle('bad', r.problem !== 'NONE');
    // 시험 글 표시
    const text = sample.value;
    marks.textContent = '';
    let at = 0;
    const frag = document.createDocumentFragment();
    for (const m of r.matches) {
      if (m.start < at) continue;
      frag.append(text.slice(at, m.start));
      frag.append(el('mark', { class: m.start === m.end ? 'empty' : '' }, text.slice(m.start, m.end)));
      at = m.end;
    }
    frag.append(text.slice(at) + '\n');
    marks.append(frag);
    syncScroll();
    // 개수 · 상태
    const count = $('count');
    if (empty) count.textContent = '';
    else if (r.problem !== 'NONE') count.textContent = '';
    else count.textContent = r.count ? `${r.count}개 일치${r.count > r.matches.length ? ` · 처음 ${r.matches.length}개만 보입니다` : ''}` : '일치 없음';
    if (r.problem === 'SYNTAX') setStatus('패턴 오류: ' + r.detail, true);
    else if (r.problem === 'TIMEOUT') setStatus(`${(timeoutMs / 1000).toFixed(1)}초 안에 끝나지 않아 멈췄습니다. 같은 글을 여러 번 되짚는 패턴입니다 (예: (.*a){20}).`, true);
    else if ($('status').classList.contains('error') && /^패턴 오류|초 안에/.test($('status').textContent)) setStatus('');
    // 확인할 글
    const v = $('verdict');
    v.className = '';
    if (!check.value || !pattern.value || r.problem !== 'NONE' || !r.check) v.textContent = '';
    else if (r.check.verdict === 'FULL') (v.textContent = '✓ 이 정규식에 맞습니다'), (v.className = 'ok');
    else if (r.check.verdict === 'PARTIAL') (v.textContent = `△ 일부만 맞습니다: ${r.check.part}`), (v.className = 'warn');
    else (v.textContent = '✗ 맞지 않습니다'), (v.className = 'error');
    // 그룹 표
    const groups = $('groups');
    groups.textContent = '';
    if (!r.matches.length) {
      groups.append(el('div', { class: 'dim pad' }, empty ? '패턴과 시험 글을 넣으면 일치와 그룹이 여기에 나옵니다.' : '일치 없음'));
    } else {
      const table = el('table');
      table.createTHead().append(el('tr', {}, el('th', {}, '일치'), el('th', {}, '그룹'), el('th', {}, '이름'), el('th', {}, '값'), el('th', {}, '위치')));
      const body = table.createTBody();
      let rows = 0;
      r.matches.forEach((m, i) => {
        for (const g of m.groups) {
          if (rows++ >= MAX_ROWS) return;
          body.append(
            el('tr', { class: g.index === 0 ? 'first' : '' },
              el('td', {}, g.index === 0 ? String(i + 1) : ''),
              el('td', {}, g.index === 0 ? '전체' : String(g.index)),
              el('td', {}, g.name || ''),
              el('td', { class: g.value === null ? 'dim' : 'val' }, g.value === null ? '(일치 안 함)' : g.value),
              el('td', { class: 'dim' }, g.start < 0 ? '' : `${g.start}–${g.end}`))
          );
        }
      });
      groups.append(table);
      if (rows > MAX_ROWS) groups.append(el('div', { class: 'dim pad' }, `앞 ${MAX_ROWS}줄만 보입니다.`));
    }
    $('replaced').textContent = r.replaced ?? '';
  }
  function syncScroll() {
    marks.scrollTop = sample.scrollTop;
    marks.scrollLeft = sample.scrollLeft;
  }

  // ── 만들기가 만든 패턴 넣기
  function use(p, lines, newSample) {
    if (lines) setFlags([...new Set((flags() + 'gm').split(''))].join(''));
    pattern.value = p;
    if (newSample != null && (!sample.value || sample.value === filledSample)) {
      sample.value = newSample;
      filledSample = newSample;
      sample.scrollTop = 0;
    }
    changed();
  }

  // ── 자주 쓰는 것
  function renderPresets() {
    const box = $('presets');
    box.textContent = '';
    const words = $('presetSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
    let category = null, row = null;
    for (const p of presets) {
      const hay = (p.category + ' ' + p.name + ' ' + p.pattern).toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      if (p.category !== category) {
        category = p.category;
        row = el('div', { class: 'chips' });
        box.append(el('div', { class: 'cat' }, category), row);
      }
      row.append(el('button', { class: 'chip', title: p.pattern, onclick: () => {
        setFlags(p.flags);
        replacement.value = p.replacement;
        if (p.replacement) setRes('replace');
        use(p.pattern, false, p.sample);
        setStatus(`"${p.name}" 을(를) 넣었습니다.`);
      } }, p.name));
    }
    if (!box.childElementCount) box.append(el('div', { class: 'dim pad' }, presets.length ? '맞는 것이 없습니다' : '자주 쓰는 정규식을 읽지 못했습니다.'));
  }

  // ── 질문 따라가기
  function askChanged() {
    const len = $('askLength').value;
    show($('askN'), len !== 'ONE_OR_MORE');
    show($('askTail'), len !== 'ONE_OR_MORE');
    show($('askTilde'), len === 'RANGE');
    show($('askM'), len === 'RANGE');
    const whole = radio('askWhere') === 'whole';
    document.querySelectorAll('#askPane .whole').forEach((x) => show(x, whole));
    if (!checked('askKind').length && !$('askExtra').value) return;
    vscode.postMessage({
      type: 'ask', whole, kinds: checked('askKind'), extra: $('askExtra').value, spaced: $('askSpaced').checked, needs: whole ? checked('askNeed') : [],
      length: { repeat: len, n: Number($('askN').value) || 0, m: Number($('askM').value) || 0 },
    });
  }

  // ── 직접 만들기
  const newRepeating = () => ({ repeat: 'ONCE', n: 1, m: 3, lazy: false, capture: false, name: '' });
  const newPiece = () => ({ source: 'KINDS', kinds: [], text: '', repeating: newRepeating(), before: '', after: '' });
  let composeTimer;
  function composeChanged() {
    save();
    clearTimeout(composeTimer);
    composeTimer = setTimeout(() => {
      show(document.querySelector('.cwhole'), $('cWhole').checked);
      if (!parts.length) return ($('composeNote').textContent = '＋ 로 조각을 더해 고르면 패턴이 만들어집니다.'), ($('composeNote').className = 'dim');
      vscode.postMessage({ type: 'compose', parts, shape: { whole: $('cWhole').checked, wordOnly: $('cWord').checked, needs: checked('cNeed'), minLength: Number($('cMin').value) || 0 } });
    }, 120);
  }
  function repeatControls(r) {
    const n = el('input', { type: 'number', min: '0', class: 'num', value: String(r.n), oninput: (e) => ((r.n = Number(e.target.value) || 0), composeChanged()) });
    const m = el('input', { type: 'number', min: '0', class: 'num', value: String(r.m), oninput: (e) => ((r.m = Number(e.target.value) || 0), composeChanged()) });
    const tilde = el('span', {}, '~');
    const lazyBox = el('label', { title: '여러 개가 이어질 때 하나씩 따로 잡습니다' }, el('input', { type: 'checkbox', checked: r.lazy, onchange: (e) => ((r.lazy = e.target.checked), composeChanged()) }), ' 가능한 짧게');
    const sync = () => {
      show(n, ['EXACTLY', 'AT_LEAST', 'RANGE'].includes(r.repeat));
      show(tilde, r.repeat === 'RANGE');
      show(m, r.repeat === 'RANGE');
      show(lazyBox, !['ONCE', 'EXACTLY'].includes(r.repeat));
    };
    const sel = el('select', { onchange: (e) => ((r.repeat = e.target.value), sync(), composeChanged()) }, ...Object.entries(REPEATS).map(([k, v]) => el('option', { value: k, selected: k === r.repeat }, v)));
    const name = el('input', { type: 'text', class: 'name', placeholder: '이름 (없어도 됨)', value: r.name, spellcheck: 'false', oninput: (e) => ((r.name = e.target.value.trim()), composeChanged()) });
    const cap = el('label', {}, el('input', { type: 'checkbox', checked: r.capture, onchange: (e) => ((r.capture = e.target.checked), show(name, r.capture), composeChanged()) }), ' 값 꺼내기 (그룹)');
    show(name, r.capture);
    sync();
    return [el('div', { class: 'line' }, el('span', { class: 'lbl' }, '몇 번'), sel, n, tilde, m, lazyBox), el('div', { class: 'line' }, el('span', { class: 'lbl' }, '꺼내기'), cap, name)];
  }
  function tools(list, i) {
    const move = (d) => () => {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      renderParts();
      composeChanged();
    };
    return el('span', { class: 'tools' },
      el('button', { title: '위로', onclick: move(-1) }, '↑'),
      el('button', { title: '아래로', onclick: move(1) }, '↓'),
      el('button', { title: '빼기', onclick: () => (list.splice(i, 1), renderParts(), composeChanged()) }, '✕'));
  }
  function pieceCard(p, list, i, title) {
    const kinds = el('span', { class: 'checks' }, ...Object.keys(KIND_LABEL).map((k) =>
      el('label', {}, el('input', { type: 'checkbox', checked: p.kinds.includes(k), onchange: (e) => ((p.kinds = e.target.checked ? [...p.kinds, k] : p.kinds.filter((x) => x !== k)), composeChanged()) }), ' ' + KIND_LABEL[k])));
    const text = el('input', { type: 'text', value: p.text, spellcheck: 'false', oninput: (e) => ((p.text = e.target.value), composeChanged()) });
    const textLabel = el('span', { class: 'lbl' });
    const sync = () => {
      show(kinds, p.source === 'KINDS');
      show(text, p.source !== 'ANY');
      show(textLabel, p.source !== 'ANY');
      textLabel.textContent = { KINDS: '이 글자도', WORDS: '낱말', EXCEPT: '뺄 글자' }[p.source] || '';
      text.placeholder = { KINDS: '종류 말고 더 넣을 글자 (예: -_.)', WORDS: '쉼표로 여럿이면 그중 하나 (예: 010, 011)', EXCEPT: '예: ,' }[p.source] || '';
    };
    const source = el('select', { onchange: (e) => ((p.source = e.target.value), sync(), composeChanged()) }, ...Object.entries(SOURCES).map(([k, v]) => el('option', { value: k, selected: k === p.source }, v)));
    sync();
    const around = (key, label, tail) => [el('span', {}, label), el('input', { type: 'text', class: 'short', value: p[key], spellcheck: 'false', oninput: (e) => ((p[key] = e.target.value), composeChanged()) }), el('span', {}, tail)];
    return el('div', { class: 'card' },
      el('div', { class: 'cardHead' }, el('b', {}, title), tools(list, i)),
      el('div', { class: 'line' }, el('span', { class: 'lbl' }, '글자'), source, kinds),
      el('div', { class: 'line' }, textLabel, text),
      ...repeatControls(p.repeating),
      el('div', { class: 'line' }, el('span', { class: 'lbl' }, '조건'), ...around('before', '앞에', '있을 때만'), ...around('after', '뒤에', '올 때만')));
  }
  function renderParts() {
    const box = $('parts');
    box.textContent = '';
    parts.forEach((part, i) => {
      if (!part.pieces) return box.append(pieceCard(part, parts, i, `${i + 1}. 조각`));
      const inner = el('div', { class: 'inner' }, ...part.pieces.map((p, j) => pieceCard(p, part.pieces, j, `${i + 1}-${j + 1}. 조각`)));
      box.append(el('div', { class: 'card bunch' },
        el('div', { class: 'cardHead' }, el('b', {}, `${i + 1}. 묶음`), tools(parts, i)),
        el('div', { class: 'line' }, el('span', { class: 'lbl' }, '묶음 방식'),
          el('select', { onchange: (e) => ((part.anyOf = e.target.value === 'any'), composeChanged()) },
            el('option', { value: 'seq', selected: !part.anyOf }, '차례로'), el('option', { value: 'any', selected: !!part.anyOf }, '그중 하나 (또는)'))),
        ...repeatControls(part.repeating),
        inner,
        el('button', { onclick: () => (part.pieces.push(newPiece()), renderParts(), composeChanged()) }, '＋ 묶음 안에 조각')));
    });
  }

  // ── 결과 탭
  function setRes(tab) {
    document.querySelector(`input[name="resTab"][value="${tab}"]`).checked = true;
    resTab();
  }
  function resTab() {
    const tab = radio('resTab');
    show($('groupsPane'), tab === 'groups');
    show($('replacePane'), tab === 'replace');
    save();
    code();
  }
  function makeTab() {
    const tab = radio('make');
    for (const t of ['presets', 'ask', 'examples', 'compose']) show($(t + 'Pane'), t === tab);
    save();
  }

  // ── 이벤트
  document.querySelectorAll('input[name="make"]').forEach((x) => x.addEventListener('change', () => ($('makeBody').classList.remove('hidden'), ($('fold').textContent = '▲'), makeTab())));
  document.querySelectorAll('input[name="resTab"]').forEach((x) => x.addEventListener('change', resTab));
  document.querySelectorAll('input[name="flag"]').forEach((x) => x.addEventListener('change', changed));
  $('fold').addEventListener('click', () => {
    const body = $('makeBody');
    body.classList.toggle('hidden');
    $('fold').textContent = body.classList.contains('hidden') ? '▼' : '▲';
    save();
  });
  for (const x of [pattern, check, replacement]) x.addEventListener('input', changed);
  sample.addEventListener('input', () => {
    if (sample.value !== filledSample) filledSample = null;
    changed();
  });
  sample.addEventListener('scroll', syncScroll);
  $('presetSearch').addEventListener('input', () => (renderPresets(), save()));
  for (const x of document.querySelectorAll('#askPane input, #askPane select')) x.addEventListener(x.type === 'text' || x.type === 'number' ? 'input' : 'change', askChanged);
  $('guess').addEventListener('click', () => {
    const lines = (id) => $(id).value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    vscode.postMessage({ type: 'guess', good: lines('good'), bad: lines('bad') });
  });
  for (const id of ['good', 'bad']) $(id).addEventListener('input', save);
  for (const x of document.querySelectorAll('#cWhole, #cWord, input[name="cNeed"]')) x.addEventListener('change', composeChanged);
  $('cMin').addEventListener('input', composeChanged);
  $('addPiece').addEventListener('click', () => (parts.push(newPiece()), renderParts(), composeChanged()));
  $('addBunch').addEventListener('click', () => (parts.push({ pieces: [newPiece()], anyOf: false, repeating: newRepeating() }), renderParts(), composeChanged()));
  $('flavor').addEventListener('change', () => (vscode.postMessage({ type: 'flavor', flavor: $('flavor').value }), code()));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy', text: $('codeText').textContent }));
  $('insert').addEventListener('click', () => vscode.postMessage({ type: 'insert', text: $('codeText').textContent }));

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'init') {
      presets = m.presets;
      renderPresets();
      if (!saved.flavorSet) $('flavor').value = m.flavor;
      if (m.initial) useInitial(m.initial);
      changed();
    } else if (m.type === 'use') {
      useInitial(m);
      changed();
    } else if (m.type === 'result') {
      if (m.id === runId) render(m.result, false, m.timeoutMs);
    } else if (m.type === 'made') {
      const note = m.from === 'compose' ? $('composeNote') : m.from === 'guess' ? $('guessNote') : null;
      if (m.problem) {
        if (note) (note.textContent = m.problem), (note.className = 'error');
        else setStatus(m.problem, true);
        return;
      }
      if (m.from === 'compose') (note.textContent = '조합이 바뀌면 패턴 칸이 다시 만들어집니다.'), (note.className = 'dim');
      if (m.from === 'guess') {
        note.textContent = m.rejectsAll ? '만들었습니다. 맞아야 할 글은 모두 맞고, 틀려야 할 글은 모두 걸러집니다.' : '만들었지만 틀려야 할 글 가운데 맞는 것이 있습니다. 예시를 더 넣거나 "직접 만들기" 로 다듬으세요.';
        note.className = m.rejectsAll ? 'ok' : 'warn';
      }
      use(m.pattern, m.lines, m.sample);
    } else if (m.type === 'code') {
      $('codeText').textContent = m.replace || m.code;
    } else if (m.type === 'status') {
      setStatus(m.text, m.error);
    }
  });

  function useInitial(i) {
    if (i.flavor) $('flavor').value = i.flavor;
    if (i.sample) {
      sample.value = i.sample;
      filledSample = null;
    }
  }

  // ── 처음
  pattern.value = saved.pattern || '';
  if (saved.flags !== undefined) setFlags(saved.flags);
  sample.value = saved.sample || '';
  check.value = saved.check || '';
  replacement.value = saved.replacement || '';
  $('good').value = saved.good || '';
  $('bad').value = saved.bad || '';
  $('presetSearch').value = saved.presetSearch || '';
  $('cWhole').checked = !!saved.cWhole;
  $('cWord').checked = !!saved.cWord;
  $('cMin').value = saved.cMin || '0';
  (saved.cNeeds || []).forEach((n) => { const x = document.querySelector(`input[name="cNeed"][value="${n}"]`); if (x) x.checked = true; });
  if (saved.make) document.querySelector(`input[name="make"][value="${saved.make}"]`).checked = true;
  if (saved.resTab) document.querySelector(`input[name="resTab"][value="${saved.resTab}"]`).checked = true;
  if (saved.fold) ($('makeBody').classList.add('hidden'), ($('fold').textContent = '▼'));
  show(document.querySelector('.cwhole'), $('cWhole').checked);
  makeTab();
  resTab();
  renderParts();
  askChanged();
  render({ problem: 'NONE', matches: [], count: 0 }, true);
  vscode.postMessage({ type: 'ready' });
})();
