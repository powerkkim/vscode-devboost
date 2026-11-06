// 편집을 VS Code 처럼 편하게: 지금 문장 표시, 선택 넓히기(Shift+Alt+→), 실행 취소가 두 번 되는 문제, 선택이 줄 강조에 가리는 문제.
import { EditorView, ViewPlugin, Decoration, keymap, gutter, GutterMarker, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorSelection, Prec, StateField, RangeSet, type EditorState, type Extension, type Range } from '@codemirror/state';
import { undo, redo, indentWithTab } from '@codemirror/commands';
import { splitStatements, statementAt, type DialectRules, type Statement } from '../../src/features/dbConsole/sql/statements';

/** 이보다 긴 글에서는 문장 표시를 하지 않는다 (키를 칠 때마다 전체를 나누므로) */
const MAX_SCAN = 2_000_000;

/** 문장의 실제 글 범위 (끝의 ; 와 / 줄은 빼고) */
export function statementRange(doc: string, s: Statement): { from: number; to: number } {
  return { from: s.start, to: s.start + s.sql.length };
}

/**
 * 커서가 있는 문장을 왼쪽 띠로 표시한다 (IntelliJ 콘솔처럼 Ctrl+Enter 로 무엇이 실행될지 보인다).
 * 선택 영역이 있으면 표시하지 않는다 (선택 영역이 실행된다)
 */
function currentStatement(rules: () => DialectRules): Extension {
  const mark = Decoration.line({ class: 'cm-stmt' });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const sel = view.state.selection.main;
        if (!sel.empty || view.state.doc.length > MAX_SCAN) return Decoration.none;
        const text = view.state.doc.toString();
        const s = statementAt(text, sel.head, rules());
        if (!s) return Decoration.none;
        const r = statementRange(text, s);
        const first = view.state.doc.lineAt(r.from).number;
        const last = view.state.doc.lineAt(Math.max(r.from, r.to - 1)).number;
        const out: Range<Decoration>[] = [];
        for (let n = first; n <= last; n++) out.push(mark.range(view.state.doc.line(n).from));
        return Decoration.set(out);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/**
 * 선택 넓히기·좁히기 (VS Code 의 Shift+Alt+→ / ←): 낱말 → 지금 문장 → 전체.
 * 좁히기는 넓히기 전으로 하나씩 돌아간다
 */
function expandSelection(rules: () => DialectRules): Extension {
  let stack: { anchor: number; head: number }[] = [];
  const grow = (view: EditorView) => {
    const { state } = view;
    const sel = state.selection.main;
    const text = state.doc.toString();
    const next = (): { from: number; to: number } | undefined => {
      const word = state.wordAt(sel.head);
      if (word && (word.from < sel.from || word.to > sel.to) && word.from <= sel.from && word.to >= sel.to) return word;
      const s = statementAt(text, sel.empty ? sel.head : sel.from, rules());
      if (s) {
        const r = statementRange(text, s);
        if ((r.from < sel.from || r.to > sel.to) && r.from <= sel.from && r.to >= sel.to) return r;
      }
      if (sel.from > 0 || sel.to < state.doc.length) return { from: 0, to: state.doc.length };
      return undefined;
    };
    const r = next();
    if (!r) return true;
    stack.push({ anchor: sel.anchor, head: sel.head });
    view.dispatch({ selection: EditorSelection.single(r.from, r.to), scrollIntoView: true, userEvent: 'select.expand' });
    return true;
  };
  const shrink = (view: EditorView) => {
    const prev = stack.pop();
    if (prev) view.dispatch({ selection: EditorSelection.single(prev.anchor, prev.head), userEvent: 'select.expand' });
    return true;
  };
  return [
    keymap.of([
      { key: 'Shift-Alt-ArrowRight', run: grow },
      { key: 'Shift-Alt-ArrowLeft', run: shrink },
    ]),
    // 넓히기 말고 다른 것으로 선택이 바뀌면 되돌릴 기록은 버린다
    EditorView.updateListener.of((u) => {
      if (u.docChanged || (u.selectionSet && !u.transactions.some((t) => t.isUserEvent('select.expand')))) stack = [];
    }),
  ];
}

/** 지금 문장을 고른다 (명령·오른쪽 클릭 메뉴). 이미 그 문장을 골랐으면 그대로 */
export function selectStatement(view: EditorView, rules: DialectRules) {
  const text = view.state.doc.toString();
  const sel = view.state.selection.main;
  const s = statementAt(text, sel.empty ? sel.head : sel.from, rules);
  if (!s) return;
  const r = statementRange(text, s);
  view.dispatch({ selection: EditorSelection.single(r.from, r.to), scrollIntoView: true });
  view.focus();
}

/**
 * 실행 취소가 두 번 되는 문제: VS Code 는 화면(Webview)에서 누른 Ctrl+Z 를 받아 화면에 "실행 취소"를 한 번 더 보낸다
 * (편집기 쪽에서는 historyUndo 입력 이벤트로 온다). 키로 막 처리한 직후에 오는 것은 버린다
 */
function singleHistory(): Extension {
  let lastKey = 0;
  const viaKey = (cmd: (v: EditorView) => boolean) => (v: EditorView) => {
    lastKey = Date.now();
    return cmd(v);
  };
  return [
    Prec.highest(
      keymap.of([
        { key: 'Mod-z', run: viaKey(undo), preventDefault: true },
        { key: 'Mod-y', run: viaKey(redo), preventDefault: true },
        { key: 'Mod-Shift-z', run: viaKey(redo), preventDefault: true },
      ])
    ),
    Prec.highest(
      EditorView.domEventHandlers({
        beforeinput(e) {
          if ((e.inputType === 'historyUndo' || e.inputType === 'historyRedo') && Date.now() - lastKey < 600) {
            e.preventDefault();
            return true;
          }
          return false;
        },
      })
    ),
  ];
}

/** 선택 영역이 있으면 지금 줄 강조를 끈다 — 테마의 줄 강조색이 불투명하면 선택이 가려 "선택이 안 되는" 것처럼 보인다 */
function selectionOverActiveLine(): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    u.view.dom.classList.toggle('has-selection', u.state.selection.ranges.some((r) => !r.empty));
  });
}

// ───────── 문장마다 실행 표시 (줄 번호 옆 ▶) ─────────

/** 글의 문장들 (글이 바뀔 때만 다시 나눈다) */
const statementsField = (rules: () => DialectRules) =>
  StateField.define<Statement[]>({
    create: (state) => scan(state, rules()),
    update: (list, tr) => (tr.docChanged ? scan(tr.state, rules()) : list),
  });
const scan = (state: EditorState, r: DialectRules) => (state.doc.length > MAX_SCAN ? [] : splitStatements(state.doc.toString(), r));

class RunMarker extends GutterMarker {
  constructor(readonly current: boolean) {
    super();
  }
  eq(o: RunMarker) {
    return o.current === this.current;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-run-marker' + (this.current ? ' current' : '');
    s.textContent = '▶';
    s.title = '이 문장 실행';
    return s;
  }
}
const marker = new RunMarker(false);
const currentMarker = new RunMarker(true);

/**
 * 문장이 시작하는 줄 옆에 ▶ — 누르면 그 문장만 실행한다. Ctrl+Enter 로 실행될 문장(커서가 있는 문장)은 진하게.
 * 여러 쿼리가 나열돼 있을 때 어느 문장이 실행되는지 한눈에 보이게
 */
function runGutter(rules: () => DialectRules, onRun: (stmt: Statement) => void): Extension {
  const field = statementsField(rules);
  return [
    field,
    gutter({
      class: 'cm-runGutter',
      markers(view) {
        const list = view.state.field(field);
        const sel = view.state.selection.main;
        const cur = sel.empty ? list.find((s) => sel.head >= s.start && sel.head <= s.end) : undefined;
        const seen = new Set<number>();
        const out: Range<GutterMarker>[] = [];
        for (const s of list) {
          const line = view.state.doc.lineAt(s.start).from;
          if (seen.has(line)) continue; // 한 줄에 문장이 여럿이면 첫 문장만
          seen.add(line);
          out.push((s === cur ? currentMarker : marker).range(line));
        }
        return RangeSet.of(out);
      },
      initialSpacer: () => marker,
      domEventHandlers: {
        mousedown(view, line) {
          const s = view.state.field(field).find((x) => view.state.doc.lineAt(x.start).from === line.from);
          if (!s) return false;
          view.dispatch({ selection: { anchor: s.start } });
          onRun(s);
          return true;
        },
      },
    }),
  ];
}

/** 지금 실행 대상 (선택 영역의 문장들, 없으면 커서가 있는 문장) — 도구 줄 안내·파라미터 칸에 쓴다 */
export function currentTargets(state: EditorState, rules: DialectRules): Statement[] {
  if (state.doc.length > MAX_SCAN) return [];
  const text = state.doc.toString();
  const sel = state.selection.main;
  if (sel.empty) {
    const s = statementAt(text, sel.head, rules);
    return s ? [s] : [];
  }
  return splitStatements(text.slice(sel.from, sel.to), rules).map((s) => ({ ...s, start: s.start + sel.from, end: s.end + sel.from }));
}

export function editingAssist(rules: () => DialectRules, onRun: (stmt: Statement) => void): Extension {
  return [
    currentStatement(rules),
    expandSelection(rules),
    singleHistory(),
    selectionOverActiveLine(),
    runGutter(rules, onRun),
    // Tab 은 들여쓰기 (포커스를 옮기지 않는다). Shift+Tab 은 내어쓰기. Esc 다음 Tab 은 포커스 이동
    keymap.of([indentWithTab]),
  ];
}
