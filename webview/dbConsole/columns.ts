// 칸 이름 자동 완성: "FROM TB_PART P" 처럼 쓴 뒤 "P." 를 치면 TB_PART 의 칸이 나오게.
// 별칭 풀이와 목록은 @codemirror/lang-sql 이 한다 (schema 에 칸을 넣어 주면 된다).
// 여기서는 칸을 아직 모르는 테이블을 찾아 확장에 물어보고, 받으면 목록을 다시 띄운다.
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { startCompletion } from '@codemirror/autocomplete';
import { statementAt, type DialectRules } from '../../src/features/dbConsole/sql/statements';

const IDENT = '[A-Za-z_\\u3131-\\uD79D][\\w$#\\u3131-\\uD79D]*';
/** FROM·JOIN·쉼표 뒤의 "테이블 [AS] 별칭" */
const SOURCE = new RegExp(`(?:\\bfrom\\b|\\bjoin\\b|,)\\s*(${IDENT}(?:\\.${IDENT})?)(?:\\s+(?:as\\s+)?(${IDENT}))?`, 'gi');
/** 별칭 자리에 올 수 없는 낱말 (테이블 바로 뒤에 오는 키워드) */
const NOT_ALIAS = new Set(
  'where on join left right inner outer full cross natural group order having union minus intersect except connect start fetch offset limit for using set values into partition sample with when then'.split(' ')
);

/** 문장 안에서 이름(별칭 또는 테이블)이 가리키는 테이블. 모르면 undefined */
export function tableFor(stmt: string, name: string): string | undefined {
  const want = name.toLowerCase();
  let table: string | undefined;
  for (const m of stmt.matchAll(SOURCE)) {
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? m[2] : undefined;
    if (alias?.toLowerCase() === want) return m[1];
    const bare = m[1].split('.').pop()!.toLowerCase();
    if (!table && (m[1].toLowerCase() === want || bare === want)) table = m[1];
  }
  return table;
}

export interface ColumnSource {
  /** 이 테이블의 칸을 알고 있나 (대소문자 무시) */
  has(table: string): boolean;
  /** 확장에 칸을 물어본다 (답은 나중에 columnsArrived 로) */
  request(table: string): void;
  rules(): DialectRules;
}

/** "이름." 을 치는 순간 그 이름이 가리키는 테이블의 칸을 미리 가져온다 */
export function columnLoader(src: ColumnSource): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    let typedDot = false;
    u.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
      if (inserted.toString().endsWith('.')) typedDot = true;
    });
    if (!typedDot) return;
    const pos = u.state.selection.main.head;
    const before = u.state.doc.sliceString(Math.max(0, pos - 128), pos);
    const m = new RegExp(`(${IDENT})\\.$`).exec(before);
    if (!m) return;
    const text = u.state.doc.toString();
    const stmt = statementAt(text, pos, src.rules());
    const table = tableFor(stmt?.sql ?? text, m[1]);
    if (table && !src.has(table)) src.request(table);
  });
}

/** 칸이 막 도착했다: 커서가 아직 "이름." 바로 뒤면 목록을 다시 띄운다 */
export function reopenIfAfterDot(view: EditorView) {
  const pos = view.state.selection.main.head;
  if (view.state.doc.sliceString(Math.max(0, pos - 1), pos) === '.') startCompletion(view);
}
