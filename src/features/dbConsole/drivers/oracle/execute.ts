import type { Connection, ResultSet, ColumnMeta } from 'oracledb';
import type { Binds, Cell, Column, Page, RowCursor as Cursor, RunResult } from '../../driver/types';
export { errorOffset } from './errors';
export type { Binds, Cell, Column, Page, RunResult };

/**
 * Oracle: 문장 하나를 실행하고 결과를 화면에 보여 줄 모양으로 바꾼다 (vscode 모듈에 의존하지 않는다).
 * 조회는 처음 pageSize 행만 가져오고, 나머지는 열어 둔 커서(RowCursor)에서 이어 받는다.
 */

/** 열어 둔 조회 결과: 다음 행들을 이어 받는다. 다 받았거나 필요 없어지면 닫는다 */
export class RowCursor implements Cursor {
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
/** 바인드가 맞지 않는다는 오류 (값을 넘겼는데 받을 자리가 없음 등) */
const BIND_ERRORS = /\b(ORA-01006|ORA-01036|ORA-01008|NJS-097|NJS-098)\b/;

/**
 * 실행계획: EXPLAIN PLAN 으로 계획을 만들고 DBMS_XPLAN 이 그려 준 표를 줄 단위로 받는다.
 * 문장을 실제로 실행하지는 않는다 (데이터는 바뀌지 않는다). 계획은 이 접속의 PLAN_TABLE 에만 남는다
 */
export async function explainPlan(connection: Connection, sql: string, binds: Binds = {}): Promise<{ lines: string[]; ms: number }> {
  const oracledb = require('oracledb') as typeof import('oracledb');
  const started = Date.now();
  const id = `DEVBOOST_${Date.now() % 100000000}_${++planSeq}`;
  const explain = `EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql}`;
  try {
    await connection.execute(explain, toDriverBinds(oracledb, binds), { autoCommit: false });
  } catch (e) {
    // EXPLAIN PLAN 은 바인드 값을 쓰지 않는다(값 없이 계획만 만든다). 값을 넘겨서 난 바인드 오류면 값 없이 다시
    if (!Object.keys(binds).length || !BIND_ERRORS.test(String((e as Error)?.message ?? e))) throw e;
    await connection.execute(explain, [], { autoCommit: false });
  }
  const r = await connection.execute(`SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, '${id}', 'TYPICAL'))`, [], { autoCommit: false });
  return { lines: (r.rows ?? []).map((row) => String(row[0] ?? '')), ms: Date.now() - started };
}

