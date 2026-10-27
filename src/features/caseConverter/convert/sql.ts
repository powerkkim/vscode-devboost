/**
 * SQL(SELECT 목록 · INSERT 컬럼 · CREATE TABLE · 컬럼 이름 목록 · 테이블 이름) → Java 필드.
 * MyBatis mapper XML 조각도 그대로 받는다 (동적 태그·CDATA·`<include>` 처리).
 * vscode 에 의존하지 않는 순수 로직.
 */
import { toCamel, toSnake } from './words';

/** 가져온 스키마(.devboost/schema)에서 컬럼 타입을 찾는 통로. 없으면 이름으로 추정 */
export interface SchemaLookup {
  column(table: string, column: string): { typeText: string; comment?: string } | undefined;
  columns(table: string): { name: string; typeText: string; comment?: string }[] | undefined;
}

export interface JavaField {
  name: string;
  column: string;
  type: string;
  comment?: string;
  /** 스키마·DDL 에서 확인한 타입이 아니라 이름으로 추정한 경우 */
  guessed: boolean;
}

export type DateType = 'LocalDateTime' | 'Date';

export interface SqlOptions {
  dateType: DateType;
  lookup?: SchemaLookup;
  /** mapper XML 전체 — `<include refid>` 를 같은 파일의 `<sql>` 로 풀 때 */
  fullXml?: string;
}

export interface SqlConversion {
  kind: 'select' | 'insert' | 'ddl' | 'columns' | 'table';
  table?: string;
  fields: JavaField[];
  warnings: string[];
  /** 필요한 import (java.time.LocalDateTime …) */
  imports: string[];
}

/* ------------------------------------------------------------------ 글 다듬기 */

/** 문자열·주석을 같은 길이의 공백으로 바꾼 사본 (키워드·괄호 위치 찾기용) */
export function maskSql(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '-' && n === '-') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const end = Math.min(j + 1, src.length);
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function depthMap(masked: string): Int32Array {
  const d = new Int32Array(masked.length + 1);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    d[i] = depth;
    const c = masked[i];
    if (c === '(' || c === '{') depth++;
    else if ((c === ')' || c === '}') && depth > 0) depth--;
  }
  d[masked.length] = depth;
  return d;
}

/** 괄호 깊이 0 에서 처음 나오는 키워드 위치 (없으면 -1) */
function findKeyword(masked: string, depth: Int32Array, kw: string, from = 0): number {
  const re = new RegExp(`\\b${kw}\\b`, 'gi');
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    if (depth[m.index] === 0) return m.index;
  }
  return -1;
}

export interface Segment {
  text: string;
  comment?: string;
}

/** 괄호 밖의 쉼표로 나눔. 줄 끝 주석(`-- 설명`)은 같은 줄의 항목에 붙인다 */
export function splitTopLevel(src: string): Segment[] {
  const segs: Segment[] = [];
  let cur = '';
  let comment = '';
  let depth = 0;
  let newlineSinceSep = false;
  let i = 0;

  const push = () => {
    segs.push({ text: cur.trim(), comment: comment.trim() || undefined });
    cur = '';
    comment = '';
    newlineSinceSep = false;
  };
  const addComment = (text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (cur.trim() === '' && segs.length > 0 && !newlineSinceSep) {
      const prev = segs[segs.length - 1];
      prev.comment = prev.comment ? `${prev.comment} ${t}` : t;
    } else {
      comment = comment ? `${comment} ${t}` : t;
    }
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '-' && n === '-') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      addComment(src.slice(i + 2, end));
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const body = src.slice(i + 2, e < 0 ? src.length : e);
      if (!body.startsWith('+')) addComment(body);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    if (c === '(' || c === '{') depth++;
    else if ((c === ')' || c === '}') && depth > 0) depth--;
    if (c === ',' && depth === 0) {
      push();
      i++;
      continue;
    }
    if (c === '\n') newlineSinceSep = true;
    cur += c;
    i++;
  }
  if (cur.trim() || comment) push();
  return segs.filter((s) => s.text);
}

/** mapper XML 조각 → 순수 SQL (include 풀기, CDATA 펼치기, 태그·주석 제거) */
export function prepareSql(text: string, fullXml: string | undefined, warnings: string[]): string {
  let t = text;
  const unresolved = new Set<string>();
  for (let round = 0; round < 5; round++) {
    let changed = false;
    t = t.replace(/<include\s+refid\s*=\s*["']([^"']+)["']\s*(?:\/>|>[\s\S]*?<\/include>)/g, (whole, ref: string) => {
      const id = ref.slice(ref.lastIndexOf('.') + 1);
      const body = fullXml ? findSqlFragment(fullXml, id) : undefined;
      if (body === undefined) {
        unresolved.add(ref);
        return ' ';
      }
      changed = true;
      return ` ${body} `;
    });
    if (!changed) break;
  }
  for (const ref of unresolved) {
    warnings.push(`<include refid="${ref}"> 조각을 찾지 못해 빠졌습니다 (다른 파일이면 조각 내용을 함께 선택하세요)`);
  }
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<\/?[A-Za-z][\w:-]*(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g, ' ');
  return t;
}

function findSqlFragment(xml: string, id: string): string | undefined {
  const re = new RegExp(`<sql\\s+[^>]*\\bid\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)</sql>`);
  const m = re.exec(xml);
  return m ? m[1] : undefined;
}

/* ------------------------------------------------------------------ 타입 */

const BASE_CHAR = new Set([
  'char', 'varchar', 'varchar2', 'nvarchar', 'nvarchar2', 'nchar', 'text', 'tinytext', 'mediumtext', 'longtext',
  'clob', 'nclob', 'character', 'character varying', 'string', 'uuid', 'json', 'jsonb', 'xml', 'rowid', 'urowid',
  'long', 'bpchar', 'enum', 'set',
]);
const BASE_BINARY = new Set(['blob', 'raw', 'long raw', 'bytea', 'binary', 'varbinary', 'image', 'tinyblob', 'mediumblob', 'longblob', 'bfile']);

export function parseSqlType(typeText: string): { base: string; precision?: number; scale?: number } {
  const args = /\(\s*(\d+)\s*(?:,\s*(-?\d+))?/.exec(typeText);
  const base = typeText.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return {
    base,
    precision: args ? Number(args[1]) : undefined,
    scale: args && args[2] !== undefined ? Number(args[2]) : undefined,
  };
}

/** DB 컬럼 타입 → Java 타입 */
export function sqlTypeToJava(typeText: string, dateType: DateType): string {
  const { base, precision: p, scale: s } = parseSqlType(typeText);
  if (BASE_CHAR.has(base)) return 'String';
  if (BASE_BINARY.has(base)) return 'byte[]';
  if (base.startsWith('timestamp') || base.startsWith('datetime') || base === 'date' || base === 'smalldatetime') {
    return dateType;
  }
  if (base.startsWith('time')) return 'LocalTime';
  if (base === 'bool' || base === 'boolean' || base === 'bit') return 'Boolean';
  if (base === 'tinyint') return p === 1 ? 'Boolean' : 'Integer';
  if (['smallint', 'int', 'integer', 'mediumint', 'serial', 'smallserial', 'int2', 'int4'].includes(base)) return 'Integer';
  if (['bigint', 'bigserial', 'int8'].includes(base)) return 'Long';
  if (['float', 'double', 'double precision', 'real', 'binary_float', 'binary_double', 'float4', 'float8'].includes(base)) return 'Double';
  if (['number', 'numeric', 'decimal', 'dec', 'money', 'smallmoney'].includes(base)) {
    if (s !== undefined && s > 0) return 'BigDecimal';
    if (p === undefined) return base === 'number' ? 'Long' : 'BigDecimal';
    if (p > 18) return 'BigDecimal';
    return p > 9 ? 'Long' : 'Integer';
  }
  return 'Object';
}

/** 스키마 없이 이름만으로 타입 추정 */
export function guessJavaType(column: string, dateType: DateType): string {
  const c = toSnake(column);
  if (/(^|_)(dt|date|datetime|at|time|ts|dttm)$/.test(c) || /^(date|dt)_/.test(c)) return dateType;
  if (/(^|_)(yn|flag|cd|code|no|nm|name)$/.test(c)) return 'String';
  if (/^is_/.test(c)) return 'Boolean';
  if (c === 'id' || /_id$/.test(c) || /(^|_)(cnt|count|seq|qty|ord|sort|rank|total|num)$/.test(c)) return 'Long';
  if (/(^|_)(amt|amount|price|rate|ratio|pct|percent|weight|balance)$/.test(c)) return 'BigDecimal';
  return 'String';
}

const IMPORT_OF: Record<string, string> = {
  LocalDateTime: 'java.time.LocalDateTime',
  LocalDate: 'java.time.LocalDate',
  LocalTime: 'java.time.LocalTime',
  Date: 'java.util.Date',
  BigDecimal: 'java.math.BigDecimal',
};

export function importsFor(types: string[]): string[] {
  const set = new Set<string>();
  for (const t of types) {
    for (const name of t.split(/[^\w]+/)) {
      if (IMPORT_OF[name]) set.add(IMPORT_OF[name]);
    }
  }
  return [...set].sort();
}

/* ------------------------------------------------------------------ 컬럼 해석 */

interface TableRef {
  name: string;
  alias?: string;
}

const RESERVED_ALIAS = new Set([
  'on', 'using', 'where', 'group', 'order', 'having', 'union', 'minus', 'intersect', 'connect', 'start', 'fetch',
  'limit', 'offset', 'for', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'join', 'outer', 'set', 'values',
]);

const unquote = (s: string) => s.replace(/^["`]|["`]$/g, '');
const lastPart = (s: string) => unquote(s.slice(s.lastIndexOf('.') + 1));

/** FROM 절의 테이블과 별칭 */
function parseTables(masked: string, depth: Int32Array, fromIdx: number): TableRef[] {
  if (fromIdx < 0) return [];
  let end = masked.length;
  for (const kw of ['where', 'group', 'order', 'having', 'connect', 'start', 'union', 'minus', 'intersect', 'fetch', 'limit', 'offset']) {
    const i = findKeyword(masked, depth, kw, fromIdx + 4);
    if (i >= 0 && i < end) end = i;
  }
  let clause = masked.slice(fromIdx + 4, end);
  clause = clause.replace(/\b(?:natural\s+)?(?:(?:inner|left|right|full|cross)\s+)?(?:outer\s+)?join\b/gi, ',');
  const refs: TableRef[] = [];
  for (const seg of splitTopLevel(clause)) {
    const cut = seg.text.split(/\s+(?:on|using)\b/i)[0].trim();
    const m = /^([\w$#."`]+)(?:\s+(?:as\s+)?([A-Za-z_][\w$#]*))?$/i.exec(cut);
    if (!m) continue;
    const alias = m[2] && !RESERVED_ALIAS.has(m[2].toLowerCase()) ? m[2] : undefined;
    refs.push({ name: lastPart(m[1]), alias });
  }
  return refs;
}

interface ColumnExpr {
  /** 필드 이름의 바탕 (별칭 또는 컬럼명) */
  name?: string;
  expr: string;
  qualifier?: string;
  column?: string;
  star?: boolean;
  comment?: string;
}

const PLAIN_COLUMN = /^(?:([\w$#"`]+)\.)?([\p{L}_][\p{L}\p{N}_$#]*|"[^"]+"|`[^`]+`)$/u;
const ALIAS_AS = /^(.*\S)\s+as\s+("[^"]+"|`[^`]+`|[\p{L}_][\p{L}\p{N}_$#]*)$/isu;
const ALIAS_BARE = /^(.*\S)\s+("[^"]+"|`[^`]+`|[\p{L}_][\p{L}\p{N}_$#]*)$/su;

function deriveColumn(seg: Segment): ColumnExpr {
  const t = seg.text.replace(/\s+/g, ' ').trim();
  if (t === '*') return { expr: t, star: true, comment: seg.comment };
  const star = /^([\w$#"`]+)\.\*$/.exec(t);
  if (star) return { expr: t, star: true, qualifier: unquote(star[1]), comment: seg.comment };

  let expr = t;
  let alias: string | undefined;
  let m = ALIAS_AS.exec(t);
  if (m) {
    expr = m[1];
    alias = unquote(m[2]);
  } else {
    m = ALIAS_BARE.exec(t);
    if (m && !/[+\-*/|<>=(,]$/.test(m[1].trim()) && !/^(end|null|then|else|and|or|not|distinct|is|in|like|between)$/i.test(m[2])) {
      expr = m[1];
      alias = unquote(m[2]);
    }
  }
  const plain = PLAIN_COLUMN.exec(expr.trim());
  const out: ColumnExpr = { expr, comment: seg.comment };
  if (plain) {
    out.qualifier = plain[1] ? unquote(plain[1]) : undefined;
    out.column = unquote(plain[2]);
  }
  out.name = alias ?? out.column;
  return out;
}

function stripSelectPrefix(text: string): string {
  return text
    .replace(/^\s*(?:distinct|unique|all)\b\s*/i, '')
    .replace(/^\s*top\s+\d+\s*(?:percent\s*)?/i, '');
}

function typeForExpression(expr: string, name: string, dateType: DateType): { type: string; guessed: boolean } {
  if (/^\s*count\s*\(/i.test(expr)) return { type: 'Long', guessed: false };
  if (/^\s*(?:to_char|substr|concat|listagg|upper|lower|trim)\s*\(/i.test(expr)) return { type: 'String', guessed: false };
  if (/^\s*(?:sysdate|systimestamp|current_timestamp|now\s*\(\s*\))\s*$/i.test(expr)) return { type: dateType, guessed: false };
  return { type: guessJavaType(name, dateType), guessed: true };
}

/* ------------------------------------------------------------------ 입력 종류별 변환 */

function makeField(
  column: string,
  typeInfo: { type: string; guessed: boolean },
  comment: string | undefined
): JavaField {
  return { name: toCamel(column), column, type: typeInfo.type, comment, guessed: typeInfo.guessed };
}

function fromSelect(sql: string, opts: SqlOptions, warnings: string[]): SqlConversion | undefined {
  const masked = maskSql(sql);
  const depth = depthMap(masked);
  const selIdx = findKeyword(masked, depth, 'select');
  if (selIdx < 0) return undefined;
  const fromIdx = findKeyword(masked, depth, 'from', selIdx + 6);
  const listText = stripSelectPrefix(sql.slice(selIdx + 6, fromIdx < 0 ? sql.length : fromIdx));
  const tables = parseTables(masked, depth, fromIdx);
  const lookup = opts.lookup;

  const resolveTable = (qualifier: string | undefined, column: string | undefined): string | undefined => {
    if (qualifier) {
      const q = qualifier.toLowerCase();
      const hit = tables.find((t) => t.alias?.toLowerCase() === q) ?? tables.find((t) => t.name.toLowerCase() === q);
      return hit?.name;
    }
    if (tables.length === 1) return tables[0].name;
    if (lookup && column) {
      return tables.find((t) => lookup.column(t.name, column))?.name;
    }
    return undefined;
  };

  const fields: JavaField[] = [];
  for (const seg of splitTopLevel(listText)) {
    const col = deriveColumn(seg);
    if (col.star) {
      const targets = col.qualifier ? [resolveTable(col.qualifier, undefined)] : tables.map((t) => t.name);
      let expanded = false;
      for (const tn of targets) {
        const cols = tn && lookup?.columns(tn);
        if (!cols) continue;
        expanded = true;
        for (const c of cols) {
          fields.push(makeField(c.name, { type: sqlTypeToJava(c.typeText, opts.dateType), guessed: false }, c.comment));
        }
      }
      if (!expanded) {
        warnings.push(`${col.expr} 는 컬럼을 알 수 없어 빠졌습니다 — DB 스키마를 가져오면 펼쳐집니다`);
      }
      continue;
    }
    if (!col.name) {
      warnings.push(`이름을 알 수 없는 식이라 빠졌습니다: ${col.expr.length > 50 ? col.expr.slice(0, 50) + '…' : col.expr} — 별칭(AS 이름)을 붙이면 필드가 됩니다`);
      continue;
    }
    let info: { type: string; guessed: boolean } | undefined;
    let comment = col.comment;
    if (col.column) {
      const tn = resolveTable(col.qualifier, col.column);
      const meta = tn && lookup?.column(tn, col.column);
      if (meta) {
        info = { type: sqlTypeToJava(meta.typeText, opts.dateType), guessed: false };
        comment = comment ?? meta.comment;
      }
    }
    info = info ?? typeForExpression(col.expr, col.name, opts.dateType);
    fields.push(makeField(col.name, info, comment));
  }
  return { kind: 'select', table: tables[0]?.name, fields, warnings, imports: [] };
}

function fromInsert(sql: string, opts: SqlOptions, warnings: string[]): SqlConversion | undefined {
  const masked = maskSql(sql);
  const m = /\binsert\s+(?:all\s+)?into\s+([\w$#."`]+)\s*\(/i.exec(masked);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  const depth = depthMap(masked);
  let close = open + 1;
  while (close < masked.length && !(masked[close] === ')' && depth[close] === depth[open] + 1)) close++;
  const table = lastPart(m[1]);
  const fields: JavaField[] = [];
  for (const seg of splitTopLevel(sql.slice(open + 1, close))) {
    const name = unquote(seg.text.trim());
    if (!/^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(name)) continue;
    const meta = opts.lookup?.column(table, name);
    const info = meta
      ? { type: sqlTypeToJava(meta.typeText, opts.dateType), guessed: false }
      : { type: guessJavaType(name, opts.dateType), guessed: true };
    fields.push(makeField(name, info, seg.comment ?? meta?.comment));
  }
  return { kind: 'insert', table, fields, warnings, imports: [] };
}

function fromDdl(sql: string, opts: SqlOptions, warnings: string[]): SqlConversion | undefined {
  const masked = maskSql(sql);
  const m = /\bcreate\s+(?:or\s+replace\s+)?(?:global\s+temporary\s+|temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w$#."`]+)\s*\(/i.exec(masked);
  if (!m) return undefined;
  const open = m.index + m[0].length - 1;
  const depth = depthMap(masked);
  let close = open + 1;
  while (close < masked.length && !(masked[close] === ')' && depth[close] === depth[open] + 1)) close++;
  const table = lastPart(m[1]);

  // Oracle: COMMENT ON COLUMN 테이블.컬럼 IS '설명'
  const comments = new Map<string, string>();
  for (const c of sql.matchAll(/comment\s+on\s+column\s+[\w$#."`]+?\.("[^"]+"|`[^`]+`|[\w$#]+)\s+is\s+'((?:[^']|'')*)'/gi)) {
    comments.set(unquote(c[1]).toLowerCase(), c[2].replace(/''/g, "'"));
  }

  const fields: JavaField[] = [];
  for (const seg of splitTopLevel(sql.slice(open + 1, close))) {
    const t = seg.text.replace(/\s+/g, ' ').trim();
    const cm = /^("[^"]+"|`[^`]+`|[\p{L}_][\p{L}\p{N}_$#]*)\s+(.+)$/su.exec(t);
    if (!cm) continue;
    if (!/^["`]/.test(cm[1]) && /^(constraint|primary|unique|foreign|key|index|check|fulltext|spatial|partition|period)$/i.test(cm[1])) continue;
    const name = unquote(cm[1]);
    const tm = /^([A-Za-z_]\w*(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone|unsigned))*)(?:\s*\(\s*[^)]*\))?/i.exec(cm[2]);
    if (!tm) continue;
    const typeText = tm[0];
    const inline = /\bcomment\s+'((?:[^']|'')*)'/i.exec(cm[2]);
    const comment = inline ? inline[1].replace(/''/g, "'") : (seg.comment ?? comments.get(name.toLowerCase()));
    fields.push(makeField(name, { type: sqlTypeToJava(typeText, opts.dateType), guessed: false }, comment));
  }
  return { kind: 'ddl', table, fields, warnings, imports: [] };
}

function fromNames(text: string, opts: SqlOptions, warnings: string[]): SqlConversion | undefined {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (!tokens.every((t) => /^(?:[\w$#"`]+\.)?[\p{L}_][\p{L}\p{N}_$#]*$|^"[^"]+"$|^`[^`]+`$/u.test(t))) return undefined;

  if (tokens.length === 1 && opts.lookup) {
    const table = lastPart(tokens[0]);
    const cols = opts.lookup.columns(table);
    if (cols) {
      const fields = cols.map((c) => makeField(c.name, { type: sqlTypeToJava(c.typeText, opts.dateType), guessed: false }, c.comment));
      return { kind: 'table', table, fields, warnings, imports: [] };
    }
  }
  const fields = tokens.map((t) => {
    const name = lastPart(t);
    return makeField(name, { type: guessJavaType(name, opts.dateType), guessed: true }, undefined);
  });
  return { kind: 'columns', fields, warnings, imports: [] };
}

/** 입력(SQL / mapper XML 조각 / 컬럼 이름 목록 / 테이블 이름) → Java 필드 목록 */
export function sqlToJavaFields(input: string, opts: SqlOptions): SqlConversion {
  const warnings: string[] = [];
  const sql = prepareSql(input, opts.fullXml, warnings);
  const masked = maskSql(sql);

  let result: SqlConversion | undefined;
  if (/\bcreate\s+(?:or\s+replace\s+)?(?:global\s+temporary\s+|temporary\s+)?table\b/i.test(masked)) {
    result = fromDdl(sql, opts, warnings);
  } else if (/^\s*insert\b/i.test(masked)) {
    result = fromInsert(sql, opts, warnings);
  } else if (/\bselect\b/i.test(masked)) {
    result = fromSelect(sql, opts, warnings);
  }
  result = result ?? fromNames(sql, opts, warnings);
  if (!result) {
    return { kind: 'columns', fields: [], warnings: [...warnings, 'SELECT 목록·INSERT 컬럼·CREATE TABLE·컬럼 이름 목록 중 어느 것인지 알아보지 못했습니다'], imports: [] };
  }

  // 같은 이름이 두 번 나오면 뒤쪽을 구분
  const seen = new Map<string, number>();
  for (const f of result.fields) {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    if (n > 1) {
      warnings.push(`필드 이름 ${f.name} 이(가) 겹쳐 ${f.name}${n} 으로 바꿨습니다`);
      f.name = `${f.name}${n}`;
    }
  }
  result.imports = importsFor(result.fields.map((f) => f.type));
  return result;
}

/** Java 필드 목록 → 소스 텍스트 */
export function renderJavaFields(fields: JavaField[], indent = '    '): string {
  const lines: string[] = [];
  for (const f of fields) {
    if (f.comment) lines.push(`${indent}/** ${f.comment.replace(/\*\//g, '* /')} */`);
    lines.push(`${indent}private ${f.type} ${f.name};`);
  }
  return lines.join('\n');
}

/** mapper XML 에서 커서 위치(offset)를 감싼 select/insert/update/delete/sql 블록 */
export function statementAt(xml: string, offset: number): { id?: string; tag: string; body: string } | undefined {
  const re = /<(select|insert|update|delete|sql)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (offset >= m.index && offset <= m.index + m[0].length) {
      const id = /\bid\s*=\s*["']([^"']+)["']/.exec(m[2]);
      return { id: id?.[1], tag: m[1], body: m[3] };
    }
  }
  return undefined;
}
