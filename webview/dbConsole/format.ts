// SQL 정렬 (Shift+Alt+F): 선택 영역, 없으면 커서가 있는 문장을 보기 좋게 줄바꿈·들여쓰기.
// sql-formatter (MIT) 의 Oracle·PostgreSQL·MySQL 규칙만 묶는다. :name 과 MyBatis #{name}·${name} 은 그대로 둔다.
import { EditorView } from '@codemirror/view';
import { formatDialect, plsql, postgresql, mysql, type DialectOptions } from 'sql-formatter';
import { classify, splitStatements, statementAt, type DialectRules } from '../../src/features/dbConsole/sql/statements';

const DIALECTS: Record<string, DialectOptions> = { oracle: plsql, postgres: postgresql, mysql };

function formatOne(sqlText: string, kind: string, indent: string): string {
  return formatDialect(sqlText, {
    dialect: DIALECTS[kind] ?? plsql,
    keywordCase: 'upper',
    tabWidth: indent.length || 2,
    useTabs: indent === '\t',
    // 파라미터: :name, ?, $1 과 MyBatis 의 #{…}·${…}
    paramTypes: { named: [':'], positional: true, numbered: kind === 'postgres' ? ['$'] : [], custom: [{ regex: String.raw`[#$]\{[^}]+\}` }] },
  });
}

/**
 * 고른 범위의 문장들을 정렬한다. 문장 끝의 ; 와 문장 사이 빈 줄은 지킨다.
 * 정렬하지 못한 문장(PL/SQL 블록 등 규칙 밖)은 그대로 두고 수를 돌려준다
 */
export function formatSql(view: EditorView, kind: string, rules: DialectRules): { done: number; failed: number } {
  const { state } = view;
  const sel = state.selection.main;
  const doc = state.doc.toString();
  let from: number;
  let to: number;
  if (sel.empty) {
    const s = statementAt(doc, sel.head, rules);
    if (!s) return { done: 0, failed: 0 };
    from = s.start;
    to = s.start + s.sql.length;
  } else {
    from = sel.from;
    to = sel.to;
  }
  const part = doc.slice(from, to);
  const list = splitStatements(part, rules);
  const indent = ' '.repeat(2);
  let done = 0;
  let failed = 0;
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const s of list) {
    if (classify(s.sql, rules).kind === 'plsql') {
      failed++; // PL/SQL 블록은 건드리지 않는다
      continue;
    }
    try {
      const out = formatOne(s.sql, kind, indent);
      if (out !== s.sql) changes.push({ from: from + s.start, to: from + s.start + s.sql.length, insert: out });
      done++;
    } catch {
      failed++;
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
  return { done, failed };
}
