// 편집기: FROM·JOIN·UPDATE·INTO 뒤의 테이블 이름(굵게)과 그 별칭에 색 (한 가지 색 — 키워드·문자열 색과 겹치지 않는 청록).
// 보이는 부분에 걸친 문장만 훑는다 (긴 콘솔에서도 가볍게).
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { splitStatements, type DialectRules } from '../../src/features/dbConsole/sql/statements';
import { aliasRefs, tableRefs } from '../../src/features/dbConsole/sql/tableRefs';

const mark = Decoration.mark({ class: 'cm-tbl' });
const aliasMark = Decoration.mark({ class: 'cm-tbl-alias' });

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
    const refs = tableRefs(st.sql, rules);
    // 테이블 이름과 별칭을 자리 순서대로 섞어 넣는다 (RangeSetBuilder 는 순서대로만 받는다)
    const all = [...refs.map((r) => ({ from: r.from, to: r.to, d: mark })), ...aliasRefs(st.sql, rules, refs).map((r) => ({ ...r, d: aliasMark }))];
    all.sort((x, y) => x.from - y.from);
    for (const r of all) b.add(st.start + r.from, st.start + r.to, r.d);
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

/** 색은 console.css (VS Code 밝은·어두운 테마에 맞춰) */
export const tableNamesTheme = EditorView.baseTheme({
  '.cm-tbl': { fontWeight: '700' },
});
