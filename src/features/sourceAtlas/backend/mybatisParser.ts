import { extractTables, stripSqlComments, TableUse } from './sqlTables';

export interface SqlStatement {
  namespace: string;
  id: string;
  type: 'select' | 'insert' | 'update' | 'delete';
  sql: string;
  tables: TableUse;
  file: string;
  line: number;
}
export interface MapperXml {
  namespace: string;
  file: string;
  statements: SqlStatement[];
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

/** MyBatis(iBATIS) 동적 SQL 태그를 걷어 내고 읽을 수 있는 SQL 한 덩어리로 만든다 */
function flatten(body: string, fragments: Map<string, string>, depth = 0): string {
  let s = body;
  if (depth < 4) {
    s = s.replace(/<include\b[^>]*refid\s*=\s*"([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/include>)/g, (_m, ref: string) => {
      const frag = fragments.get(ref) ?? fragments.get(ref.split('.').pop()!);
      return frag ? ` ${flatten(frag, fragments, depth + 1)} ` : ' ';
    });
  }
  // CDATA 내용은 그대로(< 기호 보존), 나머지 태그는 제거
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c.replace(/</g, '\u0001'));
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, ' ');
  s = decode(s.replace(/\u0001/g, '<'));
  return stripSqlComments(s).replace(/\s+/g, ' ').trim();
}

export function parseMapperXml(xml: string, file: string): MapperXml | null {
  const ns = xml.match(/<(?:mapper|sqlMap)\b[^>]*\bnamespace\s*=\s*"([^"]*)"/);
  if (!ns) return null;
  const namespace = ns[1];
  const fragments = new Map<string, string>();
  for (const m of xml.matchAll(/<sql\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/sql>/g)) fragments.set(m[1], m[2]);

  const statements: SqlStatement[] = [];
  for (const m of xml.matchAll(/<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1\s*>/g)) {
    const id = (m[2].match(/\bid\s*=\s*"([^"]+)"/) ?? [])[1];
    if (!id) continue;
    const sql = flatten(m[3], fragments);
    const type = m[1] as SqlStatement['type'];
    statements.push({
      namespace, id, type, sql, tables: extractTables(sql), file,
      line: xml.slice(0, m.index).split('\n').length,
    });
  }
  return { namespace, file, statements };
}

/** @Select("...") 같은 어노테이션 SQL: 문자열 리터럴을 이어 붙인다 */
export function sqlFromAnnotationArgs(args: string): string {
  return Array.from(args.matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((m) => m[1].replace(/\\"/g, '"')).join(' ').replace(/\s+/g, ' ').trim();
}
