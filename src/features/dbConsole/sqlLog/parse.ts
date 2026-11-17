/**
 * SQL 로그 (DB 콘솔 묶음) — 실행 로그에서 쿼리를 골라 값까지 채운 SQL 로 만든다. vscode 모듈에 의존하지 않아 단독 테스트가 가능하다.
 *
 *   ... c.e.m.UserMapper.selectUser : ==>  Preparing: SELECT * FROM TB_USER WHERE ID = ? AND NM = ?
 *   ... c.e.m.UserMapper.selectUser : ==> Parameters: 10(Integer), kim(String)
 *   ... c.e.m.UserMapper.selectUser : <==      Total: 1
 *   → SELECT * FROM TB_USER WHERE ID = 10 AND NM = 'kim'
 *
 * log4jdbc(jdbc.sqltiming · jdbc.sqlonly)는 값이 이미 들어간 SQL 을 여러 줄로 찍는다 — 그 덩어리를 그대로 가져온다:
 *   ... DEBUG j.sqltiming -  sun.reflect.NativeMethodAccessorImpl.invoke0(null:-2)
 *   10. SELECT USER_ID
 *         FROM TB_USER
 *        WHERE EMAIL = 'a@b.com'
 *    {executed in 3 msec}
 * 같은 요청에서 MyBatis 로그와 log4jdbc 로그가 둘 다 찍히면 한 건으로 합친다 (이름은 MyBatis, SQL·시간은 log4jdbc)
 */

export interface LoggedQuery {
  /** 값을 채운 SQL (끝에 ; 없음) */
  sql: string;
  /** 로그를 찍은 mapper 메서드. 예: UserMapper.selectUser (못 찾으면 '') */
  mapper: string;
  /** 읽은 시각 (ms) */
  time: number;
  /** 결과 건수 (<== Total / Updates 가 왔을 때) */
  rows?: number;
  /** ? 개수와 값 개수가 다를 때의 안내 */
  warn?: string;
  /** 실행 시간 ms (log4jdbc 의 {executed in N msec}) */
  ms?: number;
  /** 실행 실패 (log4jdbc 의 {FAILED after N msec}) */
  failed?: boolean;
  /** 값이 채워지지 않은 ? 가 남아 있다 (값을 따로 찍지 않는 로그) */
  unbound?: boolean;
  /** 로그를 찍은 스레드 ("http-nio-8080-exec-5", 모르면 '') */
  thread?: string;
  /** 로그 줄에 찍힌 시각 (그날 0시부터 ms, 줄에 시각이 없으면 없음) — 요청 안에서 몇 ms 뒤에 돌았는지 */
  at?: number;
  /** 이 쿼리를 돌린 요청 (요청 시작 줄을 본 경우) */
  req?: RequestInfo;
}

/**
 * 웹 요청 하나 — 요청 시작 줄([REQ][id] GET /url, DispatcherServlet : GET "/url")부터 끝 줄([RES][id] … status=200 | 236ms, Completed 200)까지.
 * 끝 줄이 오면 같은 객체에 status · ms · ended 를 채운다 (쿼리들이 같은 객체를 가리킨다)
 */
export interface RequestInfo {
  /** 읽은 차례 번호 */
  id: number;
  /** 줄에 찍힌 요청 id ([REQ][e2ccdecf] 의 e2ccdecf) */
  key?: string;
  method: string;
  url: string;
  thread: string;
  at?: number;
  time: number;
  status?: number;
  ms?: number;
  ended?: boolean;
}

export interface LogReaderOptions {
  /** 이 낱말이 든 로그 줄을 요청 시작으로 본다 (기본 ["[REQ]"]). DispatcherServlet 의 DEBUG 로그는 늘 알아본다 */
  requestStart?: string[];
  /** 이 낱말이 든 로그 줄을 요청 끝으로 본다 (기본 ["[RES]"]) */
  requestEnd?: string[];
  /** 로거 이름을 몰라도, 로그 내용이 SQL 로 시작하면 다음 로그 줄 전까지를 쿼리로 읽는다 (기본 켬) */
  auto?: boolean;
  /** 이 낱말이 들어 있는 로그 줄부터 다음 로그 줄 전까지를 쿼리로 읽는다 (자동으로 안 잡히는 로거용) */
  keywords?: string[];
}

export interface LogParam {
  /** null 이면 SQL NULL */
  value: string | null;
  /** 로그의 괄호 안 타입. 예: String, Integer, Timestamp */
  type: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** 터미널 색·커서 제어 문자를 지운다 */
export function stripAnsi(s: string): string {
  return s.indexOf('\x1b') < 0 ? s : s.replace(ANSI, '');
}

/** "10(Integer), kim(String), null" → 값 목록. 값 안의 쉼표·괄호는 그대로 둔다 */
export function parseParams(text: string): LogParam[] {
  const out: LogParam[] = [];
  const s = text.trim();
  // 값 끝: "(타입)" 뒤에 ", " 또는 줄 끝
  const end = /\(([A-Za-z_$][\w.$[\]]*)\)(?:, |$)/g;
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('null', i) && (i + 4 === s.length || s.startsWith(', ', i + 4))) {
      out.push({ value: null, type: '' });
      i += 4 + 2;
      continue;
    }
    end.lastIndex = i;
    const m = end.exec(s);
    if (!m) {
      out.push({ value: s.slice(i), type: '' }); // 타입 없이 끝남 (줄이 잘렸을 때)
      break;
    }
    out.push({ value: s.slice(i, m.index), type: m[1] });
    i = m.index + m[0].length;
  }
  return out;
}

const NUMERIC = new Set(['Integer', 'Long', 'Short', 'Byte', 'Double', 'Float', 'BigDecimal', 'BigInteger', 'AtomicInteger', 'AtomicLong']);
const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** 값 하나를 SQL 글자로. 날짜는 Oracle·MySQL·PostgreSQL 에서 모두 통하는 DATE '…' / TIMESTAMP '…' */
export function literal(p: LogParam): string {
  if (p.value === null) return 'NULL';
  const v = p.value;
  const type = p.type.slice(p.type.lastIndexOf('.') + 1);
  if (NUMERIC.has(type) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return v;
  if (type === 'Boolean') return v === 'true' ? '1' : v === 'false' ? '0' : quote(v);
  if (type === 'Timestamp' || type === 'LocalDateTime') {
    const t = v.replace('T', ' ');
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) return `TIMESTAMP ${quote(/:\d{2}:/.test(t) ? t : t + ':00')}`;
  }
  if ((type === 'Date' || type === 'LocalDate') && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `DATE ${quote(v)}`;
  return quote(v);
}

/** 따옴표 글의 닫는 따옴표 자리 (여는 따옴표가 i 에 있다). '' 는 따옴표 한 글자로 본다. 닫히지 않았으면 글의 끝 */
function quoteEnd(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === q) {
      if (text[j + 1] === q) j++;
      else break;
    }
    j++;
  }
  return j;
}

/** SQL 의 ? 자리에 값을 차례로 넣는다. 따옴표 안·주석 안의 ? 는 건드리지 않는다 */
export function bindSql(sql: string, params: LogParam[]): { sql: string; placeholders: number } {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // 따옴표 글: 닫는 따옴표까지 ('' 는 따옴표 한 글자)
      const j = quoteEnd(sql, i);
      out += sql.slice(i, j + 1);
      i = j;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const e = j < 0 ? sql.length : j;
      out += sql.slice(i, e);
      i = e - 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const e = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, e);
      i = e - 1;
    } else if (c === '?') {
      out += n < params.length ? literal(params[n]) : '?';
      n++;
    } else {
      out += c;
    }
  }
  return { sql: out, placeholders: n };
}

const CLAUSE =
  /(?:FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|UNION(?:\s+ALL)?|MINUS|INTERSECT|(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|JOIN|VALUES|SET|START\s+WITH|CONNECT\s+BY)(?![\w$#])/iy;
const AND_OR = /(?:AND|OR)(?![\w$#])/iy;
const BETWEEN = /BETWEEN(?![\w$#])/iy;

/**
 * 한 줄로 찍힌 SQL 을 읽기 좋게 줄만 나눈다 (FROM·WHERE·JOIN·AND … 앞). 띄어쓰기 말고는 바꾸지 않고,
 * 따옴표 안과 괄호 안(서브쿼리·함수)은 그대로 둔다
 */
export function layoutSql(sql: string): string {
  const s = sql.trim();
  let out = '';
  let depth = 0;
  let between = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const j = quoteEnd(s, i);
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    // 낱말이 시작하는 자리에서만 (앞 글자가 이름 글자가 아님)
    if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || !/[\w$#.]/.test(s[i - 1]))) {
      BETWEEN.lastIndex = i;
      if (BETWEEN.test(s)) between = true;
      CLAUSE.lastIndex = i;
      AND_OR.lastIndex = i;
      let m: RegExpExecArray | null;
      if (i > 0 && (m = CLAUSE.exec(s))) {
        out = out.replace(/\s+$/, '') + '\n' + m[0];
        i += m[0].length - 1;
        continue;
      }
      if ((m = AND_OR.exec(s))) {
        if (between && m[0].toUpperCase() === 'AND') {
          between = false; // BETWEEN a AND b 의 AND 는 줄을 나누지 않는다
        } else {
          out = out.replace(/\s+$/, '') + '\n  ' + m[0];
          i += m[0].length - 1;
          continue;
        }
      }
    }
    out += c;
  }
  return out;
}

/** 줄 머리의 시각. 2026-11-10 12:00:00 · 12:00:00.123 · 20170202 20:37:02.037 · [2026-11-10T… */
const TIME_HEAD = /^\s*\[?(?:\d{2,4}[-/.:]\d{2}|\d{6,8}[ T_-]\d{2}:\d{2})/;
/** 줄 머리의 로그 수준 (뒤에 글이 이어질 때만 — SQL 의 INFO, 같은 칼럼 줄과 구분) */
const LEVEL_HEAD = /^\s*\[?\s*(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]?\s+\S/;

/** 로그 한 건이 시작하는 줄인가 (시각이나 로그 수준으로 시작) */
function isLogHead(line: string): boolean {
  return TIME_HEAD.test(line) || LEVEL_HEAD.test(line) || line.startsWith('Hibernate: ') || line === 'Hibernate:';
}

/** 새 로그 줄의 시작인가 (시각·로그 수준·예외 줄). 아니면 터미널 폭에서 잘려 넘어온 앞 줄의 나머지로 본다 */
function startsRecord(line: string): boolean {
  return (
    line.includes('==>') ||
    line.includes('<==') ||
    isLogHead(line) ||
    /^\s*(at\s|Caused by|\.\.\. \d+ more|[a-z]+(\.[\w$]+)+(Exception|Error)\b)/.test(line) ||
    /^[>$#]\s|^\s*$/.test(line)
  );
}

/** "==>" 앞부분에서 시각을 뺀 것 — Preparing 과 Parameters 를 짝짓는 열쇠 (스레드·로거가 들어 있다) */
function prefixKey(prefix: string): string {
  return prefix.replace(/^[\s\d\-/:.,TZ+[\]]+/, '').trim();
}

/**
 * 줄 머리의 스레드 이름 "[http-nio-8080-exec-5]" (없으면 '') — 같은 요청의 로그끼리 묶는 데 쓴다.
 * 로그 내용(" : " · " - " 뒤)의 [..] 는 보지 않고, 머리의 [..] 가운데 마지막 것을 쓴다
 * (Spring Boot 3.4 의 "--- [앱 이름] [스레드]" 처럼 둘일 때 뒤의 것이 스레드). 로그 수준 [DEBUG] 는 뺀다
 */
export function threadOf(prefix: string): string {
  const cut = prefix.search(/\s[:-]\s/);
  const head = cut >= 0 ? prefix.slice(0, cut) : prefix;
  const all = [...head.matchAll(/\[([^\]]*[A-Za-z][^\]]*)\]/g)].map((m) => m[1].trim()).filter((t) => !/^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)$/i.test(t));
  return all.length ? all[all.length - 1] : '';
}

/** 줄 머리의 시각 → 그날 0시부터 ms (12:34:56.789 · 12:34:56,789 · 12:34:56). 없으면 undefined */
export function logTimeOf(line: string): number | undefined {
  const m = /(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(line.slice(0, 48));
  if (!m) return undefined;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] ?? '0').padEnd(3, '0'));
}

const HTTP_METHOD = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"?([^\s"|,]+)/;
const DISPATCH_START = /DispatcherServlet\s*:\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"([^"]+)"/;
const DISPATCH_END = /DispatcherServlet\s*:\s*Completed\s+(\d{3})\b/;

/** "[REQ][e2ccdecf] GET …" 에서 낱말 바로 뒤의 [id] (없으면 undefined) */
function bracketAfter(line: string, word: string): string | undefined {
  const at = line.indexOf(word);
  const m = /^\s*\[([^\]\s]{1,64})\]/.exec(line.slice(at + word.length));
  return m ? m[1] : undefined;
}

/** "... c.e.m.UserMapper.selectUser :" → "UserMapper.selectUser". 로거 이름이 줄여 찍혀 클래스가 한두 글자면 메서드만 */
function mapperOf(prefix: string): string {
  const all = prefix.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g);
  if (!all) return '';
  const parts = all[all.length - 1].split('.');
  const cls = parts[parts.length - 2];
  return cls.length <= 2 ? parts[parts.length - 1] : parts.slice(-2).join('.');
}

/** log4jdbc 로그의 시작: 로거 이름(jdbc.sqltiming / 줄여서 j.sqltiming) 뒤에 호출 위치나 SQL 이 온다 */
const JDBC_HEAD = /^(.*?)(?:\bjdbc|\bj)\.(sqltiming|sqlonly)\b\s*(?:[-:|]+\s?)?(.*)$/;
/** log4jdbc 가 SQL 뒤에 붙이는 꼬리 */
const JDBC_TAIL = /\{(executed in|FAILED after) (\d+) msec\}\s*$/;
/** 호출 위치 줄. 예: sun.reflect.NativeMethodAccessorImpl.invoke0(null:-2) */
const CALL_SITE = /^\s*[\w.$<>]+\([^()]*\)\s*$/;

/** 두 SQL 이 같은 문장으로 보이는가: 주석·띄어쓰기를 빼고 앞머리(첫 값 앞까지, 최대 40자)가 같다 */
function sameHead(a: string, b: string): boolean {
  const head = (x: string) => {
    const t = x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').toLowerCase();
    // 첫 값(따옴표)이나 ? 앞까지만 — 한쪽은 값이 채워지고 한쪽은 ? 그대로일 수 있다
    const q = t.search(/['?]/);
    return t.slice(0, Math.min(40, q < 0 ? t.length : q));
  };
  const x = head(a);
  const y = head(b);
  const n = Math.min(x.length, y.length);
  return n >= 6 && x.slice(0, n) === y.slice(0, n);
}

/** log4jdbc 가 찍은 여러 줄 SQL 을 다듬는다: 앞의 "10. " 번호와 빈 줄을 떼고, 둘째 줄부터 공통 들여쓰기를 뺀다 */
function tidyBlock(lines: string[]): string {
  const ls = lines.map((l) => l.replace(/\s+$/, ''));
  while (ls.length && !ls[0].trim()) ls.shift();
  while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
  if (!ls.length) return '';
  // 첫 줄이 로그 줄에 붙어 찍혔거나 번호("10. ")로 시작하면 첫 줄은 들여쓰기가 없다 → 둘째 줄부터 맞춘다.
  // 첫 줄도 들여 찍혔으면(SQL 이 다음 줄부터 시작) 모든 줄을 같이 당긴다
  const numbered = /^\s*\d+\.\s/.test(ls[0]);
  const first = numbered || !/^\s/.test(ls[0]) ? 1 : 0;
  ls[0] = ls[0].replace(/^\s*\d+\.\s/, '');
  if (first === 1) ls[0] = ls[0].trimStart();
  let indent = Infinity;
  for (let i = first; i < ls.length; i++) {
    if (ls[i].trim()) indent = Math.min(indent, ls[i].length - ls[i].trimStart().length);
  }
  if (indent !== Infinity && indent > 0) {
    for (let i = first; i < ls.length; i++) ls[i] = ls[i].slice(Math.min(indent, ls[i].length - ls[i].trimStart().length));
  }
  return ls.join('\n').replace(/;\s*$/, '');
}

/** 붙잡아 두는 줄·짝 없는 Preparing 의 상한 (로그가 끝없이 와도 메모리가 늘지 않게) */
const MAX_LINE = 200_000;
const MAX_OPEN = 50;

type Source = 'mybatis' | 'sqlonly' | 'sqltiming' | 'generic' | 'custom';
type BlockKind = Exclude<Source, 'mybatis'>;

const VERB = String.raw`(?:select|insert\s+into|update|delete|merge\s+into|with)\b`;
/** 로그 줄에서 내용이 SQL 로 시작하는 자리: 구분자(: - ] > |) 뒤나 줄 머리, 앞에 번호·주석이 있어도 된다 */
const SQL_IN_HEAD = new RegExp(String.raw`(?:^|[:\-\]>|]\s+|\s{2,})(?:\d+\.\s+)?((?:\/\*.*?\*\/\s*)*${VERB}.*)$`, 'i');
/** 내용 없이 끝난 로그 줄 (SQL 이 다음 줄부터 찍힌다) */
const EMPTY_HEAD = /(?:[:\-|>]\s*|\]\s*)$/;
/** 덩어리의 첫 줄이 SQL 로 시작하는가 */
const SQL_FIRST = new RegExp(String.raw`^\s*(?:\d+\.\s+)?(?:\/\*.*?\*\/\s*)*(?:${VERB}|\/\*)`, 'i');

/** 문장 모양까지 SQL 인가 ("Update done for user" 같은 평범한 로그를 거른다) */
function looksLikeSql(text: string): boolean {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  return /^(?:select\b[\s\S]*\bfrom\s+[\w."$#(]|insert\s+into\s+[\w."$#]+\s*(?:\(|values\b|select\b)|update\s+[\w."$#]+(?:\s+\w+)?\s+set\s+[\w."$#]+\s*=|delete\s+from\s+[\w."$#]+(?:\s|$)|merge\s+into\s+[\w."$#]+|with\s+[\w"$#]+(?:\s*\([^)]*\))?\s+as\s*\()/i.test(
    t
  );
}

/** 값이 안 채워진 ? 가 있는가 (따옴표·주석 안은 빼고) */
function hasPlaceholder(sql: string): boolean {
  return sql.includes('?') && bindSql(sql, []).placeholders > 0;
}

/**
 * 로그를 조각(chunk)으로 받아 완성된 쿼리를 돌려준다. 실행 하나(터미널 명령 하나)마다 하나씩 만든다.
 * 스레드가 섞여 찍혀도 로거·스레드가 같은 Preparing ↔ Parameters 끼리 짝짓는다
 */
export class LogReader {
  private buf = '';
  /** 아직 다음 줄을 기다리는 "==>" 줄 (터미널 폭에서 잘린 나머지가 이어질 수 있어서) */
  private held: string | undefined;
  /** 읽는 중인 여러 줄 SQL 덩어리 (log4jdbc, 또는 SQL 로 시작하는 로그) */
  private block: { kind: BlockKind; thread: string; lines: string[]; size: number; needSql?: boolean; at?: number } | undefined;
  /** 열쇠 → Preparing 의 SQL */
  private open = new Map<string, { sql: string; mapper: string }>();
  /** 열쇠 → 방금 내보낸 쿼리 (Total 이 오면 건수를 적는다) */
  private last = new Map<string, LoggedQuery>();
  /** 스레드 → 그 스레드에서 방금 내보낸 쿼리와, 그 쿼리를 본 로그 종류 (같은 실행의 다른 로그를 한 건으로 합친다) */
  private byThread = new Map<string, { q: LoggedQuery; seen: Set<Source> }>();

  private readonly auto: boolean;
  private readonly keywords: string[];
  private readonly startWords: string[];
  private readonly endWords: string[];
  /** 끝나지 않은 요청: 요청 id → 요청, 스레드 → 요청 */
  private reqById = new Map<string, RequestInfo>();
  private reqByThread = new Map<string, RequestInfo>();
  private reqSeq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    options: LogReaderOptions = {}
  ) {
    this.auto = options.auto !== false;
    this.keywords = (options.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    const words = (list: string[] | undefined, def: string[]) => (list ?? def).map((k) => String(k).trim()).filter(Boolean);
    this.startWords = words(options.requestStart, ['[REQ]']);
    this.endWords = words(options.requestEnd, ['[RES]']);
  }

  /** 요청 시작 · 끝 줄이면 요청을 열고 닫고 true. 시작 줄 뒤 같은 스레드의 쿼리는 그 요청에 묶인다 */
  private request(line: string, thread: string): boolean {
    const word = this.startWords.find((w) => line.includes(w));
    const dispatcher = line.includes('DispatcherServlet');
    const ds = word || !dispatcher ? null : DISPATCH_START.exec(line);
    if (word || ds) {
      const key = word ? bracketAfter(line, word) : undefined;
      const mu = ds ? [ds[0], ds[1], ds[2]] : HTTP_METHOD.exec(line.slice(line.indexOf(word!) + word!.length));
      const r: RequestInfo = { id: ++this.reqSeq, key, method: mu?.[1] ?? '', url: mu?.[2] ?? '', thread, at: logTimeOf(line), time: this.now() };
      const prev = this.reqByThread.get(thread);
      if (prev) this.closeRequest(prev); // 끝 줄 없이 다음 요청이 시작됨
      this.reqByThread.set(thread, r);
      if (key) this.reqById.set(key, r);
      if (this.reqById.size > MAX_OPEN) this.reqById.delete(this.reqById.keys().next().value as string);
      if (this.reqByThread.size > MAX_OPEN) this.reqByThread.delete(this.reqByThread.keys().next().value as string);
      return true;
    }
    const end = this.endWords.find((w) => line.includes(w));
    const de = end || !dispatcher ? null : DISPATCH_END.exec(line);
    if (!end && !de) return false;
    const key = end ? bracketAfter(line, end) : undefined;
    const r = (key && this.reqById.get(key)) || this.reqByThread.get(thread);
    if (r && !r.ended) {
      const status = de ? Number(de[1]) : Number(/status\s*[=:]\s*(\d{3})/i.exec(line)?.[1] ?? /\s(\d{3})\s/.exec(line.slice(line.indexOf(end!)))?.[1]);
      if (status) r.status = status;
      const ms = /(\d+)\s*ms\b/.exec(end ? line.slice(line.indexOf(end)) : '')?.[1];
      const at = logTimeOf(line);
      if (ms) r.ms = Number(ms);
      else if (at !== undefined && r.at !== undefined && at >= r.at) r.ms = at - r.at;
      this.closeRequest(r);
    }
    return true;
  }

  private closeRequest(r: RequestInfo) {
    r.ended = true;
    if (r.key && this.reqById.get(r.key) === r) this.reqById.delete(r.key);
    if (this.reqByThread.get(r.thread) === r) this.reqByThread.delete(r.thread);
  }

  push(chunk: string): LoggedQuery[] {
    const out: LoggedQuery[] = [];
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = stripAnsi(this.buf.slice(0, nl)).replace(/\r/g, '');
      this.buf = this.buf.slice(nl + 1);
      this.line(line, out);
    }
    if (this.buf.length > MAX_LINE) this.buf = '';
    return out;
  }

  /** 붙잡아 둔 마지막 줄을 처리한다 (로그가 잠깐 멈췄을 때 부른다) */
  flush(): LoggedQuery[] {
    const out: LoggedQuery[] = [];
    this.release(out);
    // 꼬리({executed in …})가 없는 덩어리는 다음 로그가 와야 끝난다 → 로그가 멈췄으면 여기서 끝낸다
    if (this.block && this.block.kind !== 'sqltiming') this.finishBlock(out);
    return out;
  }

  private line(line: string, out: LoggedQuery[]) {
    if (this.block) {
      const tail = JDBC_TAIL.exec(line);
      if (tail) {
        this.block.lines.push(line.slice(0, tail.index));
        this.finishBlock(out, Number(tail[2]), tail[1] !== 'executed in');
        return;
      }
      if (!isLogHead(line) && !line.includes('==>') && !line.includes('<==') && this.block.size < MAX_LINE) {
        if (this.block.needSql) {
          // 내용 없이 끝난 로그 줄 다음: 첫 줄이 SQL 로 시작해야 쿼리로 본다 (표·예외 줄 같은 다른 출력이면 그만둔다)
          if (!line.trim() || CALL_SITE.test(line)) return;
          if (!SQL_FIRST.test(line)) {
            this.block = undefined;
            return;
          }
          this.block.needSql = false;
        }
        this.block.lines.push(line);
        this.block.size += line.length;
        return;
      }
      this.finishBlock(out); // 다음 로그가 시작됨 (꼬리가 없는 덩어리, 또는 꼬리를 못 본 sqltiming)
    }
    if (this.held !== undefined && !startsRecord(line) && this.held.length < MAX_LINE) {
      this.held += line; // 폭에서 잘린 줄의 나머지
      return;
    }
    this.release(out);
    if (line.includes('==>')) {
      this.held = line;
      return;
    }
    if (line.includes('<==')) {
      this.total(line);
      return;
    }
    const j = line.indexOf('.sql') < 0 ? null : JDBC_HEAD.exec(line);
    if (j && isLogHead(line)) {
      this.block = { kind: j[2] as 'sqlonly' | 'sqltiming', thread: threadOf(j[1]), lines: [], size: 0, at: logTimeOf(line) };
      const rest = j[3];
      const tail = JDBC_TAIL.exec(rest);
      if (tail) {
        // 한 줄로 찍힌 경우: SQL {executed in N msec}
        this.block.lines.push(rest.slice(0, tail.index));
        this.finishBlock(out, Number(tail[2]), tail[1] !== 'executed in');
      } else if (rest.trim() && !CALL_SITE.test(rest)) {
        this.block.lines.push(rest);
      }
      return;
    }
    if (!isLogHead(line)) return;
    const thread = threadOf(line);
    if (this.request(line, thread)) return;
    const logAt = logTimeOf(line);
    // 설정에 적은 낱말이 있는 로그: 그 낱말 뒤부터 다음 로그 줄 전까지
    for (const k of this.keywords) {
      const at = line.indexOf(k);
      if (at < 0) continue;
      const rest = line.slice(at + k.length).replace(/^[\s:\-|>\]]+/, '');
      this.block = { kind: 'custom', thread, lines: [], size: 0, at: logAt };
      if (rest.trim() && !CALL_SITE.test(rest)) this.inline(rest, out);
      return;
    }
    if (!this.auto) return;
    const m = SQL_IN_HEAD.exec(line);
    if (m) {
      this.block = { kind: 'generic', thread, lines: [], size: 0, at: logAt };
      this.inline(m[1], out);
    } else if (EMPTY_HEAD.test(line)) {
      this.block = { kind: 'generic', thread, lines: [], size: 0, needSql: true, at: logAt };
    }
  }

  /** 로그 줄에 같이 찍힌 SQL 첫 줄을 덩어리에 넣는다 (같은 줄에 꼬리까지 있으면 거기서 끝) */
  private inline(text: string, out: LoggedQuery[]) {
    if (!this.block) return;
    const tail = JDBC_TAIL.exec(text);
    this.block.lines.push(tail ? text.slice(0, tail.index) : text);
    if (tail) this.finishBlock(out, Number(tail[2]), tail[1] !== 'executed in');
  }

  private finishBlock(out: LoggedQuery[], ms?: number, failed?: boolean) {
    const b = this.block;
    this.block = undefined;
    if (!b) return;
    const sql = tidyBlock(b.lines);
    if (!sql || (b.kind === 'generic' && !looksLikeSql(sql))) return;
    const unbound = hasPlaceholder(sql);
    const prev = this.byThread.get(b.thread);
    if (prev && !prev.seen.has(b.kind) && sameHead(prev.q.sql, sql)) {
      // 같은 실행을 다른 로그가 먼저 알려 줌 → 한 건으로. 값이 들어 있는 쪽의 SQL 을 남긴다
      // (둘 다 값이 있으면 나중 것 — log4jdbc 처럼 실제로 실행된 글)
      prev.seen.add(b.kind);
      if (!unbound || prev.q.unbound) {
        prev.q.sql = sql;
        prev.q.warn = undefined;
        prev.q.unbound = unbound || undefined;
      }
      if (ms !== undefined) prev.q.ms = ms;
      if (failed) prev.q.failed = true;
      return;
    }
    const q: LoggedQuery = { sql, mapper: '', time: this.now() };
    if (b.at !== undefined) q.at = b.at;
    if (unbound) q.unbound = true;
    if (ms !== undefined) q.ms = ms;
    if (failed) q.failed = true;
    this.remember(b.thread, q, b.kind);
    out.push(q);
  }

  private remember(thread: string, q: LoggedQuery, src: Source) {
    if (thread) q.thread = thread;
    const req = this.reqByThread.get(thread);
    if (req) q.req = req;
    this.byThread.delete(thread);
    this.byThread.set(thread, { q, seen: new Set([src]) });
    if (this.byThread.size > MAX_OPEN) this.byThread.delete(this.byThread.keys().next().value as string);
  }

  private release(out: LoggedQuery[]) {
    const line = this.held;
    this.held = undefined;
    if (line === undefined) return;
    const m = /^(.*?)==>\s*(Preparing|Parameters):\s?(.*)$/.exec(line);
    if (!m) return;
    const key = prefixKey(m[1]);
    if (m[2] === 'Preparing') {
      const sql = m[3].trim();
      if (!sql) return;
      this.open.delete(key);
      this.open.set(key, { sql, mapper: mapperOf(m[1]) });
      if (this.open.size > MAX_OPEN) this.open.delete(this.open.keys().next().value as string);
      return;
    }
    const prep = this.open.get(key);
    if (!prep) return; // Preparing 을 못 본 Parameters (읽기 시작 전에 찍힘)
    this.open.delete(key);
    const params = parseParams(m[3]);
    const bound = bindSql(prep.sql, params);
    const q: LoggedQuery = { sql: bound.sql, mapper: prep.mapper, time: this.now() };
    const at = logTimeOf(line);
    if (at !== undefined) q.at = at;
    if (bound.placeholders !== params.length) q.warn = `? ${bound.placeholders}개, 값 ${params.length}개 — 로그 줄이 잘렸을 수 있습니다`;
    this.last.delete(key);
    this.last.set(key, q);
    if (this.last.size > MAX_OPEN) this.last.delete(this.last.keys().next().value as string);
    const thread = threadOf(m[1]);
    const prev = this.byThread.get(thread);
    if (prev && prev.q.unbound && !prev.seen.has('mybatis') && sameHead(prev.q.sql, q.sql)) {
      // 같은 실행의 SQL 을 값 없이 먼저 찍은 로그가 있었다 → 그 건에 값·이름을 채운다
      prev.seen.add('mybatis');
      prev.q.sql = q.sql;
      prev.q.mapper = q.mapper;
      prev.q.warn = q.warn;
      prev.q.unbound = undefined;
      this.last.set(key, prev.q);
      return;
    }
    this.remember(thread, q, 'mybatis');
    out.push(q);
  }

  private total(line: string) {
    const m = /^(.*?)<==\s*(?:Total|Updates):\s*(\d+)/.exec(line);
    if (!m) return;
    const q = this.last.get(prefixKey(m[1]));
    if (q) q.rows = Number(m[2]);
  }
}

/** 낱말 경계 글자 (식별자에 쓰이는 글자) */
const NAME_CHAR = '[\\w$#]';

/**
 * 수집 필터 낱말 하나 → 정규식. 대소문자를 가리지 않고, 낱말 단위로 맞춘다 (TB_USER 는 TB_USER_ROLE 에 맞지 않음).
 * `*` 는 이름 글자 여럿: `TB_COMM*` · `*Common*`. 띄어 쓴 곳은 공백 여럿에 맞는다. 빈 낱말 · `*` 만은 undefined
 */
export function filterPattern(word: string): RegExp | undefined {
  const w = word.trim();
  if (!w || /^\*+$/.test(w)) return undefined;
  const body = w
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join(`${NAME_CHAR}*`);
  const before = /^[\w$#*]/.test(w) ? `(?<!${NAME_CHAR})` : '';
  const after = /[\w$#*]$/.test(w) ? `(?!${NAME_CHAR})` : '';
  return new RegExp(before + body + after, 'i');
}

/**
 * 수집 필터: 쿼리 id(SQL 머리 주석) · mapper 이름 · SQL 글(테이블 이름 등)에서 낱말을 찾는다.
 * 제외 낱말이 하나라도 있으면 빼고, 포함 낱말을 적었으면 그중 하나가 있어야 넣는다 (제외가 먼저)
 */
export class QueryFilter {
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];

  constructor(include: readonly string[] = [], exclude: readonly string[] = []) {
    const compile = (list: readonly string[]) => list.map((w) => filterPattern(String(w))).filter((r): r is RegExp => !!r);
    this.include = compile(include);
    this.exclude = compile(exclude);
  }

  accepts(q: LoggedQuery): boolean {
    if (!this.include.length && !this.exclude.length) return true;
    const hay = `${queryId(q.sql)}\n${q.mapper}\n${q.sql}`;
    if (this.exclude.some((r) => r.test(hay))) return false;
    return !this.include.length || this.include.some((r) => r.test(hay));
  }
}

/** 같은 쿼리로 볼 이름: SQL 머리 주석의 쿼리 id → mapper 메서드. 둘 다 없으면 '' */
export function sameQueryKey(q: LoggedQuery): string {
  return queryId(q.sql) || q.mapper;
}

/** 필터에 걸려 빠진 쿼리를 이만큼 기억해 둔다 (필터를 풀면 목록으로 돌아온다) */
export const EXCLUDED_KEEP = 50;
/** 요청 하나에 담는 쿼리 수 (넘으면 뒤에 온 것을 버리고 개수만 센다 — 앞의 주 쿼리는 남기고, 반복이 많은 요청이 메모리를 채우지 않게) */
export const PER_REQUEST = 50;
/** 요청 줄이 없는 쿼리는 같은 스레드에서 이만큼 안에 이어 돈 것끼리 한 묶음으로 본다 */
export const THREAD_GAP_MS = 2000;

export type Entry = LoggedQuery & { id: number; group: string };

/** 묶음 하나 (요청 하나, 또는 요청 줄이 없을 때 같은 스레드에서 이어 돈 쿼리들) */
export interface QueryGroup {
  key: string;
  req?: RequestInfo;
  thread: string;
  /** 돈 차례대로 (오래된 것부터) */
  queries: Entry[];
  /** 담지 못하고 버린 쿼리 수 */
  overflow: number;
}

/** 같은 쿼리로 볼 열쇠 (값만 다른 반복을 하나로): 쿼리 id → mapper 메서드 → 값을 뺀 SQL */
export function repeatKey(q: LoggedQuery): string {
  return (
    sameQueryKey(q) ||
    q.sql
      .replace(/'(?:[^']|'')*'/g, '?')
      .replace(/\b\d+(?:\.\d+)?\b/g, '?')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** 묶음 안에서 at 번 이상 반복된 쿼리 (N+1 의심): 열쇠 → 횟수. 많은 것부터 */
export function repeats(queries: readonly LoggedQuery[], at: number): { key: string; title: string; count: number }[] {
  const count = new Map<string, { title: string; count: number }>();
  for (const q of queries) {
    const k = repeatKey(q);
    const c = count.get(k);
    if (c) c.count++;
    else count.set(k, { title: queryTitle(q), count: 1 });
  }
  return [...count]
    .filter(([, c]) => c.count >= Math.max(2, at))
    .map(([key, c]) => ({ key, ...c }))
    .sort((x, y) => y.count - x.count);
}

/**
 * 최근 쿼리 목록 — 요청(묶음) 단위로 최근 max 개를 둔다. 쿼리는 새 것부터 한 줄로 두고, 묶음 열쇠(group)로 나눈다.
 * 같은 쿼리가 연달아 찍히면(같은 묶음 · SQL · mapper) 한 건으로 합친다.
 * 필터에 걸린 쿼리는 목록에 넣지 않고 따로 최근 EXCLUDED_KEEP 개까지 기억한다 — 필터를 바꾸면 다시 나눠, 풀린 것은 목록으로 돌아온다.
 * latestOnly 면 같은 쿼리 id 의 예전 것은 뺀다
 */
export class QueryRing {
  private list: Entry[] = [];
  private held: Entry[] = [];
  /** 기억할 자리가 없어 버린 걸린 쿼리 수 */
  private dropped = 0;
  private seq = 0;
  /** 묶음 열쇠 → 담지 못하고 버린 쿼리 수 */
  private overflow = new Map<string, number>();
  /** 요청 줄이 없는 쿼리: 스레드 → 마지막 쿼리의 시각 · 묶음 번호 */
  private lastByThread = new Map<string, { at: number; seg: number }>();
  private segSeq = 0;

  constructor(
    private max: number,
    private filter = new QueryFilter(),
    private latestOnly = false
  ) {}

  /** 필터에 걸려 빠져 있는 쿼리 수 (지운 뒤부터) */
  get excluded(): number {
    return this.held.length + this.dropped;
  }

  setMax(max: number) {
    this.max = Math.max(1, max);
    this.trim();
  }

  /**
   * 필터 · 같은 id 하나만을 바꾸고, 목록과 걸려 있던 쿼리를 다시 나눈다.
   * 돌려주는 것: removed(목록에서 빠진 수) · restored(걸려 있다 돌아온 수)
   */
  setFilter(filter: QueryFilter, latestOnly: boolean): { removed: number; restored: number } {
    this.filter = filter;
    this.latestOnly = latestOnly;
    const before = new Set(this.list.map((q) => q.id));
    const all = [...this.list, ...this.held].sort((x, y) => y.id - x.id);
    let list = all.filter((q) => filter.accepts(q));
    this.held = all.filter((q) => !filter.accepts(q)).slice(0, EXCLUDED_KEEP);
    this.dropped = 0; // 버린 것은 새 필터에 걸리는지 알 수 없으니 세지 않는다
    if (latestOnly) {
      const seen = new Set<string>();
      list = list.filter((q) => {
        const key = sameQueryKey(q);
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    this.list = list;
    this.trim();
    const now = new Set(this.list.map((q) => q.id));
    return { removed: [...before].filter((id) => !now.has(id)).length, restored: [...now].filter((id) => !before.has(id)).length };
  }

  accepts(q: LoggedQuery): boolean {
    return this.filter.accepts(q);
  }

  /** 묶음 열쇠: 요청이 있으면 그 요청, 없으면 같은 스레드에서 THREAD_GAP_MS 안에 이어 돈 것끼리 */
  private groupOf(q: LoggedQuery): string {
    if (q.req) return `r${q.req.id}`;
    const thread = q.thread ?? '';
    const at = q.at ?? q.time;
    const last = this.lastByThread.get(thread);
    const seg = last && at >= last.at && at - last.at <= THREAD_GAP_MS ? last.seg : ++this.segSeq;
    this.lastByThread.delete(thread);
    this.lastByThread.set(thread, { at, seg });
    if (this.lastByThread.size > 64) this.lastByThread.delete(this.lastByThread.keys().next().value as string);
    return `t${seg}`;
  }

  /** 목록에 넣었으면 true, 필터에 걸렸으면 false */
  add(q: LoggedQuery): boolean {
    const group = this.groupOf(q);
    const top = this.list[0];
    if (top && top.group === group && top.sql === q.sql && top.mapper === q.mapper) {
      this.list[0] = Object.assign(q, { id: top.id, group });
      return true;
    }
    const entry = Object.assign(q, { id: ++this.seq, group });
    if (!this.filter.accepts(q)) {
      this.held.unshift(entry);
      if (this.held.length > EXCLUDED_KEEP) {
        this.held.length = EXCLUDED_KEEP;
        this.dropped++;
      }
      return false;
    }
    if (this.latestOnly) {
      const key = sameQueryKey(q);
      if (key) this.list = this.list.filter((x) => sameQueryKey(x) !== key);
    }
    this.list.unshift(entry);
    this.trim();
    return true;
  }

  /** 묶음마다 시작한 차례 (그 묶음의 가장 오래된 쿼리 번호) */
  private starts(): Map<string, number> {
    const start = new Map<string, number>();
    for (const q of this.list) start.set(q.group, Math.min(start.get(q.group) ?? Infinity, q.id));
    return start;
  }

  /** 늦게 시작한 max 개 묶음만 남기고, 묶음마다 먼저 돈 PER_REQUEST 개까지만 (뒤에 넘친 것은 개수만) */
  private trim() {
    const start = this.starts();
    const keep = new Set([...start].sort((x, y) => y[1] - x[1]).slice(0, this.max).map(([g]) => g));
    const kept = new Map<string, number>();
    const drop = new Set<number>();
    // 목록은 새 것부터라 거꾸로(먼저 돈 것부터) 센다
    for (let i = this.list.length - 1; i >= 0; i--) {
      const q = this.list[i];
      if (!keep.has(q.group)) continue;
      const n = kept.get(q.group) ?? 0;
      if (n >= PER_REQUEST) {
        drop.add(q.id);
        this.overflow.set(q.group, (this.overflow.get(q.group) ?? 0) + 1);
      } else kept.set(q.group, n + 1);
    }
    this.list = this.list.filter((q) => keep.has(q.group) && !drop.has(q.id));
    for (const g of this.overflow.keys()) if (!kept.has(g)) this.overflow.delete(g);
  }

  items(): readonly Entry[] {
    return this.list;
  }

  /** 묶음들 — 늦게 시작한 것부터, 안의 쿼리는 돈 차례대로 */
  groups(): QueryGroup[] {
    const start = this.starts();
    const map = new Map<string, QueryGroup>();
    for (const q of this.list) {
      let g = map.get(q.group);
      if (!g) map.set(q.group, (g = { key: q.group, req: q.req, thread: q.thread ?? '', queries: [], overflow: this.overflow.get(q.group) ?? 0 }));
      g.queries.push(q);
    }
    const out = [...map.values()].sort((x, y) => (start.get(y.key) ?? 0) - (start.get(x.key) ?? 0));
    for (const g of out) g.queries.reverse();
    return out;
  }

  get(id: number): Entry | undefined {
    return this.list.find((q) => q.id === id);
  }

  clear() {
    this.list = [];
    this.held = [];
    this.dropped = 0;
    this.overflow.clear();
  }
}

/**
 * SQL 머리 주석에 적힌 쿼리 id. 예: SELECT /*"selectOneUser"*\/ … · /* UserMapper.selectUser *\/ SELECT …
 * (mapper XML 에서 쿼리를 찾을 때 쓰는 이름이라 목록의 제목으로 삼는다. 설명 글 주석은 id 로 보지 않는다)
 */
export function queryId(sql: string): string {
  const c = /^\s*\w+\s*\/\*\s*["']?([\w.$-]{2,80})["']?\s*\*\//.exec(sql) ?? /^\s*\/\*\s*["']?([\w.$-]{2,80})["']?\s*\*\//.exec(sql);
  return c ? c[1] : '';
}

/**
 * 목록에 보일 이름: SQL 머리 주석의 쿼리 id → mapper 메서드 → "SELECT TB_USER"
 */
export function queryTitle(q: LoggedQuery): string {
  const id = queryId(q.sql);
  if (id) return id;
  if (q.mapper) return q.mapper;
  const bare = q.sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const verb = /^\s*([A-Za-z]+)/.exec(bare)?.[1].toUpperCase() ?? 'SQL';
  const table =
    verb === 'UPDATE'
      ? /^\s*UPDATE\s+([\w.$#"]+)/i.exec(bare)
      : verb === 'INSERT' || verb === 'MERGE'
        ? /\bINTO\s+([\w.$#"]+)/i.exec(bare)
        : /\bFROM\s+([\w.$#"]+)/i.exec(bare);
  return table ? `${verb} ${table[1]}` : verb;
}

/** 제목이 주석의 쿼리 id 일 때, 그와 다른 mapper 메서드 이름 (같거나 없으면 '') */
export function queryMapper(q: LoggedQuery): string {
  const id = queryId(q.sql);
  if (!id || !q.mapper) return '';
  const method = q.mapper.slice(q.mapper.lastIndexOf('.') + 1);
  return method === id || q.mapper === id ? '' : q.mapper;
}

/** 따옴표·괄호 밖(맨 바깥)에서 낱말 kw 가 시작하는 자리들을 찾는다. kw 는 대문자 정규식 조각 */
function topLevel(sql: string, kw: RegExp): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      i = quoteEnd(sql, i);
    } else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || !/[\w$#.]/.test(sql[i - 1]))) {
      kw.lastIndex = i;
      const m = kw.exec(sql);
      if (m) {
        out.push({ index: i, text: m[0] });
        i += m[0].length - 1;
      }
    }
  }
  return out;
}

export interface QuerySummary {
  /** SELECT · INSERT · UPDATE · DELETE · MERGE … (대문자) */
  verb: string;
  /** 나오는 테이블 (최대 3개, 그 뒤는 …) */
  tables: string;
  /** 이 실행을 알아볼 조건: WHERE 의 조건 중 값이 들어 있는 첫 번째 것 (INSERT 는 VALUES …) */
  cond: string;
}

/** 주석을 빼고 공백을 하나로 */
const bareSql = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

/** 쿼리에 나오는 테이블 이름 (나온 차례, 겹친 것은 한 번). FROM A a, B b 처럼 쉼표로 이은 것까지 (별칭은 버린다) */
export function tableNames(sql: string): string[] {
  const bare = bareSql(sql);
  const names: string[] = [];
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+((?:[A-Za-z_][\w.$#]*(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*,\s*)*[A-Za-z_][\w.$#]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+/)[0];
      if (n && !/^(SELECT|SET|ONLY|TABLE|LATERAL)$/i.test(n) && !names.includes(n)) names.push(n);
    }
  }
  return names;
}

/** "수집 제외" 단추에 둘 낱말: 쿼리 id(없으면 mapper 이름) · 테이블들 */
export function excludeWords(q: LoggedQuery): { word: string; kind: 'query' | 'table' }[] {
  const id = queryId(q.sql) || q.mapper;
  return [...(id ? [{ word: id, kind: 'query' as const }] : []), ...tableNames(q.sql).map((word) => ({ word, kind: 'table' as const }))];
}

/** 목록에서 쿼리를 알아보기 위한 요약 — 종류, 테이블, 넘어간 값이 보이는 조건 하나 */
export function summarize(sql: string): QuerySummary {
  const bare = bareSql(sql);
  const verb = /^([A-Za-z]+)/.exec(bare)?.[1].toUpperCase() ?? 'SQL';
  const names = tableNames(sql);
  const tables = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');

  let cond = '';
  if (verb === 'INSERT') {
    const v = topLevel(bare, /VALUES(?![\w$#])/iy)[0];
    if (v) cond = bare.slice(v.index);
  } else {
    const w = topLevel(bare, /WHERE(?![\w$#])/iy)[0];
    if (w) {
      let body = bare.slice(w.index + 5);
      const end = topLevel(body, /(?:GROUP\s+BY|ORDER\s+(?:SIBLINGS\s+)?BY|HAVING|UNION|MINUS|INTERSECT|START\s+WITH|CONNECT\s+BY|FOR\s+UPDATE|LIMIT|OFFSET|FETCH)(?![\w$#])/iy)[0];
      if (end) body = body.slice(0, end.index);
      // 맨 바깥 AND/OR 로 나눈다 (BETWEEN a AND b 는 한 조건)
      const cuts = topLevel(body, /(?:AND|OR|BETWEEN)(?![\w$#])/iy);
      const parts: string[] = [];
      let from = 0;
      let between = false;
      for (const c of cuts) {
        const t = c.text.toUpperCase();
        if (t === 'BETWEEN') between = true;
        else if (t === 'AND' && between) between = false;
        else {
          parts.push(body.slice(from, c.index));
          from = c.index + c.text.length;
        }
      }
      parts.push(body.slice(from));
      const conds = parts.map((x) => x.trim()).filter(Boolean);
      cond = conds.find((x) => /'|(?<![\w$#.])\d/.test(x.replace(/^\s*1\s*=\s*1\s*$/, ''))) ?? conds[0] ?? '';
    }
  }
  return { verb, tables, cond: cond.length > 120 ? cond.slice(0, 119) + '…' : cond };
}

/** 이름 뒤에 붙는 짧은 정보: "12건 · 3ms · 실패" */
export function queryInfo(q: LoggedQuery): string {
  const parts: string[] = [];
  if (q.rows !== undefined) parts.push(`${q.rows}건`);
  if (q.ms !== undefined) parts.push(`${q.ms}ms`);
  if (q.failed) parts.push('실패');
  if (q.unbound) parts.push('? 값 없음');
  return parts.join(' · ');
}

/** 보여 주고 옮길 SQL 모양: 한 줄로 찍힌 것만 줄을 나누고, 여러 줄로 찍힌 것은 그대로 */
export function displaySql(q: LoggedQuery): string {
  return q.sql.includes('\n') ? q.sql : layoutSql(q.sql);
}

/** 콘솔에 넣을 글: 어디서 온 쿼리인지 머리 주석 + SQL */
export function consoleText(q: LoggedQuery, timeText: string): string {
  const info = queryInfo(q);
  const mapper = queryMapper(q);
  const head = `-- [로그 ${timeText}] ${queryTitle(q)}${mapper ? ` (${mapper})` : ''}${info ? ` · ${info}` : ''}${q.warn ? ` · ${q.warn}` : ''}`;
  return `${head}\n${displaySql(q)};`;
}

/** 묶음 이름: "GET /api/posts" (요청 줄이 없으면 "스레드 http-nio-8080-exec-1") */
export function groupTitle(g: QueryGroup): string {
  if (g.req) return `${g.req.method} ${g.req.url}`.trim() || '요청';
  return `스레드 ${g.thread || '(이름 없음)'}`;
}

/** 묶음 요약: "200 · 236ms · 쿼리 14" (끝나지 않은 요청은 "진행 중") */
export function groupInfo(g: QueryGroup): string {
  const parts: string[] = [];
  if (g.req) {
    if (g.req.status) parts.push(String(g.req.status));
    if (g.req.ms !== undefined) parts.push(`${g.req.ms}ms`);
    if (!g.req.ended) parts.push('진행 중');
  }
  parts.push(`쿼리 ${g.queries.length + g.overflow}`);
  return parts.join(' · ');
}

/** 요청 안에서 몇 ms 뒤에 돌았는지 ("+12ms", 시각을 모르면 '') */
export function offsetText(g: QueryGroup, q: LoggedQuery): string {
  const from = g.req?.at ?? g.queries[0]?.at;
  if (from === undefined || q.at === undefined || q.at < from) return '';
  return `+${q.at - from}ms`;
}

/**
 * 묶음째 콘솔에 넣을 글: 요청 머리 주석 + 쿼리를 돈 차례대로. 값만 다른 반복(at 번 이상)은 처음 것만 넣고 횟수를 적는다
 */
export function groupConsoleText(g: QueryGroup, timeText: (q: LoggedQuery) => string, at: number): string {
  const many = new Map(repeats(g.queries, at).map((r) => [r.key, r.count]));
  const done = new Set<string>();
  const out = [`-- [요청] ${groupTitle(g)} · ${groupInfo(g)}`];
  for (const q of g.queries) {
    const k = repeatKey(q);
    const n = many.get(k);
    if (n) {
      if (done.has(k)) continue;
      done.add(k);
      out.push(`-- N+1 의심: 값만 바꿔 ${n}번 돈 쿼리 (첫 번째만)\n${consoleText(q, timeText(q))}`);
    } else {
      out.push(consoleText(q, timeText(q)));
    }
  }
  if (g.overflow) out.push(`-- (뒤에 돈 쿼리 ${g.overflow}개는 담지 못했습니다)`);
  return out.join('\n\n');
}
