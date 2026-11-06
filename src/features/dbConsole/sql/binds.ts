import { skipQuoted, DialectRules, GENERIC_RULES } from './statements';

/**
 * SQL 안의 파라미터(바인드 변수)를 찾고 값을 드라이버에 넘길 모양으로 바꾼다.
 * vscode·oracledb 모듈에 의존하지 않는다 — 확장과 콘솔 화면(Webview) 양쪽에서 쓴다.
 *
 * 인식하는 모양:
 *  - `:name`            오라클 바인드 변수
 *  - `#{name}`          MyBatis 파라미터 (mapper XML 의 쿼리를 그대로 붙여 넣었을 때). `#{a.b, jdbcType=VARCHAR}` → 이름 a_b
 * 문자열·주석 안의 것, `:=`(PL/SQL 대입), `12:30` 같은 숫자, 트리거의 `:new`·`:old` 는 파라미터가 아니다
 */

export interface Bind {
  /** 드라이버에 넘길 이름 (영문·숫자·_) */
  name: string;
  /** 글에 적힌 그대로: ":status", "#{order.id}" */
  raw: string;
  start: number;
  end: number;
}

export type BindType = 'VARCHAR2' | 'NUMBER' | 'DATE';
export const BIND_TYPES: BindType[] = ['VARCHAR2', 'NUMBER', 'DATE'];

const NAME_START = /[A-Za-z_]/;
const NAME_REST = /[\w$#]/;
const RESERVED = new Set(['new', 'old']); // 트리거 본문의 :new.col, :old.col

export function findBinds(sql: string, rules: DialectRules = GENERIC_RULES): Bind[] {
  const out: Bind[] = [];
  let i = 0;
  while (i < sql.length) {
    const q = skipQuoted(sql, i, rules);
    if (q >= 0) {
      i = q;
      continue;
    }
    const c = sql[i];
    if (c === ':' && NAME_START.test(sql[i + 1] ?? '') && !/[\w:]/.test(sql[i - 1] ?? ' ')) {
      let j = i + 2;
      while (j < sql.length && NAME_REST.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!RESERVED.has(name.toLowerCase())) out.push({ name, raw: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (c === '#' && sql[i + 1] === '{') {
      const close = sql.indexOf('}', i + 2);
      if (close > 0) {
        // #{order.id, jdbcType=NUMERIC} → 쉼표 앞이 이름
        const inner = sql.slice(i + 2, close).split(',')[0].trim();
        const name = inner.replace(/[^\w$#]+/g, '_').replace(/^_+|_+$/g, '');
        if (name && NAME_START.test(name[0])) out.push({ name, raw: sql.slice(i, close + 1), start: i, end: close + 1 });
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** 파라미터 이름들 (나온 순서, 같은 이름은 한 번. 오라클처럼 대소문자를 구분하지 않는다) */
export function bindNames(sql: string, rules: DialectRules = GENERIC_RULES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of findBinds(sql, rules)) {
    const key = b.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(b.name);
    }
  }
  return out;
}

/** 드라이버에 보낼 SQL: MyBatis 의 `#{name}` 을 `:name` 으로 바꾼다 (`:name` 은 그대로) */
export function toDriverSql(sql: string, rules: DialectRules = GENERIC_RULES): string {
  let out = '';
  let at = 0;
  for (const b of findBinds(sql, rules)) {
    out += sql.slice(at, b.start) + ':' + b.name;
    at = b.end;
  }
  return out + sql.slice(at);
}

const DATE_RE = /^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** 값의 모양으로 타입을 짐작한다: 숫자 → NUMBER, 날짜 → DATE, 그 밖 → VARCHAR2. 0 으로 시작하는 숫자(코드값 "0012")는 글자 */
export function inferType(value: string): BindType {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^-?0\d/.test(v)) return 'NUMBER';
  if (/^\d{4}[-/.]\d{2}[-/.]\d{2}/.test(v) && DATE_RE.test(v)) return 'DATE';
  return 'VARCHAR2';
}

export type BindValue = string | number | Date | null;

/**
 * 화면에 넣은 글 → 드라이버에 넘길 값. 비어 있으면 NULL.
 * 타입에 맞지 않으면 이유를 돌려준다
 */
export function parseBindValue(value: string, type: BindType): { ok: true; value: BindValue } | { ok: false; message: string } {
  if (value === '') return { ok: true, value: null };
  if (type === 'NUMBER') {
    const n = Number(value.trim());
    return value.trim() !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: `숫자가 아닙니다: ${value}` };
  }
  if (type === 'DATE') {
    const m = DATE_RE.exec(value.trim());
    if (!m) return { ok: false, message: `날짜 모양이 아닙니다 (예: 2026-11-01, 2026-11-01 14:30:00): ${value}` };
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number);
    const date = new Date(y, mo - 1, d, h, mi, s);
    // 2026-02-31 처럼 없는 날짜는 다른 날로 넘어간다 → 넣은 값과 같은지 확인
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59 || s > 59) {
      return { ok: false, message: `없는 날짜입니다: ${value}` };
    }
    return { ok: true, value: date };
  }
  return { ok: true, value };
}

/** 화면의 파라미터 한 칸 */
export interface BindInput {
  value: string;
  /** 사용자가 정한 타입. 없으면 값으로 짐작 */
  type?: BindType;
}

/**
 * 문장 하나에 넘길 파라미터 값. 그 문장에 나오는 이름만 넣는다 (드라이버는 남는 이름이 있으면 오류를 낸다).
 * 이름은 대소문자를 구분하지 않고 찾는다. 값이 없는 파라미터는 NULL
 */
export function bindValuesFor(sql: string, inputs: Record<string, BindInput>, rules: DialectRules = GENERIC_RULES): { ok: true; values: Record<string, { value: BindValue; type: BindType }> } | { ok: false; message: string } {
  const byLower = new Map(Object.entries(inputs).map(([k, v]) => [k.toLowerCase(), v]));
  const values: Record<string, { value: BindValue; type: BindType }> = {};
  for (const name of bindNames(sql, rules)) {
    const input = byLower.get(name.toLowerCase()) ?? { value: '' };
    const type = input.type ?? inferType(input.value);
    const parsed = parseBindValue(input.value, type);
    if (!parsed.ok) return { ok: false, message: `:${name} — ${parsed.message}` };
    values[name] = { value: parsed.value, type };
  }
  return { ok: true, values };
}

/**
 * 이름 파라미터(:name)를 자리 표시로 바꾸고 값을 나온 순서대로 늘어놓는다.
 * PostgreSQL 은 $1, $2 … (같은 이름은 같은 번호), MySQL 은 ? (나올 때마다 값을 다시 넣는다)
 */
export function toPositional(
  sql: string,
  binds: Record<string, { value: BindValue }>,
  rules: DialectRules,
  style: 'dollar' | 'question'
): { sql: string; values: BindValue[] } {
  const byLower = new Map(Object.entries(binds).map(([k, v]) => [k.toLowerCase(), v.value]));
  const values: BindValue[] = [];
  const numbers = new Map<string, number>();
  let out = '';
  let at = 0;
  for (const b of findBinds(sql, rules)) {
    const key = b.name.toLowerCase();
    let mark: string;
    if (style === 'dollar') {
      let n = numbers.get(key);
      if (n === undefined) {
        values.push(byLower.get(key) ?? null);
        numbers.set(key, (n = values.length));
      }
      mark = `$${n}`;
    } else {
      values.push(byLower.get(key) ?? null);
      mark = '?';
    }
    out += sql.slice(at, b.start) + mark;
    at = b.end;
  }
  return { sql: out + sql.slice(at), values };
}
