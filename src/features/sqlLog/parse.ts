/**
 * 실행 로그에서 MyBatis 쿼리를 골라 값까지 채운 SQL 로 만든다. vscode 모듈에 의존하지 않아 단독 테스트가 가능하다.
 *
 *   ... c.e.m.UserMapper.selectUser : ==>  Preparing: SELECT * FROM TB_USER WHERE ID = ? AND NM = ?
 *   ... c.e.m.UserMapper.selectUser : ==> Parameters: 10(Integer), kim(String)
 *   ... c.e.m.UserMapper.selectUser : <==      Total: 1
 *   → SELECT * FROM TB_USER WHERE ID = 10 AND NM = 'kim'
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

/** 새 로그 줄의 시작인가 (시각·로그 수준·예외 줄). 아니면 터미널 폭에서 잘려 넘어온 앞 줄의 나머지로 본다 */
function startsRecord(line: string): boolean {
  return (
    line.includes('==>') ||
    line.includes('<==') ||
    /^\s*\[?\d{2,4}[-/.:]\d{2}/.test(line) ||
    /^\s*\[?\s*(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/.test(line) ||
    /^\s*(at\s|Caused by|\.\.\. \d+ more|[a-z]+(\.[\w$]+)+(Exception|Error)\b)/.test(line) ||
    /^[>$#]\s|^\s*$/.test(line)
  );
}

/** "==>" 앞부분에서 시각을 뺀 것 — Preparing 과 Parameters 를 짝짓는 열쇠 (스레드·로거가 들어 있다) */
function prefixKey(prefix: string): string {
  return prefix.replace(/^[\s\d\-/:.,TZ+[\]]+/, '').trim();
}

/** "... c.e.m.UserMapper.selectUser :" → "UserMapper.selectUser" */
function mapperOf(prefix: string): string {
  const all = prefix.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g);
  if (!all) return '';
  const parts = all[all.length - 1].split('.');
  return parts.slice(-2).join('.');
}

/** 붙잡아 두는 줄·짝 없는 Preparing 의 상한 (로그가 끝없이 와도 메모리가 늘지 않게) */
const MAX_LINE = 200_000;
const MAX_OPEN = 50;

/**
 * 로그를 조각(chunk)으로 받아 완성된 쿼리를 돌려준다. 실행 하나(터미널 명령 하나)마다 하나씩 만든다.
 * 스레드가 섞여 찍혀도 로거·스레드가 같은 Preparing ↔ Parameters 끼리 짝짓는다
 */
export class LogReader {
  private buf = '';
  /** 아직 다음 줄을 기다리는 "==>" 줄 (터미널 폭에서 잘린 나머지가 이어질 수 있어서) */
  private held: string | undefined;
  /** 열쇠 → Preparing 의 SQL */
  private open = new Map<string, { sql: string; mapper: string }>();
  /** 열쇠 → 방금 내보낸 쿼리 (Total 이 오면 건수를 적는다) */
  private last = new Map<string, LoggedQuery>();

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
    return out;
  }

  private line(line: string, out: LoggedQuery[]) {
    if (this.held !== undefined && !startsRecord(line) && this.held.length < MAX_LINE) {
      this.held += line; // 폭에서 잘린 줄의 나머지
      return;
    }
    this.release(out);
    if (line.includes('==>')) this.held = line;
    else if (line.includes('<==')) this.total(line);
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

/** 콘솔에 넣을 글: 어디서 온 쿼리인지 머리 주석 + 줄을 나눈 SQL */
export function consoleText(q: LoggedQuery, timeText: string): string {
  const head = `-- [로그 ${timeText}] ${q.mapper || 'SQL'}${q.rows !== undefined ? ` · ${q.rows}건` : ''}${q.warn ? ` · ${q.warn}` : ''}`;
  return `${head}\n${layoutSql(q.sql)};`;
}
