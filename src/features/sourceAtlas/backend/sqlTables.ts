/** SQL 문자열에서 읽는 테이블 / 쓰는 테이블을 뽑는다 (정규식 기반 · 서브쿼리/조인/콤마 FROM 대응). */
export interface TableUse {
  read: string[];
  write: string[];
}

const NAME = '[\\w.$#{}"`\\[\\]]+';
const NOT_TABLE = new Set([
  'dual', 'select', 'where', 'set', 'values', 'lateral', 'unnest', 'table', 'only', 'on', 'using', 'as', 'when', 'then', 'else', 'end',
]);
const STOP = /\b(where|group\s+by|order\s+by|having|union|minus|intersect|connect\s+by|start\s+with|limit|offset|fetch|for\s+update|set|values|returning|window)\b|\b(?:(?:inner|left|right|full|cross|natural)\s+(?:outer\s+)?)?join\b|[;]/i;

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function cleanName(raw: string): string | null {
  let n = raw.replace(/["`\[\]]/g, '').trim();
  n = n.replace(/\$\{[^}]*\}\./g, ''); // ${schema}.TABLE → TABLE
  n = n.split('.').pop()!;
  if (!n || NOT_TABLE.has(n.toLowerCase()) || /^\d/.test(n) || /^[#]\{/.test(n)) return null;
  return n;
}

export function extractTables(sqlRaw: string): TableUse {
  const sql = stripSqlComments(sqlRaw);
  const read = new Map<string, string>();
  const write = new Map<string, string>();
  const add = (m: Map<string, string>, raw: string) => {
    const n = cleanName(raw);
    if (n && !m.has(n.toLowerCase())) m.set(n.toLowerCase(), n);
  };

  // WITH 로 만든 임시 이름은 테이블이 아니다
  const cte = new Set<string>();
  for (const m of sql.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)(\w+)\s*(?:\([^)]*\)\s*)?as\s*\(/gi)) cte.add(m[1].toLowerCase());

  // 쓰기 대상
  const writeAt = new Set<number>();
  const writeRes = [
    /\binsert\s+(?:all\s+|ignore\s+)?into\s+(NAME)/gi,
    /(?<!\bfor\s)\bupdate\s+(?:only\s+)?(NAME)/gi,
    /\bdelete\s+(?:from\s+)?(NAME)/gi,
    /\bmerge\s+into\s+(NAME)/gi,
    /\btruncate\s+table\s+(NAME)/gi,
  ].map((r) => new RegExp(r.source.replace(/NAME/g, () => NAME), r.flags));
  for (const re of writeRes) {
    for (const m of sql.matchAll(re)) {
      if (!cte.has(m[1].toLowerCase())) add(write, m[1]);
      writeAt.add(m.index! + m[0].length - m[1].length);
    }
  }
  // delete from X 의 from 은 읽기가 아니다
  const deleteFrom = Array.from(sql.matchAll(/\bdelete\s+from\b/gi)).map((m) => m.index! + m[0].length);

  // FROM 목록 (콤마로 이어진 여러 테이블)
  for (const m of sql.matchAll(/\bfrom\b/gi)) {
    const end = m.index! + m[0].length;
    if (deleteFrom.includes(end)) continue;
    let rest = sql.slice(end);
    const stop = rest.search(STOP);
    if (stop >= 0) rest = rest.slice(0, stop);
    // 소괄호 안은 서브쿼리/함수: 최상위만 분리
    let depth = 0, cur = '';
    const items: string[] = [];
    for (const c of rest) {
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) { items.push(cur); cur = ''; } else if (depth === 0) cur += c;
    }
    items.push(cur);
    for (const it of items) {
      const t = it.trim();
      if (!t || t.startsWith('(')) continue;
      const first = t.match(new RegExp(`^(${NAME})(\\s*\\()?`));
      if (first && !first[2] && !cte.has(first[1].toLowerCase())) add(read, first[1]);
    }
  }
  // JOIN
  for (const m of sql.matchAll(new RegExp(`\\bjoin\\s+(${NAME})(\\s*\\()?`, 'gi'))) {
    if (!m[2] && !cte.has(m[1].toLowerCase())) add(read, m[1]);
  }
  return { read: [...read.values()], write: [...write.values()] };
}
