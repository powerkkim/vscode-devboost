/**
 * Java 필드(클래스·record) → TypeScript 인터페이스, MyBatis SQL(SELECT·INSERT·UPDATE·resultMap).
 * vscode 에 의존하지 않는 순수 로직.
 */
import { toSnake } from './words';

export interface JField {
  name: string;
  type: string;
  comment?: string;
}

export interface JClass {
  name?: string;
  fields: JField[];
  warnings: string[];
}

/* ------------------------------------------------------------------ 파싱 */

const MODIFIERS = new Set(['public', 'private', 'protected', 'final', 'transient', 'volatile', 'static']);

/** 공백으로 나누되 <> () [] 안은 나누지 않음 */
function splitSpaces(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of s) {
    if (c === '<' || c === '(' || c === '[') depth++;
    else if ((c === '>' || c === ')' || c === ']') && depth > 0) depth--;
    if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function cleanComment(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*\*+\s?/, '').replace(/^\s*\/\/+\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'))
    .join(' ')
    .trim();
}

/** 필드 선언 한 줄(`private Long id` 등, 세미콜론 앞까지) → 필드. 필드가 아니면 undefined */
function parseDeclaration(decl: string): { name: string; type: string } | undefined {
  // 초기값 제거 (괄호·꺾쇠 밖의 첫 `=`)
  let depth = 0;
  let cut = decl.length;
  for (let i = 0; i < decl.length; i++) {
    const c = decl[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if ((c === '>' || c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    else if (c === '=' && depth === 0) {
      cut = i;
      break;
    }
  }
  const head = decl.slice(0, cut).trim();
  if (!head || /^(?:import|package)\b/.test(head)) return undefined;
  const tokens = splitSpaces(head);
  if (tokens.some((t) => t === 'static')) return undefined;
  const rest = tokens.filter((t) => !MODIFIERS.has(t));
  if (rest.length < 2) return undefined;
  let name = rest[rest.length - 1];
  let type = rest.slice(0, -1).join(' ');
  // `String name[]` 형태
  const arr = /^(\w+)((?:\[\])+)$/.exec(name);
  if (arr) {
    name = arr[1];
    type += arr[2];
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  if (name.includes('(') || type.includes('(')) return undefined;
  if (/^(?:return|throw|new|else|case|package|import|class|interface|enum|record)$/.test(type.split(/\s/)[0])) return undefined;
  return { name, type: type.replace(/\s+/g, ' ').trim() };
}

/** 본문(클래스의 `{ }` 안쪽)에서 필드 선언 수집 */
function collectFields(body: string): JField[] {
  const fields: JField[] = [];
  let buf = '';
  let pending = '';
  let i = 0;
  const n = body.length;

  while (i < n) {
    const c = body[i];
    const c2 = body[i + 1];

    if (c === '/' && c2 === '*') {
      const e = body.indexOf('*/', i + 2);
      const end = e < 0 ? n : e;
      const raw = body.slice(i + 2, end);
      if (body[i + 2] === '*') pending = cleanComment(raw);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '/' && c2 === '/') {
      const e = body.indexOf('\n', i);
      const end = e < 0 ? n : e;
      if (buf.trim() === '') pending = pending ? `${pending} ${cleanComment(body.slice(i, end))}` : cleanComment(body.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
      buf += body.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '@' && /\s*$/.test(buf) && (buf.trim() === '' || /\s$/.test(buf))) {
      // 애노테이션 건너뜀: @Name 또는 @Name(...)
      let j = i + 1;
      while (j < n && /[\w.]/.test(body[j])) j++;
      let k = j;
      while (k < n && /\s/.test(body[k])) k++;
      if (body[k] === '(') {
        let d = 0;
        for (; k < n; k++) {
          if (body[k] === '"') {
            k++;
            while (k < n && body[k] !== '"') k += body[k] === '\\' ? 2 : 1;
          } else if (body[k] === '(') d++;
          else if (body[k] === ')') {
            d--;
            if (d === 0) {
              k++;
              break;
            }
          }
        }
        j = k;
      }
      i = j;
      continue;
    }
    if (c === '{') {
      // 메서드·초기화 블록·내부 클래스 본문은 통째로 건너뜀
      let d = 0;
      let j = i;
      for (; j < n; j++) {
        if (body[j] === '"') {
          j++;
          while (j < n && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
        } else if (body[j] === '{') d++;
        else if (body[j] === '}') {
          d--;
          if (d === 0) {
            j++;
            break;
          }
        }
      }
      i = j;
      buf = '';
      pending = '';
      continue;
    }
    if (c === ';') {
      const decl = buf.trim();
      buf = '';
      i++;
      const f = decl ? parseDeclaration(decl) : undefined;
      if (f) {
        let comment = pending;
        // 같은 줄 뒤쪽 주석: `private String name; // 이름`
        const tail = /^[ \t]*(?:\/\/([^\n]*)|\/\*\*?([\s\S]*?)\*\/)/.exec(body.slice(i));
        if (tail) {
          const t = cleanComment(tail[1] ?? tail[2] ?? '');
          if (t && !comment) comment = t;
          i += tail[0].length;
        }
        fields.push({ ...f, comment: comment || undefined });
      }
      pending = '';
      continue;
    }
    buf += c;
    i++;
  }
  return fields;
}

/** Java 소스(클래스 전체 · record · 필드 몇 줄) → 클래스 이름과 필드 목록 */
export function parseJavaFields(src: string): JClass {
  const warnings: string[] = [];
  const decl = /\b(class|record|interface|enum)\s+([A-Za-z_$][\w$]*)\s*(?:<[^{(]*>)?\s*(\()?/.exec(src);

  if (decl && decl[1] === 'record' && decl[3]) {
    // record User(Long id, String name) {}
    const open = decl.index + decl[0].length - 1;
    let d = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '(') d++;
      else if (src[close] === ')') {
        d--;
        if (d === 0) break;
      }
    }
    const inner = src.slice(open + 1, close);
    const fields: JField[] = [];
    let part = '';
    let depth = 0;
    const flush = () => {
      const noAnno = part.replace(/@\w+(?:\([^)]*\))?\s*/g, '').trim();
      const f = noAnno ? parseDeclaration(noAnno) : undefined;
      if (f) fields.push(f);
      part = '';
    };
    for (const c of inner) {
      if (c === '<' || c === '(') depth++;
      else if ((c === '>' || c === ')') && depth > 0) depth--;
      if (c === ',' && depth === 0) flush();
      else part += c;
    }
    flush();
    return { name: decl[2], fields, warnings };
  }

  let body = src;
  if (decl && decl[1] !== 'enum') {
    const open = src.indexOf('{', decl.index);
    if (open >= 0) {
      let d = 0;
      let close = open;
      for (; close < src.length; close++) {
        if (src[close] === '{') d++;
        else if (src[close] === '}') {
          d--;
          if (d === 0) break;
        }
      }
      body = src.slice(open + 1, close);
    }
  }
  const fields = collectFields(body);
  if (fields.length === 0) warnings.push('필드(`private 타입 이름;`)를 찾지 못했습니다');
  return { name: decl?.[2], fields, warnings };
}

/* ------------------------------------------------------------------ Java 타입 → TypeScript */

export interface TsOptions {
  /** required: `name: string` · nullable: `name: string | null` · optional: `name?: string` */
  optional: 'required' | 'nullable' | 'optional';
  /** 날짜 필드: JSON 으로 오가는 문자열 그대로 or Date */
  dateType: 'string' | 'Date';
  /** Object·와일드카드 */
  objectType: 'any' | 'unknown';
}

interface TypeNode {
  name: string;
  args: TypeNode[];
  array: number;
}

function parseType(src: string): TypeNode {
  let s = src.trim().replace(/^(?:final\s+)/, '');
  let array = 0;
  while (s.endsWith('[]')) {
    array++;
    s = s.slice(0, -2).trim();
  }
  const lt = s.indexOf('<');
  if (lt < 0 || !s.endsWith('>')) return { name: s.slice(s.lastIndexOf('.') + 1), args: [], array };
  const name = s.slice(0, lt).trim();
  const inner = s.slice(lt + 1, -1);
  const args: TypeNode[] = [];
  let depth = 0;
  let cur = '';
  for (const c of inner) {
    if (c === '<') depth++;
    else if (c === '>') depth--;
    if (c === ',' && depth === 0) {
      args.push(parseType(cur));
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) args.push(parseType(cur));
  return { name: name.slice(name.lastIndexOf('.') + 1), args, array };
}

const TS_STRING = new Set(['String', 'char', 'Character', 'CharSequence', 'UUID', 'StringBuilder']);
const TS_NUMBER = new Set(['Long', 'Integer', 'Short', 'Byte', 'Double', 'Float', 'BigDecimal', 'BigInteger', 'Number', 'long', 'int', 'short', 'byte', 'double', 'float']);
const TS_BOOLEAN = new Set(['Boolean', 'boolean']);
const TS_DATE = new Set(['LocalDateTime', 'LocalDate', 'LocalTime', 'Date', 'Timestamp', 'Instant', 'ZonedDateTime', 'OffsetDateTime', 'OffsetTime', 'Calendar']);
const TS_LIST = new Set(['List', 'ArrayList', 'LinkedList', 'Set', 'HashSet', 'LinkedHashSet', 'TreeSet', 'Collection', 'Iterable', 'Stream']);
const TS_MAP = new Set(['Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'ConcurrentHashMap']);

function tsOf(node: TypeNode, opts: TsOptions): string {
  const any = opts.objectType;
  let base: string;
  const n = node.name;
  if (n === 'byte' && node.array > 0) {
    // byte[] 는 JSON 에서 base64 문자열
    return node.array > 1 ? `string${'[]'.repeat(node.array - 1)}` : 'string';
  }
  if (TS_STRING.has(n)) base = 'string';
  else if (TS_NUMBER.has(n)) base = 'number';
  else if (TS_BOOLEAN.has(n)) base = 'boolean';
  else if (TS_DATE.has(n)) base = opts.dateType;
  else if (n === 'Object' || n === '?' || n.startsWith('?')) base = any;
  else if (n === 'Optional' && node.args[0]) base = `${tsOf(node.args[0], opts)} | null`;
  else if (TS_LIST.has(n)) {
    const a = node.args[0] ? tsOf(node.args[0], opts) : any;
    base = /[|]/.test(a) ? `(${a})[]` : `${a}[]`;
  } else if (TS_MAP.has(n)) {
    const k = node.args[0] ? tsOf(node.args[0], opts) : 'string';
    const v = node.args[1] ? tsOf(node.args[1], opts) : any;
    base = `Record<${k === 'number' ? 'number' : 'string'}, ${v}>`;
  } else if (node.args.length > 0) {
    // 사용자 제네릭 (Page<User> → Page<User>)
    base = `${n}<${node.args.map((a) => tsOf(a, opts)).join(', ')}>`;
  } else base = n;
  const arr = '[]'.repeat(node.array);
  if (!arr) return base;
  return base.includes('|') ? `(${base})${arr}` : base + arr;
}

/** 자바 클래스·내장 타입이 아니라 직접 만든 타입(별도 interface 필요)인지 */
function customTypes(node: TypeNode, out: Set<string>) {
  const known = new Set([...TS_STRING, ...TS_NUMBER, ...TS_BOOLEAN, ...TS_DATE, ...TS_LIST, ...TS_MAP, 'Object', 'Optional', 'void', 'Void']);
  if (!known.has(node.name) && !node.name.startsWith('?') && /^[A-Z]/.test(node.name)) out.add(node.name);
  node.args.forEach((a) => customTypes(a, out));
}

export function javaTypeToTs(javaType: string, opts: TsOptions): string {
  return tsOf(parseType(javaType), opts);
}

export interface TsResult {
  text: string;
  /** 변환하지 못하고 이름만 옮긴, 직접 만든 타입 */
  referenced: string[];
}

export function javaToTs(cls: JClass, interfaceName: string, opts: TsOptions): TsResult {
  const refs = new Set<string>();
  const lines: string[] = [`export interface ${interfaceName} {`];
  for (const f of cls.fields) {
    const node = parseType(f.type);
    customTypes(node, refs);
    let ts = tsOf(node, opts);
    if (opts.optional === 'nullable' && !/\bnull\b/.test(ts)) ts += ' | null';
    if (f.comment) lines.push(`  /** ${f.comment.replace(/\*\//g, '* /')} */`);
    lines.push(`  ${f.name}${opts.optional === 'optional' ? '?' : ''}: ${ts};`);
  }
  lines.push('}');
  refs.delete(interfaceName);
  return { text: lines.join('\n'), referenced: [...refs].sort() };
}

/* ------------------------------------------------------------------ MyBatis SQL */

export type MyBatisPart = 'select' | 'insert' | 'update' | 'resultMap';

export interface MyBatisOptions {
  columnCase: 'lower' | 'upper';
  /** DB 설정 mapUnderscoreToCamelCase 가 켜져 있으면 별칭 없이 컬럼만 */
  mapUnderscore: boolean;
  tablePrefix: string;
  /** 줄바꿈 기준 글자 수 */
  width: number;
}

const col = (field: string, o: MyBatisOptions) => {
  const c = toSnake(field);
  return o.columnCase === 'upper' ? c.toUpperCase() : c;
};

/** 항목을 한 줄에 width 까지 채워 쉼표로 이어 붙임 */
function wrap(items: string[], indent: string, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  items.forEach((it, i) => {
    const piece = it + (i < items.length - 1 ? ',' : '');
    if (cur && indent.length + cur.length + 1 + piece.length > width) {
      lines.push(indent + cur);
      cur = piece;
    } else {
      cur = cur ? `${cur} ${piece}` : piece;
    }
  });
  if (cur) lines.push(indent + cur);
  return lines;
}

export function javaToMyBatis(cls: JClass, parts: MyBatisPart[], o: MyBatisOptions): string {
  const fields = cls.fields;
  const className = cls.name ?? 'Entity';
  const table = o.tablePrefix + (o.columnCase === 'upper' ? toSnake(className).toUpperCase() : toSnake(className));
  const idField = fields.find((f) => f.name === 'id') ?? fields[0];
  const out: string[] = [];

  for (const part of parts) {
    if (part === 'select') {
      const items = fields.map((f) => {
        const c = col(f.name, o);
        return !o.mapUnderscore && c.toLowerCase() !== f.name.toLowerCase() ? `${c} AS ${f.name}` : c;
      });
      const oneLine = `SELECT ${items.join(', ')}`;
      const head = oneLine.length <= o.width ? [oneLine] : ['SELECT ' + wrap(items, '       ', o.width).join('\n').trimStart()];
      out.push([...head, `  FROM ${table}`].join('\n'));
    } else if (part === 'insert') {
      const cols = fields.map((f) => col(f.name, o));
      const vals = fields.map((f) => `#{${f.name}}`);
      out.push(
        [`INSERT INTO ${table} (`, ...wrap(cols, '    ', o.width), ') VALUES (', ...wrap(vals, '    ', o.width), ')'].join('\n')
      );
    } else if (part === 'update') {
      const sets = fields.filter((f) => f !== idField).map((f) => `${col(f.name, o)} = #{${f.name}}`);
      const setLines = sets.map((s, i) => (i === 0 ? `   SET ${s}` : `       ${s}`) + (i < sets.length - 1 ? ',' : ''));
      out.push([`UPDATE ${table}`, ...setLines, ` WHERE ${col(idField.name, o)} = #{${idField.name}}`].join('\n'));
    } else if (part === 'resultMap') {
      const rows = fields.map((f) => `    <${f === idField && f.name === 'id' ? 'id' : 'result'} column="${col(f.name, o)}" property="${f.name}"/>`);
      const mapId = className.charAt(0).toLowerCase() + className.slice(1) + 'ResultMap';
      out.push([`<resultMap id="${mapId}" type="${className}">`, ...rows, '</resultMap>'].join('\n'));
    }
  }
  return out.join('\n\n');
}
