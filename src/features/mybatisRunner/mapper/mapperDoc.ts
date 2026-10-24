import { parseXml, XmlElement, lineIndex } from './xml';

/** mapper XML 하나를 읽은 결과 (vscode 의존 없음) */
export type StatementType = 'select' | 'insert' | 'update' | 'delete';

export interface MapperStatement {
  id: string;
  type: StatementType;
  el: XmlElement;
  /** 1부터 시작하는 줄 번호 (여는 태그 위치) */
  line: number;
  parameterType?: string;
  resultMap?: string;
  resultType?: string;
}

export interface MapperDoc {
  file: string;
  namespace: string;
  /** iBATIS 2 (<sqlMap>) 인지 */
  legacy: boolean;
  statements: MapperStatement[];
  /** <sql id> 조각: id → element */
  fragments: Map<string, XmlElement>;
  /** <resultMap id> */
  resultMaps: Map<string, XmlElement>;
  src: string;
  pos: (offset: number) => { line: number; col: number };
}

const STATEMENT_TAGS = new Set(['select', 'insert', 'update', 'delete']);

/** MyBatis mapper 처럼 보이는지 빠르게 판단 (CodeLens 를 붙일지 결정용) */
export function looksLikeMapper(src: string): boolean {
  return /<(mapper|sqlMap)\b[^>]*\bnamespace\s*=/.test(src);
}

export function parseMapper(src: string, file = ''): MapperDoc | null {
  if (!looksLikeMapper(src)) {
    return null;
  }
  const root = parseXml(src);
  const top = root.children.find(
    (c): c is XmlElement => c.kind === 'element' && (c.name === 'mapper' || c.name === 'sqlMap')
  );
  if (!top) {
    return null;
  }
  const pos = lineIndex(src);
  const doc: MapperDoc = {
    file,
    namespace: top.attrs.namespace ?? '',
    legacy: top.name === 'sqlMap',
    statements: [],
    fragments: new Map(),
    resultMaps: new Map(),
    src,
    pos,
  };
  for (const c of top.children) {
    if (c.kind !== 'element') continue;
    const id = c.attrs.id;
    if (!id) continue;
    if (STATEMENT_TAGS.has(c.name)) {
      doc.statements.push({
        id,
        type: c.name as StatementType,
        el: c,
        line: pos(c.start).line,
        parameterType: c.attrs.parameterType ?? c.attrs.parameterClass,
        resultMap: c.attrs.resultMap,
        resultType: c.attrs.resultType ?? c.attrs.resultClass,
      });
    } else if (c.name === 'sql') {
      doc.fragments.set(id, c);
    } else if (c.name === 'resultMap') {
      doc.resultMaps.set(id, c);
    }
  }
  return doc;
}

/** 커서 위치(offset)를 감싸는 statement. 없으면 바로 위의 statement */
export function statementAt(doc: MapperDoc, offset: number): MapperStatement | undefined {
  let before: MapperStatement | undefined;
  for (const s of doc.statements) {
    if (offset >= s.el.start && offset <= s.el.end) return s;
    if (s.el.start <= offset) before = s;
  }
  return before;
}
