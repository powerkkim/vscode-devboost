/**
 * 실행 로그에서 MyBatis 쿼리를 골라 값까지 채운 SQL 로 만든다. vscode 모듈에 의존하지 않아 단독 테스트가 가능하다.
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

/** SQL 의 ? 자리에 값을 차례로 넣는다. 따옴표 안·주석 안의 ? 는 건드리지 않는다 */
export function bindSql(sql: string, params: LogParam[]): { sql: string; placeholders: number } {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // 따옴표 글: 닫는 따옴표까지 ('' 는 따옴표 한 글자)
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j++;
          else break;
        }
        j++;
      }
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
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === c) {
          if (s[j + 1] === c) j++;
          else break;
        }
        j++;
      }
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
  return TIME_HEAD.test(line) || LEVEL_HEAD.test(line);
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

/** 줄 머리의 스레드 이름 "[http-nio-8080-exec-5]" (없으면 '') — 같은 요청의 로그끼리 묶는 데 쓴다 */
function threadOf(prefix: string): string {
  const m = /\[([^\]]*[A-Za-z][^\]]*)\]/.exec(prefix);
  return m ? m[1].trim() : '';
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
    const q = t.indexOf("'");
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
  ls[0] = ls[0].replace(/^\s*\d+\.\s/, '').trimStart();
  let indent = Infinity;
  for (let i = 1; i < ls.length; i++) {
    if (ls[i].trim()) indent = Math.min(indent, ls[i].length - ls[i].trimStart().length);
  }
  if (indent !== Infinity && indent > 0) {
    for (let i = 1; i < ls.length; i++) ls[i] = ls[i].slice(Math.min(indent, ls[i].length - ls[i].trimStart().length));
  }
  return ls.join('\n').replace(/;\s*$/, '');
}

/** 붙잡아 두는 줄·짝 없는 Preparing 의 상한 (로그가 끝없이 와도 메모리가 늘지 않게) */
const MAX_LINE = 200_000;
const MAX_OPEN = 50;

type Source = 'mybatis' | 'sqlonly' | 'sqltiming';

/**
 * 로그를 조각(chunk)으로 받아 완성된 쿼리를 돌려준다. 실행 하나(터미널 명령 하나)마다 하나씩 만든다.
 * 스레드가 섞여 찍혀도 로거·스레드가 같은 Preparing ↔ Parameters 끼리 짝짓는다
 */
export class LogReader {
  private buf = '';
  /** 아직 다음 줄을 기다리는 "==>" 줄 (터미널 폭에서 잘린 나머지가 이어질 수 있어서) */
  private held: string | undefined;
  /** 읽는 중인 log4jdbc 덩어리 */
  private block: { kind: 'sqlonly' | 'sqltiming'; thread: string; lines: string[]; size: number } | undefined;
  /** 열쇠 → Preparing 의 SQL */
  private open = new Map<string, { sql: string; mapper: string }>();
  /** 열쇠 → 방금 내보낸 쿼리 (Total 이 오면 건수를 적는다) */
  private last = new Map<string, LoggedQuery>();
  /** 스레드 → 그 스레드에서 방금 내보낸 쿼리와, 그 쿼리를 본 로그 종류 (같은 실행의 다른 로그를 한 건으로 합친다) */
  private byThread = new Map<string, { q: LoggedQuery; seen: Set<Source> }>();

  constructor(private readonly now: () => number = Date.now) {}

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
    // sqlonly 는 꼬리가 없어 다음 로그가 와야 끝난다 → 로그가 멈췄으면 여기서 끝낸다
    if (this.block?.kind === 'sqlonly') this.finishBlock(out);
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
        this.block.lines.push(line);
        this.block.size += line.length;
        return;
      }
      this.finishBlock(out); // 다음 로그가 시작됨 (sqlonly, 또는 꼬리를 못 본 sqltiming)
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
      this.block = { kind: j[2] as 'sqlonly' | 'sqltiming', thread: threadOf(j[1]), lines: [], size: 0 };
      const rest = j[3];
      const tail = JDBC_TAIL.exec(rest);
      if (tail) {
        // 한 줄로 찍힌 경우: SQL {executed in N msec}
        this.block.lines.push(rest.slice(0, tail.index));
        this.finishBlock(out, Number(tail[2]), tail[1] !== 'executed in');
      } else if (rest.trim() && !CALL_SITE.test(rest)) {
        this.block.lines.push(rest);
      }
    }
  }

  private finishBlock(out: LoggedQuery[], ms?: number, failed?: boolean) {
    const b = this.block;
    this.block = undefined;
    if (!b) return;
    const sql = tidyBlock(b.lines);
    if (!sql) return;
    const prev = this.byThread.get(b.thread);
    if (prev && !prev.seen.has(b.kind) && sameHead(prev.q.sql, sql)) {
      // 같은 실행을 다른 로그가 먼저 알려 줌 → 한 건으로. SQL 은 실제로 실행된 글(log4jdbc)로 바꾼다
      prev.seen.add(b.kind);
      prev.q.sql = sql;
      prev.q.warn = undefined;
      if (ms !== undefined) prev.q.ms = ms;
      if (failed) prev.q.failed = true;
      return;
    }
    const q: LoggedQuery = { sql, mapper: '', time: this.now() };
    if (ms !== undefined) q.ms = ms;
    if (failed) q.failed = true;
    this.remember(b.thread, q, b.kind);
    out.push(q);
  }

  private remember(thread: string, q: LoggedQuery, src: Source) {
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
    if (bound.placeholders !== params.length) q.warn = `? ${bound.placeholders}개, 값 ${params.length}개 — 로그 줄이 잘렸을 수 있습니다`;
    this.last.delete(key);
    this.last.set(key, q);
    if (this.last.size > MAX_OPEN) this.last.delete(this.last.keys().next().value as string);
    this.remember(threadOf(m[1]), q, 'mybatis');
    out.push(q);
  }

  private total(line: string) {
    const m = /^(.*?)<==\s*(?:Total|Updates):\s*(\d+)/.exec(line);
    if (!m) return;
    const q = this.last.get(prefixKey(m[1]));
    if (q) q.rows = Number(m[2]);
  }
}

/** 최근 쿼리 목록 (새 것이 앞). 바로 앞과 같은 SQL 이 또 오면 시각만 바꾼다 */
export class QueryRing {
  private list: (LoggedQuery & { id: number })[] = [];
  private seq = 0;

  constructor(private max: number) {}

  setMax(max: number) {
    this.max = Math.max(1, max);
    this.list.length = Math.min(this.list.length, this.max);
  }

  add(q: LoggedQuery): void {
    const top = this.list[0];
    if (top && top.sql === q.sql && top.mapper === q.mapper) {
      this.list[0] = Object.assign(q, { id: top.id });
      return;
    }
    this.list.unshift(Object.assign(q, { id: ++this.seq }));
    if (this.list.length > this.max) this.list.length = this.max;
  }

  items(): readonly (LoggedQuery & { id: number })[] {
    return this.list;
  }

  get(id: number): (LoggedQuery & { id: number }) | undefined {
    return this.list.find((q) => q.id === id);
  }

  clear() {
    this.list = [];
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
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      i = j;
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

/** 목록에서 쿼리를 알아보기 위한 요약 — 종류, 테이블, 넘어간 값이 보이는 조건 하나 */
export function summarize(sql: string): QuerySummary {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  const verb = /^([A-Za-z]+)/.exec(bare)?.[1].toUpperCase() ?? 'SQL';
  const names: string[] = [];
  // FROM A a, B b 처럼 쉼표로 이은 것까지 (별칭은 버린다)
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+((?:[A-Za-z_][\w.$#]*(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s*,\s*)*[A-Za-z_][\w.$#]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+/)[0];
      if (n && !/^(SELECT|SET|ONLY|TABLE|LATERAL)$/i.test(n) && !names.includes(n)) names.push(n);
    }
  }
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
