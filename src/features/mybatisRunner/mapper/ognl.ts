/**
 * MyBatis <if test>, <when test>, <bind value>, <foreach collection> 에 쓰이는 OGNL 식의 부분 구현 (vscode 의존 없음).
 *
 * 목표는 "실무 mapper 에서 자주 쓰는 식"을 정확히 평가하는 것이고, 모르는 식은 OgnlUnsupported 를 던져
 * 호출 쪽이 그 분기를 '수동 선택'으로 돌리게 한다. 틀린 값을 조용히 내는 것보다 모른다고 하는 쪽이 낫다.
 *
 * 지원: 리터럴(숫자·'문자열'·"문자열"·true/false/null), 경로(a.b[0].c), and/or/not/&&/||/!,
 *       ==,!=,<,>,<=,>=,eq,neq,lt,gt,lte,gte, + - * / %, 삼항, in / not in, {1,2} 목록,
 *       문자열·컬렉션 메서드(size, isEmpty, equals, trim, length, contains, startsWith …),
 *       @…StringUtils@isNotEmpty(x) 같은 정적 유틸(메서드 이름으로 판단)
 */

export class OgnlUnsupported extends Error {}

/** OGNL 의 'A' 는 문자열이 아니라 char. MyBatis 에서 흔한 함정이라 따로 구분한다 */
export class OChar {
  constructor(readonly c: string) {}
  toString() {
    return this.c;
  }
}

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'id'; name: string }
  | { t: 'prop'; obj: Node; name: string }
  | { t: 'idx'; obj: Node; index: Node }
  | { t: 'call'; obj: Node | null; name: string; args: Node[] }
  | { t: 'static'; cls: string; member: string; args: Node[] | null }
  | { t: 'list'; items: Node[] }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'tern'; c: Node; a: Node; b: Node };

export type OgnlAst = Node;

// ───────────────────────── 토큰
interface Tok {
  k: 'num' | 'str' | 'char' | 'id' | 'op' | 'end';
  v: string;
  n?: number;
}

const WORD_OPS = new Set(['and', 'or', 'not', 'eq', 'neq', 'lt', 'gt', 'lte', 'gte', 'in', 'instanceof', 'shl', 'shr', 'ushr', 'band', 'bor', 'xor']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)([lLdDfFbBhH])?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], n: Number(m[1]) });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (j >= src.length) throw new OgnlUnsupported('따옴표가 닫히지 않음');
      // OGNL: 작은따옴표 한 글자는 char
      out.push({ k: c === "'" && s.length === 1 ? 'char' : 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      out.push({ k: WORD_OPS.has(m[0]) ? 'op' : 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>=', '>>', '<<'].includes(two)) {
      out.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('!<>+-*/%().,[]{}?:@#=&|^~'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    throw new OgnlUnsupported(`알 수 없는 문자 '${c}'`);
  }
  out.push({ k: 'end', v: '' });
  return out;
}

// ───────────────────────── 파서
class Parser {
  private p = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0) {
    return this.toks[this.p + o];
  }
  private next() {
    return this.toks[this.p++];
  }
  private isOp(v: string, o = 0) {
    const t = this.peek(o);
    return t.k === 'op' && t.v === v;
  }
  private eat(v: string) {
    if (!this.isOp(v)) throw new OgnlUnsupported(`'${v}' 가 와야 하는데 '${this.peek().v || '끝'}'`);
    this.p++;
  }

  parse(): Node {
    const n = this.ternary();
    if (this.peek().k !== 'end') throw new OgnlUnsupported(`해석하지 못한 부분: '${this.peek().v}'`);
    return n;
  }

  private ternary(): Node {
    const c = this.or();
    if (this.isOp('?')) {
      this.next();
      const a = this.ternary();
      this.eat(':');
      const b = this.ternary();
      return { t: 'tern', c, a, b };
    }
    return c;
  }
  private or(): Node {
    let a = this.and();
    while (this.isOp('||') || this.isOp('or')) {
      this.next();
      a = { t: 'bin', op: '||', a, b: this.and() };
    }
    return a;
  }
  private and(): Node {
    let a = this.equality();
    while (this.isOp('&&') || this.isOp('and')) {
      this.next();
      a = { t: 'bin', op: '&&', a, b: this.equality() };
    }
    return a;
  }
  private equality(): Node {
    let a = this.relational();
    for (;;) {
      if (this.isOp('==') || this.isOp('eq')) {
        this.next();
        a = { t: 'bin', op: '==', a, b: this.relational() };
      } else if (this.isOp('!=') || this.isOp('neq')) {
        this.next();
        a = { t: 'bin', op: '!=', a, b: this.relational() };
      } else return a;
    }
  }
  private relational(): Node {
    let a = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'op') return a;
      const map: Record<string, string> = { '<': '<', '>': '>', '<=': '<=', '>=': '>=', lt: '<', gt: '>', lte: '<=', gte: '>=' };
      if (map[t.v]) {
        this.next();
        a = { t: 'bin', op: map[t.v], a, b: this.additive() };
      } else if (t.v === 'in') {
        this.next();
        a = { t: 'bin', op: 'in', a, b: this.additive() };
      } else if (t.v === 'not' && this.isOp('in', 1)) {
        this.next();
        this.next();
        a = { t: 'bin', op: 'not in', a, b: this.additive() };
      } else if (t.v === 'instanceof') {
        throw new OgnlUnsupported('instanceof 는 지원하지 않음');
      } else return a;
    }
  }
  private additive(): Node {
    let a = this.mult();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      a = { t: 'bin', op, a, b: this.mult() };
    }
    return a;
  }
  private mult(): Node {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      a = { t: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Node {
    if (this.isOp('!') || (this.isOp('not') && !this.isOp('in', 1))) {
      this.next();
      return { t: 'un', op: '!', a: this.unary() };
    }
    if (this.isOp('-')) {
      this.next();
      return { t: 'un', op: '-', a: this.unary() };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.postfix();
  }
  private args(): Node[] {
    this.eat('(');
    const out: Node[] = [];
    if (!this.isOp(')')) {
      out.push(this.ternary());
      while (this.isOp(',')) {
        this.next();
        out.push(this.ternary());
      }
    }
    this.eat(')');
    return out;
  }
  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const id = this.next();
        if (id.k !== 'id') throw new OgnlUnsupported(`'.' 뒤에 이름이 와야 함`);
        n = this.isOp('(') ? { t: 'call', obj: n, name: id.v, args: this.args() } : { t: 'prop', obj: n, name: id.v };
      } else if (this.isOp('[')) {
        this.next();
        const index = this.ternary();
        this.eat(']');
        n = { t: 'idx', obj: n, index };
      } else return n;
    }
  }
  private primary(): Node {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'lit', v: t.n };
      case 'str':
        return { t: 'lit', v: t.v };
      case 'char':
        return { t: 'lit', v: new OChar(t.v) };
      case 'id':
        if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: t.v === 'true' };
        if (t.v === 'null') return { t: 'lit', v: null };
        if (this.isOp('(')) return { t: 'call', obj: null, name: t.v, args: this.args() };
        return { t: 'id', name: t.v };
      case 'op':
        if (t.v === '(') {
          const n = this.ternary();
          this.eat(')');
          return n;
        }
        if (t.v === '{') {
          const items: Node[] = [];
          if (!this.isOp('}')) {
            items.push(this.ternary());
            while (this.isOp(',')) {
              this.next();
              items.push(this.ternary());
            }
          }
          this.eat('}');
          return { t: 'list', items };
        }
        if (t.v === '@') {
          // @패키지.클래스@멤버 또는 @패키지.클래스@메서드(인자)
          let cls = '';
          while (!this.isOp('@')) {
            const x = this.next();
            if (x.k === 'end') throw new OgnlUnsupported('정적 참조 형식이 잘못됨');
            cls += x.v;
          }
          this.eat('@');
          const member = this.next();
          if (member.k !== 'id') throw new OgnlUnsupported('정적 참조 형식이 잘못됨');
          return { t: 'static', cls, member: member.v, args: this.isOp('(') ? this.args() : null };
        }
        if (t.v === '#') throw new OgnlUnsupported('#변수 / #{…} 맵 식은 지원하지 않음');
        throw new OgnlUnsupported(`예상하지 못한 '${t.v}'`);
      default:
        throw new OgnlUnsupported('식이 끝나지 않음');
    }
  }
}

const cache = new Map<string, Node | OgnlUnsupported>();

/** 식을 파싱한다 (결과 캐시). 해석할 수 없으면 OgnlUnsupported */
export function parseOgnl(expr: string): Node {
  let n = cache.get(expr);
  if (!n) {
    try {
      n = new Parser(tokenize(expr)).parse();
    } catch (e) {
      n = e instanceof OgnlUnsupported ? e : new OgnlUnsupported(String(e));
    }
    if (cache.size > 5000) cache.clear();
    cache.set(expr, n);
  }
  if (n instanceof OgnlUnsupported) throw n;
  return n;
}

// ───────────────────────── 평가

/** 이름 → 값 조회. 없으면 undefined (OGNL 에서는 null 로 취급) */
export type Lookup = (name: string) => unknown;

export interface EvalEnv {
  lookup: Lookup;
  /** MyBatis 실제 동작과 다를 수 있는 지점을 알려 준다 */
  warn?: (msg: string) => void;
}

/** OGNL 의 참/거짓 규칙: null·false·0 만 거짓, 빈 문자열·빈 목록은 참 */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof OChar) return v.c !== '\0';
  return true;
}

const isNum = (v: unknown): v is number => typeof v === 'number';
const numericString = (s: string) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);

function sizeOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  throw new OgnlUnsupported('size() 를 쓸 수 없는 값');
}

function toNumber(v: unknown, env: EvalEnv, ctx: string): number {
  if (isNum(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof OChar) return v.c.charCodeAt(0);
  if (typeof v === 'string' && numericString(v)) return Number(v);
  if (v === null || v === undefined) return 0;
  env.warn?.(`${ctx}: 숫자로 바꿀 수 없는 값 '${String(v)}' — MyBatis 에서는 NumberFormatException`);
  throw new OgnlUnsupported(`숫자 비교 불가: ${String(v)}`);
}

function equal(a: unknown, b: unknown, env: EvalEnv): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  // 'Y' (char) 와 문자열 비교: MyBatis 에서는 숫자 변환을 시도하다 오류가 난다
  if ((a instanceof OChar && typeof b === 'string') || (b instanceof OChar && typeof a === 'string')) {
    const ch = (a instanceof OChar ? a : b) as OChar;
    env.warn?.(
      `'${ch.c}' 는 OGNL 에서 문자열이 아니라 char 입니다. MyBatis 에서는 NumberFormatException 이 나거나 항상 false 가 됩니다 → "${ch.c}" 또는 '${ch.c}'.toString() 으로 쓰세요 (여기서는 의도대로 문자열 비교함)`
    );
    return String(a) === String(b);
  }
  if (a instanceof OChar || b instanceof OChar) {
    if (a instanceof OChar && b instanceof OChar) return a.c === b.c;
    return toNumber(a, env, '비교') === toNumber(b, env, '비교');
  }
  if (isNum(a) || isNum(b)) {
    if (typeof a === 'boolean' || typeof b === 'boolean') return false;
    return toNumber(a, env, '비교') === toNumber(b, env, '비교');
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: unknown, b: unknown, env: EvalEnv): number {
  if (typeof a === 'string' && typeof b === 'string' && !(numericString(a) && numericString(b))) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = toNumber(a, env, '크기 비교');
  const y = toNumber(b, env, '크기 비교');
  return x < y ? -1 : x > y ? 1 : 0;
}

function contains(coll: unknown, v: unknown, env: EvalEnv): boolean {
  if (Array.isArray(coll)) return coll.some((x) => equal(x, v, env));
  if (typeof coll === 'string') return coll.includes(String(v));
  if (coll && typeof coll === 'object') return Object.prototype.hasOwnProperty.call(coll, String(v));
  return false;
}

function getProp(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) {
    // MyBatis 에서는 null.prop 이 오류가 아니라 null 이 되는 경우가 많다 (Map 파라미터)
    return null;
  }
  if (Array.isArray(obj) && name === 'length') return obj.length;
  if (typeof obj === 'string' && name === 'length') return obj.length;
  if (typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[name];
    if (v !== undefined) return v;
    if (Array.isArray(obj) && (name === 'size' || name === 'empty')) return name === 'size' ? obj.length : obj.length === 0;
    return null;
  }
  // 스칼라에 대한 속성 접근은 알 수 없음
  throw new OgnlUnsupported(`'${String(obj)}' 의 속성 ${name}`);
}

/** 대상 객체의 메서드 호출 (자바 String / Collection / Map 의 자주 쓰는 것) */
function callMethod(obj: unknown, name: string, args: unknown[], env: EvalEnv): unknown {
  const a0 = args[0];
  if (obj === null || obj === undefined) {
    env.warn?.(`null 값에 .${name}() 호출 — MyBatis 에서는 NullPointerException 이 날 수 있음`);
    throw new OgnlUnsupported(`null.${name}()`);
  }
  const s = typeof obj === 'string' ? obj : obj instanceof OChar ? obj.c : isNum(obj) || typeof obj === 'boolean' ? String(obj) : undefined;
  switch (name) {
    case 'size':
      return sizeOf(obj);
    case 'isEmpty':
      return sizeOf(obj) === 0;
    case 'length':
      return sizeOf(obj);
    case 'toString':
      return s ?? JSON.stringify(obj);
    case 'equals':
      return equal(obj instanceof OChar ? obj.c : obj, a0 instanceof OChar ? a0.c : a0, env);
    case 'hashCode':
      throw new OgnlUnsupported('hashCode()');
    case 'contains':
      return contains(obj, a0 instanceof OChar ? a0.c : a0, env);
    case 'containsKey':
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.prototype.hasOwnProperty.call(obj, String(a0)) : false;
    case 'containsValue':
      return obj && typeof obj === 'object' ? Object.values(obj).some((x) => equal(x, a0, env)) : false;
    case 'get':
      if (Array.isArray(obj)) return obj[toNumber(a0, env, 'get')] ?? null;
      if (typeof obj === 'object') return (obj as Record<string, unknown>)[String(a0)] ?? null;
      break;
    case 'keySet':
      if (obj && typeof obj === 'object') return Object.keys(obj);
      break;
    case 'values':
      if (obj && typeof obj === 'object') return Object.values(obj);
      break;
  }
  if (s !== undefined) {
    const arg = (i: number) => {
      const v = args[i];
      return v instanceof OChar ? v.c : String(v);
    };
    switch (name) {
      case 'equalsIgnoreCase':
        return a0 !== null && a0 !== undefined && s.toLowerCase() === arg(0).toLowerCase();
      case 'trim':
      case 'strip':
        return s.trim();
      case 'toUpperCase':
        return s.toUpperCase();
      case 'toLowerCase':
        return s.toLowerCase();
      case 'startsWith':
        return s.startsWith(arg(0));
      case 'endsWith':
        return s.endsWith(arg(0));
      case 'indexOf':
        return s.indexOf(arg(0));
      case 'lastIndexOf':
        return s.lastIndexOf(arg(0));
      case 'charAt':
        return new OChar(s.charAt(toNumber(args[0], env, 'charAt')));
      case 'substring':
        return args.length > 1 ? s.substring(toNumber(args[0], env, 'substring'), toNumber(args[1], env, 'substring')) : s.substring(toNumber(args[0], env, 'substring'));
      case 'isBlank':
        return s.trim() === '';
      case 'matches':
        return new RegExp(`^(?:${arg(0)})$`).test(s);
      case 'replace':
        return s.split(arg(0)).join(arg(1));
      case 'concat':
        return s + arg(0);
      case 'compareTo':
        return s < arg(0) ? -1 : s > arg(0) ? 1 : 0;
    }
  }
  throw new OgnlUnsupported(`.${name}() 메서드는 지원하지 않음`);
}

/** @…Utils@isNotEmpty(x) 처럼 자주 쓰는 정적 유틸: 클래스는 보지 않고 메서드 이름으로 판단 */
function callStatic(cls: string, member: string, args: unknown[] | null, env: EvalEnv): unknown {
  const short = cls.split('.').pop() ?? cls;
  if (args === null) {
    if (short === 'Boolean' && (member === 'TRUE' || member === 'FALSE')) return member === 'TRUE';
    if (short === 'Integer' && member === 'MAX_VALUE') return 2147483647;
    throw new OgnlUnsupported(`정적 필드 @${cls}@${member} 는 값을 알 수 없음`);
  }
  const v = args[0];
  const isEmpty = (x: unknown) =>
    x === null || x === undefined || (typeof x === 'string' && x.length === 0) || (Array.isArray(x) && x.length === 0) ||
    (typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 0);
  const isBlank = (x: unknown) => x === null || x === undefined || (typeof x === 'string' && x.trim() === '') || isEmpty(x);
  const known: Record<string, () => unknown> = {
    isEmpty: () => isEmpty(v),
    isNotEmpty: () => !isEmpty(v),
    isBlank: () => isBlank(v),
    isNotBlank: () => !isBlank(v),
    hasText: () => !isBlank(v),
    hasLength: () => !isEmpty(v),
    isNull: () => v === null || v === undefined,
    isNotNull: () => !(v === null || v === undefined),
    nonNull: () => !(v === null || v === undefined),
    equals: () => equal(v, args[1], env),
    equalsIgnoreCase: () => v !== null && v !== undefined && String(v).toLowerCase() === String(args[1] ?? '').toLowerCase(),
    defaultIfEmpty: () => (isEmpty(v) ? args[1] : v),
    nvl: () => (v === null || v === undefined ? args[1] : v),
    valueOf: () => (short === 'String' ? (v === null ? 'null' : String(v)) : v),
  };
  const f = known[member];
  if (!f) throw new OgnlUnsupported(`정적 메서드 @${cls}@${member}() 는 지원하지 않음`);
  const standard = /^(StringUtils|ObjectUtils|CollectionUtils|Objects|String|Boolean)$/.test(short);
  if (!standard) env.warn?.(`@${cls}@${member}() 는 메서드 이름으로 추정해 평가함`);
  return f();
}

function evalNode(n: Node, env: EvalEnv): unknown {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'id': {
      const v = env.lookup(n.name);
      return v === undefined ? null : v;
    }
    case 'prop':
      return getProp(evalNode(n.obj, env), n.name);
    case 'idx': {
      const o = evalNode(n.obj, env);
      const i = evalNode(n.index, env);
      if (o === null || o === undefined) return null;
      if (Array.isArray(o)) return o[toNumber(i, env, '인덱스')] ?? null;
      if (typeof o === 'object') return (o as Record<string, unknown>)[String(i)] ?? null;
      throw new OgnlUnsupported('인덱스를 쓸 수 없는 값');
    }
    case 'call': {
      if (!n.obj) throw new OgnlUnsupported(`${n.name}() 함수는 지원하지 않음`);
      const o = evalNode(n.obj, env);
      return callMethod(o, n.name, n.args.map((a) => evalNode(a, env)), env);
    }
    case 'static':
      return callStatic(n.cls, n.member, n.args ? n.args.map((a) => evalNode(a, env)) : null, env);
    case 'list':
      return n.items.map((x) => evalNode(x, env));
    case 'un': {
      const v = evalNode(n.a, env);
      return n.op === '!' ? !truthy(v) : -toNumber(v, env, '부호');
    }
    case 'tern':
      return truthy(evalNode(n.c, env)) ? evalNode(n.a, env) : evalNode(n.b, env);
    case 'bin': {
      if (n.op === '&&') {
        const a = evalNode(n.a, env);
        return truthy(a) ? truthy(evalNode(n.b, env)) : false;
      }
      if (n.op === '||') {
        const a = evalNode(n.a, env);
        return truthy(a) ? true : truthy(evalNode(n.b, env));
      }
      const a = evalNode(n.a, env);
      const b = evalNode(n.b, env);
      switch (n.op) {
        case '==':
          return equal(a, b, env);
        case '!=':
          return !equal(a, b, env);
        case '<':
          return compare(a, b, env) < 0;
        case '>':
          return compare(a, b, env) > 0;
        case '<=':
          return compare(a, b, env) <= 0;
        case '>=':
          return compare(a, b, env) >= 0;
        case 'in':
          return contains(b, a, env);
        case 'not in':
          return !contains(b, a, env);
        case '+':
          if (typeof a === 'string' || typeof b === 'string' || a instanceof OChar || b instanceof OChar) {
            if (isNum(a) || isNum(b) || typeof a === 'string' || typeof b === 'string') return `${a ?? 'null'}${b ?? 'null'}`;
          }
          return toNumber(a, env, '+') + toNumber(b, env, '+');
        case '-':
          return toNumber(a, env, '-') - toNumber(b, env, '-');
        case '*':
          return toNumber(a, env, '*') * toNumber(b, env, '*');
        case '/':
          return toNumber(a, env, '/') / toNumber(b, env, '/');
        case '%':
          return toNumber(a, env, '%') % toNumber(b, env, '%');
      }
    }
  }
  throw new OgnlUnsupported('해석하지 못한 식');
}

export function evalOgnl(expr: string, env: EvalEnv): unknown {
  return evalNode(parseOgnl(expr), env);
}

export function evalOgnlBool(expr: string, env: EvalEnv): boolean {
  return truthy(evalOgnl(expr, env));
}

/**
 * 식에서 참조하는 파라미터 경로를 모은다. 예: "user.name != null and list.size() > 0" → ['user.name', 'list']
 * 파싱에 실패하면 단순 정규식으로 이름만이라도 뽑는다.
 */
export function referencedPaths(expr: string): string[] {
  const out = new Set<string>();
  const pathOf = (n: Node): string | null => {
    if (n.t === 'id') return n.name;
    if (n.t === 'prop') {
      const p = pathOf(n.obj);
      // 목록 원소의 속성(items[0].id)은 목록 자체를 입력받는다
      return p && n.name !== 'length' && n.obj.t !== 'idx' ? `${p}.${n.name}` : p;
    }
    if (n.t === 'idx') return pathOf(n.obj);
    return null;
  };
  const visit = (n: Node) => {
    switch (n.t) {
      case 'id':
      case 'prop':
      case 'idx': {
        const p = pathOf(n);
        if (p) out.add(p);
        if (n.t === 'idx') visit(n.index);
        // a.b[0].c 의 a.b 같이 체인 중간에서 끊긴 것
        if (n.t === 'prop' && !p) visit(n.obj);
        break;
      }
      case 'call':
        if (n.obj) visit(n.obj);
        n.args.forEach(visit);
        break;
      case 'static':
        n.args?.forEach(visit);
        break;
      case 'list':
        n.items.forEach(visit);
        break;
      case 'un':
        visit(n.a);
        break;
      case 'bin':
        visit(n.a);
        visit(n.b);
        break;
      case 'tern':
        visit(n.c);
        visit(n.a);
        visit(n.b);
        break;
    }
  };
  try {
    visit(parseOgnl(expr));
  } catch {
    const stripped = expr.replace(/'[^']*'|"[^"]*"|@[\w.$]+@\w+/g, ' ');
    for (const m of stripped.matchAll(/(?<![\w.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?!\s*\()/g)) {
      const name = m[1];
      if (!WORD_OPS.has(name) && !['true', 'false', 'null'].includes(name)) out.add(name);
    }
  }
  return [...out];
}
