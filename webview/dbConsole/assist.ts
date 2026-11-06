// 편집을 VS Code 처럼 편하게: 지금 문장 표시, 선택 넓히기(Shift+Alt+→), 실행 취소가 두 번 되는 문제, 선택이 줄 강조에 가리는 문제.
import { EditorView, ViewPlugin, Decoration, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { EditorSelection, Prec, type Extension, type Range } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { statementAt, type DialectRules, type Statement } from '../../src/features/dbConsole/sql/statements';

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
        if (!sel.empty || view.state.doc.length > 2_000_000) return Decoration.none;
        const text = view.state.doc.toString();
        const s = statementAt(text, sel.head, rules());
        if (!s) return Decoration.none;
        const r = statementRange(text, s);
        const first = view.state.doc.lineAt(r.from).number;
        const last = view.state.doc.lineAt(Math.max(r.from, r.to - 1)).number;
        // 한 줄짜리 문장은 표시할 것이 없다 (줄 강조로 충분)
        if (first === last) return Decoration.none;
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

export function editingAssist(rules: () => DialectRules): Extension {
  return [currentStatement(rules), expandSelection(rules), singleHistory(), selectionOverActiveLine()];
}
