// DB 콘솔 화면 (Webview): 실행 도구 줄 · 파라미터 줄 · SQL 편집기(CodeMirror) · 연결 추가 팝업.
// 실행·접속·값 확인은 확장이 한다. 여기서는 입력을 모아 보내고 받은 상태를 그린다.
import { EditorView, keymap, Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorState, Prec, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { sql, PLSQL, PostgreSQL, MySQL, type SQLDialect } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { splitStatements, statementAt, type Statement, type DialectRules } from '../../src/features/dbConsole/sql/statements';
import { bindNames, inferType, BIND_TYPES, type BindType } from '../../src/features/dbConsole/sql/binds';
import { rulesOf } from '../../src/features/dbConsole/driver/dialects';
import { inlineResults, anchorOf, addRunning, setResult, appendRows, moreFailed, markDropped, refreshAll, regroup } from './inline';
import { tableNames as tableNameMarks, tableNamesTheme } from './tables';
import { columnSources } from '../../src/features/dbConsole/sql/tableRefs';
import { editingAssist, selectStatement, currentTargets } from './assist';
import { columnLoader, reopenIfAfterDot } from './columns';
import { formatSql } from './format';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce ?? '';
const light = document.body.classList.contains('vscode-light');
/** 이 콘솔 연결의 DB 글 규칙 (문장 나누기·파라미터 찾기). init 에서 정해진다 */
let rules: DialectRules = rulesOf(undefined);
/** 한 번에 가져올 행 수·최대 행 수 (설정. 도구 줄에서 바꾼다) */
let limits = { pageSize: 500, maxRows: 10000 };

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
  // 선택 영역이 있으면 줄 강조를 끈다 (불투명한 줄 강조색이 선택을 가리지 않게)
  '&.has-selection .cm-activeLine': { backgroundColor: 'transparent' },
  // 커서가 있는 문장(여러 줄)의 왼쪽 띠: Ctrl+Enter 로 실행될 범위
  '.cm-stmt': { boxShadow: 'inset 2px 0 0 var(--vscode-focusBorder, #007fd4)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, #aeafad)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--vscode-editor-selectionBackground, #264f78)' },
  '.cm-bind': { color: colors.bind },
  '.cm-tooltip': { backgroundColor: 'var(--vscode-editorSuggestWidget-background, #252526)', color: 'var(--vscode-editorSuggestWidget-foreground, #d4d4d4)', border: '1px solid var(--vscode-editorSuggestWidget-border, #454545)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, #04395e)', color: 'inherit' },
});
// ───────── 자동 완성 재료: 테이블 이름과 (물어봐서 받은) 칸 ─────────
const sqlLang = new Compartment();
const DIALECTS: Record<string, SQLDialect> = { oracle: PLSQL, postgres: PostgreSQL, mysql: MySQL };
let dialect: SQLDialect = PLSQL;
/** DB 종류 (oracle · postgres · mysql) */
let dbKind = 'oracle';
let tableNames: string[] = [];
/** 테이블(대문자) → 칸 이름들 */
const tableColumns = new Map<string, string[]>();
/** 물어봤는데 칸이 없던 이름 (없는 테이블·뷰를 계속 묻지 않게) */
const noColumns = new Set<string>();
function askColumns(t: string) {
  const k = t.toUpperCase();
  if (asking.has(k) || noColumns.has(k) || tableColumns.has(k)) return;
  asking.add(k);
  vscode.postMessage({ type: 'needColumns', name: t });
}
const asking = new Set<string>();
function schemaObject(): Record<string, string[]> {
  const o: Record<string, string[]> = {};
  for (const n of tableNames) o[n] = tableColumns.get(n.toUpperCase()) ?? [];
  // 목록에 없는 이름(다른 스키마의 OWNER.TABLE 등)으로 받은 칸도 넣는다
  for (const [k, v] of tableColumns) if (!(k in o) && !tableNames.some((n) => n.toUpperCase() === k)) o[k] = v;
  return o;
}
const sqlWith = () => sql({ dialect, upperCaseKeywords: true, schema: schemaObject() });

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
          // SQL 정렬 (VS Code 의 문서 서식과 같은 키)
          {
            key: 'Shift-Alt-f',
            run: () => {
              format();
              return true;
            },
          },
        ])
      ),
      editingAssist(
        () => rules,
        () => start('run') // ▶ 를 누르면 커서를 그 문장으로 옮긴 뒤 실행
      ),
      basicSetup,
      sqlLang.of(sqlWith()),
      columnLoader({
        has: (t) => tableColumns.has(t.toUpperCase()),
        request: askColumns,
        rules: () => rules,
      }),
      tableNameMarks(() => rules),
      tableNamesTheme,
      inlineResults({
        more: (resultId, all) => vscode.postMessage({ type: 'more', resultId, all }),
        limits: () => limits,
        toPanel: (resultId, data) => vscode.postMessage({ type: 'toPanel', resultId, data }),
        copy: (text) => vscode.postMessage({ type: 'copy', text }),
        copyInsert: (data) => vscode.postMessage({ type: 'copyInsert', data }),
        csv: (data) => vscode.postMessage({ type: 'csv', data, params }),
        groups: (sqlText, columns) => {
          const r = columnSources(sqlText, columns.map((c) => c.name), (t) => tableColumns.get(t.toUpperCase()), rules);
          for (const t of r.need) askColumns(t);
          return r.result && { groups: r.result.groups, labels: r.result.sources.map((x) => x.label) };
        },
      }),
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
        if (u.docChanged || u.selectionSet) scheduleTarget();
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

/** 지금 실행 대상 문장들이 쓰는 파라미터 (소문자). 다른 문장의 파라미터 칸은 흐리게 */
let targetParams = new Set<string>();

function renderParams() {
  const names = bindNames(text(), rules);
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.param;
  $params.textContent = '';
  // 값 확인은 파라미터가 있을 때만 뜻이 있다
  $('confirmBox').classList.toggle('hidden', !names.length);
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
    label.className = 'param' + (targetParams.has(key) ? '' : ' unused');
    if (!targetParams.has(key)) label.title = '지금 실행할 문장에서는 쓰지 않는 파라미터';
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
  const used = new Set(bindNames(text(), rules).map((n) => n.toLowerCase()));
  let n = 1;
  while (used.has(`param${n}`)) n++;
  const name = `param${n}`;
  const { from, to } = editor.state.selection.main;
  editor.dispatch({ changes: { from, to, insert: ':' + name }, selection: { anchor: from + 1, head: from + 1 + name.length } });
  editor.focus();
});

// ───────── 실행 ─────────
/** 안내 글. 비우면 지금 실행 대상(몇 번째 줄 문장인지)을 보여 준다 */
let hintMessage = '';
function hint(message: string, kind: '' | 'warn' = '') {
  hintMessage = message;
  $hint.className = 'hint' + (kind ? ' ' + kind : '');
  if (message) $hint.textContent = message;
  else showTarget();
}

/**
 * 도구 줄의 실행·실행계획이 어느 문장에 해당하는지: "실행 대상: 12~15번째 줄" / "선택 영역의 문장 3개".
 * 파라미터 칸도 그 문장들에 맞춰 흐리게·진하게
 */
function showTarget() {
  const list = currentTargets(editor.state, rules);
  const lines = (s: Statement) => {
    const a = editor.state.doc.lineAt(s.start).number;
    const b = editor.state.doc.lineAt(Math.max(s.start, s.start + s.sql.length - 1)).number;
    return a === b ? `${a}번째 줄` : `${a}~${b}번째 줄`;
  };
  const sel = !editor.state.selection.main.empty;
  const text = !list.length ? '실행할 문장 없음' : sel ? (list.length === 1 ? `실행 대상: 선택 영역 (${lines(list[0])})` : `실행 대상: 선택 영역의 문장 ${list.length}개`) : `실행 대상: ${lines(list[0])} 문장`;
  if (!hintMessage) $hint.textContent = text;
  $<HTMLButtonElement>('run').title = `${text} — Ctrl+Enter (선택 영역이 있으면 그 안의 문장들, 없으면 커서가 있는 문장)`;
  $<HTMLButtonElement>('explain').title = `${list.length ? lines(list[0]) + ' 문장의 ' : ''}실행계획 — Ctrl+E (실제로 실행하지는 않습니다)`;
  const next = new Set(list.flatMap((s) => bindNames(s.sql, rules).map((n) => n.toLowerCase())));
  const changed = next.size !== targetParams.size || [...next].some((n) => !targetParams.has(n));
  targetParams = next;
  if (changed) renderParams();
}
let targetTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleTarget = () => {
  clearTimeout(targetTimer);
  targetTimer = setTimeout(() => {
    if (hintMessage && hintMessage !== '') hint('');
    else showTarget();
  }, 120);
};

/** 실행할 문장들: 선택 영역이 있으면 그 안의 문장들, 없으면 커서가 있는 문장 */
let runSeq = 0;
/** 실행할 문장들: 선택 영역이 있으면 그 안의 문장들, 없으면 커서가 있는 문장. key = 쿼리 아래 결과를 붙일 표시 */
function targets(): (Statement & { line: number; key: string })[] {
  const doc = text();
  const sel = editor.state.selection.main;
  let list: Statement[];
  if (sel.empty) {
    const s = statementAt(doc, sel.head, rules);
    list = s ? [s] : [];
  } else {
    list = splitStatements(doc.slice(sel.from, sel.to), rules).map((s) => ({ ...s, start: s.start + sel.from, end: s.end + sel.from }));
  }
  const run = ++runSeq;
  return list.map((s, i) => ({ ...s, line: editor.state.doc.lineAt(s.start).number, key: `${run}:${i}` }));
}

function start(what: 'run' | 'explain') {
  const list = targets();
  if (!list.length) {
    hint('실행할 SQL 문장이 없습니다', 'warn');
    return;
  }
  const names = [...new Set(list.flatMap((s) => bindNames(s.sql, rules).map((n) => n.toLowerCase())))];
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
  // 쿼리 아래에 "실행 중…" 자리를 먼저 만든다 (확장이 결과·실행계획으로 채운다)
  const sent = what === 'explain' ? list.slice(0, 1) : list;
  addRunning(editor, sent.map((s) => ({ key: s.key, pos: anchorOf(editor.state, s) })));
  vscode.postMessage({ type: what, statements: sent, params });
}
/** SQL 정렬: 선택 영역, 없으면 지금 문장 */
function format() {
  const r = formatSql(editor, dbKind, rules);
  if (!r.done && !r.failed) hint('정렬할 SQL 문장이 없습니다', 'warn');
  else if (r.failed) hint(`정렬하지 못한 문장 ${r.failed}개는 그대로 두었습니다 (PL/SQL 블록 등)`, 'warn');
  editor.focus();
}
$('run').addEventListener('click', () => start('run'));
$('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
$('explain').addEventListener('click', () => start('explain'));
$('commit').addEventListener('click', () => vscode.postMessage({ type: 'commit' }));
$('rollback').addEventListener('click', () => vscode.postMessage({ type: 'rollback' }));
$('conn').addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
const $pageSize = $<HTMLInputElement>('pageSize');
const $maxRows = $<HTMLInputElement>('maxRows');
const showLimits = () => {
  $pageSize.value = String(limits.pageSize);
  $maxRows.value = String(limits.maxRows);
};
const sendLimits = () => {
  const ps = Math.min(5000, Math.max(10, Math.floor(Number($pageSize.value)) || limits.pageSize));
  const mr = Math.min(200000, Math.max(100, Math.floor(Number($maxRows.value)) || limits.maxRows));
  limits = { pageSize: ps, maxRows: Math.max(mr, ps) };
  showLimits();
  vscode.postMessage({ type: 'limits', ...limits });
  refreshAll(editor);
};
for (const input of [$pageSize, $maxRows]) {
  input.addEventListener('change', sendLimits);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      editor.focus();
    }
  });
}
const $serverOutput = $<HTMLInputElement>('serverOutput');
$serverOutput.addEventListener('change', () => vscode.postMessage({ type: 'serverOutput', on: $serverOutput.checked }));

// ───────── 연결 추가·수정 팝업 ─────────
const $overlay = $('overlay');
const FIELDS = ['name', 'host', 'port', 'user', 'password'] as const;
const CHECKS = ['savePassword', 'readOnly', 'production'] as const;
const d = (id: string) => $<HTMLInputElement>('d-' + id);
const kind = () => $<HTMLSelectElement>('d-kind').value;
const $db = $<HTMLSelectElement>('d-db');
type KindChoice = { value: string; label: string; defaultPort: number; targetKinds: { value: string; label: string }[]; jdbcExample: string };
let kinds: KindChoice[] = [];
let shownDb = 'oracle';
const choiceOf = (v: string) => kinds.find((k) => k.value === v) ?? kinds[0];

function readForm() {
  const f: Record<string, unknown> = { kind: $db.value || 'oracle', targetKind: kind() };
  for (const id of FIELDS) f[id] = d(id).value;
  for (const id of CHECKS) f[id] = d(id).checked;
  f.target = kind() === 'raw' ? $<HTMLTextAreaElement>('d-targetRaw').value : d('target').value;
  return f;
}
/** DB 종류에 맞춰 접속 방식 선택지·안내를 다시 그린다 */
function showDb(db: string) {
  shownDb = db;
  $db.value = db;
  const c = choiceOf(db);
  if (!c) return;
  const sel = $<HTMLSelectElement>('d-kind');
  sel.replaceChildren(
    ...c.targetKinds.map((k) => {
      const o = document.createElement('option');
      o.value = k.value;
      o.textContent = k.label;
      return o;
    })
  );
  d('url').placeholder = c.jdbcExample;
  $<HTMLTextAreaElement>('d-targetRaw').placeholder = db === 'oracle' ? '(DESCRIPTION=(ADDRESS=…)(CONNECT_DATA=(SERVICE_NAME=…)))' : db === 'postgres' ? 'postgresql://host:5432/database' : 'mysql://host:3306/database';
}
function writeForm(f: Record<string, any>) {
  showDb(f.kind ?? 'oracle');
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
  const label = choiceOf(shownDb)?.targetKinds.find((k) => k.value === kind())?.label;
  $('d-targetLabel').textContent = label ?? '서비스 이름';
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
$db.addEventListener('change', () => vscode.postMessage({ type: 'dlgDb', form: readForm(), from: shownDb }));
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
      rules = rulesOf(m.kind);
      dialect = DIALECTS[m.kind] ?? PLSQL;
      dbKind = m.kind ?? 'oracle';
      tableColumns.clear();
      noColumns.clear();
      if (m.limits) limits = m.limits;
      showLimits();
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
      // 한 DB에만 있는 기능은 그 DB 접속일 때만 보인다
      $('outputBox').classList.toggle('hidden', !m.features?.serverOutput);
      $serverOutput.checked = !!m.serverOutput;
      if (m.busy) hint('실행 중…');
      else if ($hint.textContent === '실행 중…') hint('');
      break;
    }
    case 'tables':
      tableNames = m.names ?? [];
      editor.dispatch({ effects: sqlLang.reconfigure(sqlWith()) });
      break;
    case 'columns':
      asking.delete(String(m.name).toUpperCase());
      if (!m.columns?.length) {
        noColumns.add(String(m.name).toUpperCase());
        break;
      }
      tableColumns.set(String(m.name).toUpperCase(), m.columns);
      editor.dispatch({ effects: sqlLang.reconfigure(sqlWith()) });
      reopenIfAfterDot(editor);
      regroup();
      break;
    case 'do':
      // 단축키(Ctrl+E 등)·오른쪽 클릭 메뉴가 확장을 거쳐 온다
      if (m.what === 'selectStatement') selectStatement(editor, rules);
      else if (m.what === 'format') format();
      else start(m.what);
      break;
    case 'inline':
      setResult(editor, m.key, m.result);
      break;
    case 'inlineAppend':
      appendRows(editor, m.id, m.rows, m.done, m.capped, !!m.more);
      break;
    case 'limits':
      limits = { pageSize: m.pageSize, maxRows: m.maxRows };
      showLimits();
      refreshAll(editor);
      break;
    case 'inlineMoreFailed':
      moreFailed(editor, m.resultId, m.message);
      break;
    case 'inlineDropped':
      markDropped(editor, m.ids);
      break;
    case 'cursor':
      editor.dispatch({ selection: { anchor: Math.min(m.pos, editor.state.doc.length) }, scrollIntoView: true });
      editor.focus();
      break;
    case 'insert': {
      if (m.asBlock) {
        // 트리에서 만든 쿼리: 글 끝에 새 문단으로 넣고 골라 둔다 (run 이면 바로 실행 — 고른 영역의 문장들)
        const doc = editor.state.doc;
        const sep = doc.length === 0 ? '' : /\n\s*$/.test(doc.sliceString(Math.max(0, doc.length - 2))) ? '\n' : '\n\n';
        const from = doc.length + sep.length;
        editor.dispatch({
          changes: { from: doc.length, insert: sep + m.text },
          selection: { anchor: from, head: from + m.text.length },
          scrollIntoView: true,
        });
        editor.focus();
        if (m.run) start('run');
        break;
      }
      const { from, to } = editor.state.selection.main;
      editor.dispatch({ changes: { from, to, insert: m.text }, selection: { anchor: from + m.text.length } });
      editor.focus();
      break;
    }
    case 'hint':
      hint(m.message, 'warn');
      break;
    case 'dialog':
      kinds = m.kinds ?? [];
      $db.replaceChildren(
        ...kinds.map((k) => {
          const o = document.createElement('option');
          o.value = k.value;
          o.textContent = k.label;
          return o;
        })
      );
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
