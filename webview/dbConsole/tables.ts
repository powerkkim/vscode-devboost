// 편집기: FROM·JOIN·UPDATE·INTO 뒤의 테이블 이름을 굵게.
// 보이는 부분에 걸친 문장만 훑는다 (긴 콘솔에서도 가볍게).
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { splitStatements, type DialectRules } from '../../src/features/dbConsole/sql/statements';
import { tableRefs } from '../../src/features/dbConsole/sql/tableRefs';

const mark = Decoration.mark({ class: 'cm-tbl' });

function build(view: EditorView, rules: DialectRules): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  const vis = view.visibleRanges;
  if (!vis.length) return b.finish();
  const from = vis[0].from;
  const to = vis[vis.length - 1].to;
  for (const st of splitStatements(text, rules)) {
    if (st.end < from) continue;
    if (st.start > to) break;
    for (const r of tableRefs(st.sql, rules)) b.add(st.start + r.from, st.start + r.to, mark);
  }
  return b.finish();
}

export function tableNames(rules: () => DialectRules) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, rules());
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view, rules());
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/** DB 종류가 바뀌면(콘솔이 다른 연결로) 다시 그리게 */
export const tableNamesTheme = EditorView.baseTheme({
  '.cm-tbl': { fontWeight: '700' },
});
