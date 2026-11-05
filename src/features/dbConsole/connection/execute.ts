import type { Connection, ResultSet, ColumnMeta } from 'oracledb';
import type { BindType, BindValue } from '../sql/binds';

/**
 * 문장 하나를 실행하고 결과를 화면에 보여 줄 모양으로 바꾼다 (vscode 모듈에 의존하지 않는다).
 * 조회는 처음 pageSize 행만 가져오고, 나머지는 열어 둔 커서(RowCursor)에서 이어 받는다.
 */

/** 화면에 보여 줄 칸 값. null 은 DB 의 NULL */
export type Cell = string | null;

export interface Column {
  name: string;
  /** VARCHAR2, NUMBER, DATE … */
  type: string;
  /** 숫자 칸 (오른쪽 정렬) */
  numeric: boolean;
}

export interface Page {
  rows: Cell[][];
  /** 더 가져올 행이 없음 */
  done: boolean;
}

export type RunResult =
  | { kind: 'rows'; columns: Column[]; page: Page; cursor?: RowCursor; ms: number }
  | { kind: 'count'; rowsAffected: number; ms: number }
  | { kind: 'ok'; ms: number };

/** 열어 둔 조회 결과: 다음 행들을 이어 받는다. 다 받았거나 필요 없어지면 닫는다 */
export class RowCursor {
  private closed = false;
  constructor(private readonly rs: ResultSet) {}

  async next(count: number): Promise<Page> {
    if (this.closed) return { rows: [], done: true };
    const raw = await this.rs.getRows(count);
    const done = raw.length < count;
    if (done) await this.close();
    return { rows: raw.map((r) => r.map(formatCell)), done };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rs.close().catch(() => undefined);
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 날짜: 2026-11-05 14:22:10 (시각이 자정이면 날짜만, 밀리초가 있으면 .123 까지) */
export function formatDate(d: Date): string {
  if (isNaN(d.getTime())) return String(d);
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ms = d.getMilliseconds();
  if (!d.getHours() && !d.getMinutes() && !d.getSeconds() && !ms) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? '.' + pad(ms, 3) : ''}`;
}

/** 화면에 다 싣지 않는 길이 (긴 글·바이너리) */
export const MAX_CELL_CHARS = 4000;
const MAX_HEX_BYTES = 32;

/** 드라이버가 준 값 → 화면 글자 */
export function formatCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + `… (${v.length.toLocaleString('en-US')}자)` : v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return formatDate(v);
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, MAX_HEX_BYTES).toString('hex').toUpperCase();
    return v.length > MAX_HEX_BYTES ? `${hex}… (${v.length.toLocaleString('en-US')}바이트)` : hex;
  }
  try {
    return JSON.stringify(v); // 객체 타입·JSON 칸 등
  } catch {
    return String(v);
  }
}

/** 드라이버의 칸 정보 → 화면 칸 */
export function toColumn(m: ColumnMeta): Column {
  const type = m.dbTypeName ?? m.dbType?.columnTypeName ?? '';
  return { name: m.name, type, numeric: /^(NUMBER|FLOAT|BINARY_FLOAT|BINARY_DOUBLE|BINARY_INTEGER)$/i.test(type) };
}

/**
 * 문장 하나를 실행한다. 자동 커밋하지 않는다 (커밋·롤백은 따로).
 * - 조회: 처음 pageSize 행 + 이어 받을 커서 (다 받았으면 커서 없음)
 * - INSERT·UPDATE·DELETE·MERGE: 바뀐 행 수
 * - 그 밖(DDL·PL/SQL): 성공 여부만
 */
/** 문장에 넘길 파라미터 값 (이름 → 값과 타입) */
export type Binds = Record<string, { value: BindValue; type: BindType }>;

/** 파라미터 값 → 드라이버가 받는 모양. 타입을 함께 넘겨야 NULL 이나 날짜가 뜻대로 들어간다 */
function toDriverBinds(oracledb: typeof import('oracledb'), binds: Binds): Record<string, unknown> {
  const types = { VARCHAR2: oracledb.DB_TYPE_VARCHAR, NUMBER: oracledb.DB_TYPE_NUMBER, DATE: oracledb.DB_TYPE_DATE };
  const out: Record<string, unknown> = {};
  for (const [name, b] of Object.entries(binds)) out[name] = { val: b.value, type: types[b.type] };
  return out;
}

export async function runStatement(connection: Connection, sql: string, pageSize: number, binds: Binds = {}): Promise<RunResult> {
  // 여기서 require: 드라이버는 처음 접속할 때 이미 읽혀 있다
  const oracledb = require('oracledb') as typeof import('oracledb');
  const started = Date.now();
  const r = await connection.execute(sql, toDriverBinds(oracledb, binds), {
    resultSet: true,
    autoCommit: false,
    // 숫자는 글자로 받는다: JS 숫자로 바꾸면 16자리를 넘는 값·소수가 달라진다. CLOB 은 글자로, BLOB 은 바이트로 (LOB 객체로 받지 않게)
    fetchTypeHandler: (meta: ColumnMeta) => {
      if (meta.dbType === oracledb.DB_TYPE_NUMBER) return { type: oracledb.STRING };
      if (meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
      if (meta.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
      return undefined;
    },
  });
  if (r.resultSet) {
    const cursor = new RowCursor(r.resultSet);
    try {
      const columns = (r.metaData ?? r.resultSet.metaData ?? []).map(toColumn);
      const page = await cursor.next(pageSize);
      return { kind: 'rows', columns, page, cursor: page.done ? undefined : cursor, ms: Date.now() - started };
    } catch (e) {
      await cursor.close();
      throw e;
    }
  }
  const ms = Date.now() - started;
  return typeof r.rowsAffected === 'number' ? { kind: 'count', rowsAffected: r.rowsAffected, ms } : { kind: 'ok', ms };
}

let planSeq = 0;

/**
 * 실행계획: EXPLAIN PLAN 으로 계획을 만들고 DBMS_XPLAN 이 그려 준 표를 줄 단위로 받는다.
 * 문장을 실제로 실행하지는 않는다 (데이터는 바뀌지 않는다). 계획은 이 접속의 PLAN_TABLE 에만 남는다
 */
export async function explainPlan(connection: Connection, sql: string, binds: Binds = {}): Promise<{ lines: string[]; ms: number }> {
  const oracledb = require('oracledb') as typeof import('oracledb');
  const started = Date.now();
  const id = `DEVBOOST_${Date.now() % 100000000}_${++planSeq}`;
  await connection.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`, toDriverBinds(oracledb, binds), { autoCommit: false });
  const r = await connection.execute(`SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '${id}', 'TYPICAL'))`, [], { autoCommit: false });
  return { lines: (r.rows ?? []).map((row) => String(row[0] ?? '')), ms: Date.now() - started };
}

/** 오류가 난 자리 (문장 안에서 몇 번째 글자인지). 드라이버가 알려 줄 때만 */
export function errorOffset(e: unknown): number | undefined {
  const off = (e as { offset?: unknown } | undefined)?.offset;
  return typeof off === 'number' && off >= 0 ? off : undefined;
}
