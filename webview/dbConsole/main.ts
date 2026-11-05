// DB 콘솔 화면 (Webview): 실행 도구 줄 · 파라미터 줄 · SQL 편집기(CodeMirror) · 연결 추가 팝업.
// 실행·접속·값 확인은 확장이 한다. 여기서는 입력을 모아 보내고 받은 상태를 그린다.
import { EditorView, keymap, Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorState, Prec, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { sql, PLSQL } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { splitStatements, statementAt, type Statement } from '../../src/features/dbConsole/sql/statements';
import { bindNames, inferType, BIND_TYPES, type BindType } from '../../src/features/dbConsole/sql/binds';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce ?? '';
const light = document.body.classList.contains('vscode-light');

// ───────── SQL 편집기 ─────────
const colors = light
  ? { keyword: '#0000ff', string: '#a31515', comment: '#008000', number: '#098658', bind: '#0070c1', fn: '#795e26' }
  : { keyword: '#569cd6', string: '#ce9178', comment: '#6a9955', number: '#b5cea8', bind: '#9cdcfe', fn: '#dcdcaa' };
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: colors.keyword },
  { tag: [t.string, t.special(t.string)], color: colors.string },
  { tag: [t.lineComment, t.blockComment], color: colors.comment },
  { tag: t.number, color: colors.number },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: colors.fn },
]);
// 파라미터(:name, #{name})에 색
const bindMatcher = new MatchDecorator({ regexp: /(?<![\w:]):[A-Za-z_][\w$#]*|#\{[^}\n]+\}/g, decoration: Decoration.mark({ class: 'cm-bind' }) });
const bindPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = bindMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = bindMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations }
);
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)' },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family, Consolas, monospace)', fontSize: 'var(--vscode-editor-font-size, 14px)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-editorLineNumber-foreground, #858585)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, rgba(128,128,128,0.12))' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, #aeafad)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78)' },
  '.cm-bind': { color: colors.bind },
  '.cm-tooltip': { backgroundColor: 'var(--vscode-editorSuggestWidget-background, #252526)', color: 'var(--vscode-editorSuggestWidget-foreground, #d4d4d4)', border: '1px solid var(--vscode-editorSuggestWidget-border, #454545)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, #04395e)', color: 'inherit' },
});
const sqlLang = new Compartment();
const sqlWith = (tables: string[]) => sql({ dialect: PLSQL, upperCaseKeywords: true, schema: Object.fromEntries(tables.map((n) => [n, []])) });

const editor = new EditorView({
  parent: $('editor'),
  state: EditorState.create({
    doc: '',
    extensions: [
      Prec.highest(
        keymap.of([
          // Ctrl+Enter·Ctrl+E 는 VS Code 단축키가 받아 'do' 메시지로 돌려준다 (package.json). 여기서는 기본 동작(빈 줄 넣기)만 막는다.
          // 두 곳에서 다 처리하면 한 번 눌러 두 번 실행된다
          { key: 'Mod-Enter', run: () => true },
        ])
      ),
      basicSetup,
      sqlLang.of(sqlWith([])),
      syntaxHighlighting(highlight),
      bindPlugin,
      theme,
      EditorView.cspNonce.of(nonce),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          armed = false;
          scheduleParams();
          scheduleSave();
        }
        if (u.selectionSet) armed = false;
      }),
    ],
  }),
});
const text = () => editor.state.doc.toString();

// ───────── 파라미터 줄 ─────────
interface ParamInput {
  value: string;
  type?: BindType;
}
/** 이름(소문자) → 값. SQL 에서 이름이 사라져도 값은 기억한다 (다시 쓰면 그대로 나온다) */
let params: Record<string, ParamInput> = {};
let confirmEach = true;
/** "실행할 때마다 값 확인": 실행을 한 번 누르면 값 칸으로 가고, 한 번 더(또는 Enter) 누르면 실행한다 */
let armed = false;
const $params = $('paramList');
const $confirm = $<HTMLInputElement>('confirmEach');
const $hint = $('hint');

function renderParams() {
  const names = bindNames(text());
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.param;
  $params.textContent = '';
  if (!names.length) {
    const none = document.createElement('span');
    none.className = 'muted small';
    none.textContent = 'SQL 에 :이름 을 쓰면 여기에 값 칸이 생깁니다';
    $params.appendChild(none);
    return;
  }
  for (const name of names) {
    const key = name.toLowerCase();
    const p = (params[key] ??= { value: '' });
    const label = document.createElement('label');
    label.className = 'param';
    const nm = document.createElement('span');
    nm.className = 'param-name';
    nm.textContent = ':' + name;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = p.value;
    input.dataset.param = key;
    input.size = Math.max(6, Math.min(24, p.value.length + 2));
    input.spellcheck = false;
    const type = document.createElement('select');
    type.className = 'param-type';
    type.title = '값의 타입 (자동: 값의 모양으로 정함)';
    const auto = () => `${inferType(p.value)}`;
    const fill = () => {
      type.textContent = '';
      for (const [v, labelText] of [['', auto()], ...BIND_TYPES.map((x) => [x, x + ' 고정'])] as [string, string][]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = labelText;
        type.appendChild(o);
      }
      type.value = p.type ?? '';
    };
    fill();
    input.addEventListener('input', () => {
      p.value = input.value;
      input.size = Math.max(6, Math.min(24, p.value.length + 2));
      if (!p.type) fill();
      scheduleSave();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        armed = true; // 값 칸에서 Enter = 확인했다
        start('run');
      }
    });
    type.addEventListener('change', () => {
      p.type = (type.value || undefined) as BindType | undefined;
      scheduleSave();
    });
    label.append(nm, input, type);
    $params.appendChild(label);
  }
  if (focused) ($params.querySelector(`input[data-param="${focused}"]`) as HTMLInputElement | null)?.focus();
}
let paramTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleParams = () => {
  clearTimeout(paramTimer);
  paramTimer = setTimeout(renderParams, 200);
};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleSave = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vscode.postMessage({ type: 'save', sql: text(), params, confirmEach }), 600);
};
$confirm.addEventListener('change', () => {
  confirmEach = $confirm.checked;
  scheduleSave();
});
$('addParam').addEventListener('click', () => {
  // 커서 자리에 :paramN 을 넣고 이름을 바로 고칠 수 있게 선택해 둔다
  const used = new Set(bindNames(text()).map((n) => n.toLowerCase()));
  let n = 1;
  while (used.has(`param${n}`)) n++;
  const name = `param${n}`;
  const { from, to } = editor.state.selection.main;
  editor.dispatch({ changes: { from, to, insert: ':' + name }, selection: { anchor: from + 1, head: from + 1 + name.length } });
  editor.focus();
});

// ───────── 실행 ─────────
function hint(message: string, kind: '' | 'warn' = '') {
  $hint.textContent = message || 'Ctrl+Enter 실행 · Ctrl+E 실행계획 · 커서가 있는 문장';
  $hint.className = 'hint' + (kind ? ' ' + kind : '');
}

/** 실행할 문장들: 선택 영역이 있으면 그 안의 문장들, 없으면 커서가 있는 문장 */
function targets(): (Statement & { line: number })[] {
  const doc = text();
  const sel = editor.state.selection.main;
  let list: Statement[];
  if (sel.empty) {
    const s = statementAt(doc, sel.head);
    list = s ? [s] : [];
  } else {
    list = splitStatements(doc.slice(sel.from, sel.to)).map((s) => ({ ...s, start: s.start + sel.from, end: s.end + sel.from }));
  }
  return list.map((s) => ({ ...s, line: editor.state.doc.lineAt(s.start).number }));
}

function start(what: 'run' | 'explain') {
  const list = targets();
  if (!list.length) {
    hint('실행할 SQL 문장이 없습니다', 'warn');
    return;
  }
  const names = [...new Set(list.flatMap((s) => bindNames(s.sql).map((n) => n.toLowerCase())))];
  if (what === 'run' && confirmEach && names.length && !armed) {
    // 값 확인: 첫 파라미터 칸으로 보내고 한 번 더 누르면 실행
    armed = true;
    renderParams();
    const first = $params.querySelector(`input[data-param="${names[0]}"]`) as HTMLInputElement | null;
    first?.focus();
    first?.select();
    hint('파라미터 값을 확인하고 Enter (또는 실행을 한 번 더)', 'warn');
    return;
  }
  armed = false;
  hint('');
  clearTimeout(saveTimer);
  vscode.postMessage({ type: 'save', sql: text(), params, confirmEach });
  vscode.postMessage({ type: what, statements: what === 'explain' ? list.slice(0, 1) : list, params });
}
$('run').addEventListener('click', () => start('run'));
$('explain').addEventListener('click', () => start('explain'));
$('commit').addEventListener('click', () => vscode.postMessage({ type: 'commit' }));
$('rollback').addEventListener('click', () => vscode.postMessage({ type: 'rollback' }));
$('conn').addEventListener('click', () => vscode.postMessage({ type: 'connect' }));

// ───────── 연결 추가·수정 팝업 ─────────
const $overlay = $('overlay');
const FIELDS = ['name', 'host', 'port', 'user', 'password'] as const;
const CHECKS = ['savePassword', 'readOnly', 'production'] as const;
const d = (id: string) => $<HTMLInputElement>('d-' + id);
const kind = () => $<HTMLSelectElement>('d-kind').value;

function readForm() {
  const f: Record<string, unknown> = { targetKind: kind() };
  for (const id of FIELDS) f[id] = d(id).value;
  for (const id of CHECKS) f[id] = d(id).checked;
  f.target = kind() === 'raw' ? $<HTMLTextAreaElement>('d-targetRaw').value : d('target').value;
  return f;
}
function writeForm(f: Record<string, any>) {
  for (const id of FIELDS) d(id).value = f[id] ?? '';
  for (const id of CHECKS) d(id).checked = !!f[id];
  $<HTMLSelectElement>('d-kind').value = f.targetKind;
  if (f.targetKind === 'raw') $<HTMLTextAreaElement>('d-targetRaw').value = f.target ?? '';
  else d('target').value = f.target ?? '';
  showKind();
}
/** 접속 방식에 따라 칸을 바꾼다: 연결 문자열이면 호스트·포트는 쓰지 않는다 */
function showKind() {
  const raw = kind() === 'raw';
  d('target').classList.toggle('hidden', raw);
  $('d-targetRaw').classList.toggle('hidden', !raw);
  d('host').disabled = raw;
  d('port').disabled = raw;
  $('d-targetLabel').textContent = kind() === 'sid' ? 'SID' : raw ? '연결 문자열' : '서비스 이름';
}
function showErrors(errors: Record<string, string>) {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.error'))) el.textContent = errors[el.dataset.for ?? ''] ?? '';
  for (const id of FIELDS) d(id).classList.toggle('invalid', !!errors[id]);
  d('target').classList.toggle('invalid', !!errors.target);
  $('d-targetRaw').classList.toggle('invalid', !!errors.target);
  const first = ['name', 'host', 'port', 'target', 'user', 'password'].find((k) => errors[k]);
  if (first) (first === 'target' ? (kind() === 'raw' ? $('d-targetRaw') : d('target')) : d(first)).focus();
}
function testResult(cls: string, message: string) {
  const el = $('d-testResult');
  el.className = 'test-result' + (cls ? ' ' + cls : '');
  el.textContent = message;
}
function closeDialog(notify: boolean) {
  if ($overlay.classList.contains('hidden')) return;
  $overlay.classList.add('hidden');
  if (notify) vscode.postMessage({ type: 'dlgCancel' });
  editor.focus();
}
$('d-kind').addEventListener('change', showKind);
$('dialog').addEventListener('input', () => testResult('', '')); // 값을 바꾸면 앞의 테스트 결과는 더는 맞지 않는다
d('host').addEventListener('change', () => vscode.postMessage({ type: 'dlgHostDone', form: readForm() }));
$('d-urlToggle').addEventListener('click', (e) => {
  e.preventDefault();
  const row = $('d-urlRow');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) d('url').focus();
});
let urlTimer: ReturnType<typeof setTimeout> | undefined;
d('url').addEventListener('input', () => {
  clearTimeout(urlTimer);
  $('d-urlError').textContent = '';
  urlTimer = setTimeout(() => {
    if (d('url').value.trim()) vscode.postMessage({ type: 'dlgPaste', text: d('url').value, form: readForm() });
  }, 200);
});
$('d-test').addEventListener('click', () => vscode.postMessage({ type: 'dlgTest', form: readForm() }));
$('d-cancel').addEventListener('click', () => closeDialog(true));
$('d-close').addEventListener('click', () => closeDialog(true));
$('dialog').addEventListener('submit', (e) => {
  e.preventDefault();
  vscode.postMessage({ type: 'dlgSave', form: readForm() });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$overlay.classList.contains('hidden')) closeDialog(true);
});

// ───────── 확장에서 오는 메시지 ─────────
window.addEventListener('message', (event) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      params = m.params ?? {};
      confirmEach = m.confirmEach ?? true;
      $confirm.checked = confirmEach;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: m.sql ?? '' } });
      renderParams();
      editor.focus();
      break;
    case 'status': {
      // 연결 표시: 접속됨=초록 점, 운영 DB=빨간 글자
      const conn = $('conn');
      conn.classList.toggle('hidden', !m.name);
      conn.classList.toggle('on', !!m.connected);
      conn.classList.toggle('prod', !!m.production);
      $('connText').textContent = m.name ? `${m.name}${m.connected ? ' · ' + m.schema : m.connecting ? ' (접속하는 중…)' : ' (접속 안 됨)'}${m.readOnly ? ' · 읽기 전용' : ''}` : '';
      conn.title = m.connected ? '접속됨' : '눌러서 접속';
      const dirty = $('dirty');
      dirty.classList.toggle('hidden', !m.dirty);
      $('dirtyText').textContent = `커밋 안 한 변경 ${m.dirty}건`;
      for (const id of ['run', 'explain', 'commit', 'rollback']) $<HTMLButtonElement>(id).disabled = !m.name || !!m.busy;
      if (m.busy) hint('실행 중…');
      else if ($hint.textContent === '실행 중…') hint('');
      break;
    }
    case 'tables':
      editor.dispatch({ effects: sqlLang.reconfigure(sqlWith(m.names ?? [])) });
      break;
    case 'do':
      start(m.what); // 단축키(Ctrl+E 등)가 확장을 거쳐 온다
      break;
    case 'cursor':
      editor.dispatch({ selection: { anchor: Math.min(m.pos, editor.state.doc.length) }, scrollIntoView: true });
      editor.focus();
      break;
    case 'insert': {
      const { from, to } = editor.state.selection.main;
      editor.dispatch({ changes: { from, to, insert: m.text }, selection: { anchor: from + m.text.length } });
      editor.focus();
      break;
    }
    case 'hint':
      hint(m.message, 'warn');
      break;
    case 'dialog':
      $('d-title').textContent = m.editing ? 'DB 연결 수정' : 'DB 연결 추가';
      d('password').placeholder = m.hasSavedPassword ? '저장된 비밀번호 사용' : '';
      d('url').value = '';
      $('d-urlRow').classList.add('hidden');
      writeForm(m.form);
      showErrors({});
      testResult('', '');
      $overlay.classList.remove('hidden');
      d('name').focus();
      d('name').select();
      break;
    case 'dlgFill':
      writeForm(m.form);
      if (m.fromUrl) $('d-urlError').textContent = '';
      break;
    case 'dlgUrlFailed':
      $('d-urlError').textContent = m.message;
      break;
    case 'dlgErrors':
      showErrors(m.errors ?? {});
      break;
    case 'dlgTesting':
      $<HTMLButtonElement>('d-test').disabled = true;
      testResult('busy', '접속하는 중…');
      break;
    case 'dlgTestResult':
      $<HTMLButtonElement>('d-test').disabled = false;
      testResult(m.ok ? 'ok' : 'fail', m.message);
      break;
    case 'dlgClose':
      closeDialog(false);
      break;
  }
});

hint('');
vscode.postMessage({ type: 'ready' });
