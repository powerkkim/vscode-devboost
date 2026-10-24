/**
 * 화면에서 입력한 파라미터 값 → 평가용 값, 평가용 값 → SQL 리터럴 (vscode 의존 없음)
 */

/** 화면에서 고르는 값 종류 */
export type ParamType = 'auto' | 'string' | 'number' | 'date' | 'list' | 'json' | 'null' | 'empty';

export interface ParamInput {
  type: ParamType;
  value: string;
}

/** 날짜 값. OGNL 평가에서는 null 이 아닌 객체, SQL 에서는 TO_DATE(...) */
export class SqlDate {
  constructor(readonly text: string) {}
  toString() {
    return this.text;
  }
}

const NUMBER_RE = /^[+-]?(0|[1-9]\d*)(\.\d+)?$/;

/** auto 타입: 입력 모양을 보고 정한다. 빈칸은 null(= 조건 없음) */
function autoValue(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return null;
  if (v === 'null') return null;
  if (v === 'true' || v === 'false') return v === 'true';
  // 앞자리 0 이 있는 '001' 같은 코드값은 문자열로 둔다
  if (NUMBER_RE.test(v) && v.length < 16) return Number(v);
  if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
    try {
      return JSON.parse(v);
    } catch {
      /* 문자열로 */
    }
  }
  return raw;
}

export function convertInput(input: ParamInput | undefined): unknown {
  if (!input) return null;
  const raw = input.value ?? '';
  switch (input.type) {
    case 'null':
      return null;
    case 'empty':
      return '';
    case 'string':
      return raw;
    case 'number': {
      if (raw.trim() === '') return null;
      const n = Number(raw.trim());
      return Number.isFinite(n) ? n : raw;
    }
    case 'date':
      return raw.trim() === '' ? null : new SqlDate(raw.trim());
    case 'list': {
      const t = raw.trim();
      if (t === '') return null;
      if (t.startsWith('[')) {
        try {
          return JSON.parse(t);
        } catch {
          /* 쉼표 구분으로 */
        }
      }
      return t
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((s) => {
          const q = /^'(.*)'$|^"(.*)"$/.exec(s);
          return q ? (q[1] ?? q[2]) : autoValue(s);
        });
    }
    case 'json': {
      if (raw.trim() === '') return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    default:
      return autoValue(raw);
  }
}

/**
 * 경로별 입력값을 중첩 객체로 만든다.
 * { 'user.name': '홍', 'ids': '1,2' } → { user: { name: '홍' }, ids: [1, 2] }
 */
export function buildParamObject(inputs: Record<string, ParamInput>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  // 짧은 경로부터: user(json) 를 먼저 넣고 user.name 으로 덮어쓴다
  const keys = Object.keys(inputs).sort((a, b) => a.split('.').length - b.split('.').length);
  for (const key of keys) {
    const value = convertInput(inputs[key]);
    const parts = key.split('.');
    let cur: Record<string, unknown> = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const next = cur[p];
      if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
        // 상위 경로가 비어 있으면 객체를 만들지 않는다: user.name 이 비어 있으면 user 는 null 로 남아야
        // <if test="user != null"> 가 거짓이 됨
        if (value === null || value === undefined) {
          cur = undefined as unknown as Record<string, unknown>;
          break;
        }
        cur[p] = {};
      }
      cur = cur[p] as Record<string, unknown>;
    }
    if (cur) {
      const last = parts[parts.length - 1];
      if (!(last in cur) || (value !== null && value !== undefined)) cur[last] = value;
    }
  }
  return root;
}

const DATE_RE = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:[ T](\d{2}):?(\d{2})(?::?(\d{2}))?(?:\.(\d{1,9}))?)?$/;

interface DateParts {
  date: string;
  time?: string;
  frac?: string;
}

function parseDate(text: string): DateParts | null {
  const m = DATE_RE.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  return { date: `${y}-${mo}-${d}`, time: h ? `${h}:${mi}:${s ?? '00'}` : undefined, frac };
}

/** 날짜 문자열을 Oracle 변환 함수의 (값, 형식, 함수) 로 정규화 */
function oracleDate(text: string, jdbcType?: string): { value: string; format: string; fn: 'TO_DATE' | 'TO_TIMESTAMP' } | null {
  const p = parseDate(text);
  if (!p) return null;
  const ts = (jdbcType ?? '').toUpperCase() === 'TIMESTAMP';
  if (p.frac || ts) {
    return {
      value: `${p.date} ${p.time ?? '00:00:00'}${p.frac ? '.' + p.frac : ''}`,
      format: `YYYY-MM-DD HH24:MI:SS${p.frac ? '.FF' : ''}`,
      fn: 'TO_TIMESTAMP',
    };
  }
  if (p.time) return { value: `${p.date} ${p.time}`, format: 'YYYY-MM-DD HH24:MI:SS', fn: 'TO_DATE' };
  return { value: p.date, format: 'YYYY-MM-DD', fn: 'TO_DATE' };
}

/** 'YYYY-MM-DD[ HH:MI[:SS]]' 형태면 Oracle 함수 문자열로 */
export function oracleDateLiteral(text: string, jdbcType?: string): string | null {
  const d = oracleDate(text, jdbcType);
  return d ? `${d.fn}('${d.value}', '${d.format}')` : null;
}

export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 평가용 값 → SQL 리터럴. 넣을 수 없는 값이면 problem 에 이유 */
export function toSqlLiteral(v: unknown, jdbcType?: string): { sql: string; problem?: string } {
  const jt = (jdbcType ?? '').toUpperCase();
  if (v === null || v === undefined) return { sql: 'NULL' };
  if (typeof v === 'number') return { sql: Number.isFinite(v) ? String(v) : 'NULL' };
  if (typeof v === 'boolean') return { sql: v ? '1' : '0' };
  if (v instanceof SqlDate) {
    const d = oracleDateLiteral(v.text, jt);
    return d ? { sql: d } : { sql: quote(v.text), problem: `날짜 형식이 아님: ${v.text} (예: 2026-10-25, 2026-10-25 13:30:00)` };
  }
  if (typeof v === 'string') {
    if (jt === 'DATE' || jt === 'TIMESTAMP') {
      const d = oracleDateLiteral(v, jt);
      if (d) return { sql: d };
    }
    if (/^(NUMERIC|DECIMAL|INTEGER|BIGINT|SMALLINT|TINYINT|DOUBLE|FLOAT|REAL)$/.test(jt) && NUMBER_RE.test(v.trim())) {
      return { sql: v.trim() };
    }
    return { sql: quote(v) };
  }
  if (typeof v === 'object' && v && 'c' in v && Object.keys(v).length === 1) {
    return { sql: quote(String((v as { c: string }).c)) };
  }
  return { sql: quote(JSON.stringify(v)), problem: '목록·객체 값은 #{} 하나에 넣을 수 없음' };
}

/** ${} 에 들어갈 문자열 (MyBatis: null → 빈 문자열) */
export function toRawText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !(v instanceof SqlDate) && !('c' in (v as object))) return JSON.stringify(v);
  return String(v);
}

/** 화면 표시용 짧은 값 */
export function describeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return `"${v}"`;
  if (v instanceof SqlDate) return `날짜 ${v.text}`;
  if (Array.isArray(v)) return `목록 ${v.length}개`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v);
}

/**
 * 바인드 변수 스크립트용 값 (SQL*Plus VARIABLE / EXEC).
 *  - varType: VARIABLE 선언 타입. VARIABLE 은 DATE 를 못 만들므로 날짜는 문자열로 넣고
 *  - wrap: SQL 쪽에서 TO_DATE(:이름, '형식') 으로 감싼다
 *  - assign: EXEC :이름 := <assign>; 의 오른쪽 (null 이면 NULL — 세션에 남은 이전 값을 지우기 위해 항상 넣는다)
 */
export interface BindValue {
  varType: string;
  assign: string;
  wrap?: (ref: string) => string;
  problem?: string;
}

export function toBindValue(v: unknown, jdbcType?: string): BindValue {
  const jt = (jdbcType ?? '').toUpperCase();
  const numericJt = /^(NUMERIC|DECIMAL|INTEGER|BIGINT|SMALLINT|TINYINT|DOUBLE|FLOAT|REAL|BIT|BOOLEAN)$/.test(jt);
  const dateJt = jt === 'DATE' || jt === 'TIMESTAMP';
  if (v === null || v === undefined) {
    return { varType: numericJt ? 'NUMBER' : 'VARCHAR2(4000)', assign: 'NULL' };
  }
  if (typeof v === 'number') return { varType: 'NUMBER', assign: Number.isFinite(v) ? String(v) : 'NULL' };
  if (typeof v === 'boolean') return { varType: 'NUMBER', assign: v ? '1' : '0' };
  const dateText = v instanceof SqlDate ? v.text : typeof v === 'string' && dateJt ? v : undefined;
  if (dateText !== undefined) {
    const d = oracleDate(dateText, jt);
    if (d) {
      return { varType: 'VARCHAR2(40)', assign: quote(d.value), wrap: (ref) => `${d.fn}(${ref}, '${d.format}')` };
    }
    if (v instanceof SqlDate) return { varType: 'VARCHAR2(4000)', assign: quote(dateText), problem: `날짜 형식이 아님: ${dateText}` };
  }
  if (typeof v === 'string') {
    if (numericJt && NUMBER_RE.test(v.trim())) return { varType: 'NUMBER', assign: v.trim() };
    if (v.length > 4000) return { varType: 'CLOB', assign: quote(v), problem: '4000자가 넘는 값은 CLOB 변수로 선언함 (EXEC 한 줄 길이 제한에 걸릴 수 있음)' };
    return { varType: 'VARCHAR2(4000)', assign: quote(v) };
  }
  if (typeof v === 'object' && v && 'c' in v && Object.keys(v).length === 1) {
    return { varType: 'VARCHAR2(4000)', assign: quote(String((v as { c: string }).c)) };
  }
  return { varType: 'VARCHAR2(4000)', assign: quote(JSON.stringify(v)), problem: '목록·객체 값은 #{} 하나에 넣을 수 없음' };
}
