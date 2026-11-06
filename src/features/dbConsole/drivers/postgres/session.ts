import type { Client, ClientConfig, FieldDef } from 'pg';
import type { DbConnectionConfig } from '../../connection/config';
import type { Binds, Cell, Column, DbConnection, DriverExtras, Page, RowCursor, RunResult, SchemaReader, ServerInfo, ServerOutput } from '../../driver/types';
import { classify } from '../../sql/statements';
import { toPositional, type BindValue } from '../../sql/binds';
import { loadLib } from '../lib';
import { POSTGRES_RULES } from './dialect';
import { postgresSchemaReader } from './schema';

/**
 * PostgreSQL 접속 (pg). vscode 모듈에 의존하지 않는다. 라이브러리는 처음 접속할 때 dist/drivers/pg.js 에서 읽는다.
 *
 * 커밋: 콘솔은 자동 커밋하지 않는다. PostgreSQL 은 기본이 자동 커밋이므로
 *  - 조회(SELECT·WITH)는 트랜잭션이 없으면 그냥 실행하고 (읽기만 하는데 트랜잭션을 열어 두지 않게)
 *  - 그 밖의 문장 앞에서 BEGIN 을 연다 → 커밋·롤백 때까지 이어진다
 *  - 트랜잭션 안의 문장은 SAVEPOINT 로 감싼다: PostgreSQL 은 문장 하나가 실패하면 트랜잭션 전체가 막히는데,
 *    그 문장만 되돌려 앞의 변경을 지킨다 (Oracle 처럼)
 * 조회 결과는 커서(pg-cursor)로 페이지씩 받는다. 접속 하나로는 한 번에 한 가지만 하므로, 다른 문장을 실행하면
 * 열어 둔 커서는 닫힌다 (그 결과의 "다음 N행"은 더 쓸 수 없다)
 */

interface PgLib {
  pg: typeof import('pg');
  Cursor: new (text: string, values: unknown[], config: { rowMode: 'array' }) => PgCursor;
}
interface PgCursor {
  read(n: number, cb: (err: Error | undefined, rows: unknown[][], result: { fields: FieldDef[] }) => void): void;
  close(cb: (err?: Error) => void): void;
}

/** 숫자 형 (오른쪽 정렬) */
const NUMERIC = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);
/** 자주 보는 형의 이름 (칸 머리글) */
const TYPE_NAMES: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml',
  700: 'float4', 701: 'float8', 790: 'money', 1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp',
  1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
  1000: 'bool[]', 1005: 'int2[]', 1007: 'int4[]', 1009: 'text[]', 1015: 'varchar[]', 1016: 'int8[]',
};
const BOOL = 16;
/** 칸 값이 이보다 길면 자른다 (Oracle 드라이버와 같게) */
export const MAX_CELL_CHARS = 4000;

const SAVEPOINT = 'devboost_stmt';

export function toColumns(fields: FieldDef[]): Column[] {
  return fields.map((f) => ({ name: f.name, type: TYPE_NAMES[f.dataTypeID] ?? `oid ${f.dataTypeID}`, numeric: NUMERIC.has(f.dataTypeID) }));
}

/** 서버가 보낸 글 그대로 (형 변환 없이 받는다) → 화면 칸. bool 은 true/false 로 */
export function toCells(fields: FieldDef[], rows: unknown[][]): Cell[][] {
  return rows.map((r) =>
    r.map((v, i) => {
      if (v === null || v === undefined) return null;
      let s = String(v);
      if (fields[i]?.dataTypeID === BOOL) s = s === 't' ? 'true' : s === 'f' ? 'false' : s;
      return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + '…' : s;
    })
  );
}

/** pg 에 넘길 값: 날짜는 서버가 받는 글로 (시간대 바꿈 없이) */
function toPgValue(v: BindValue): unknown {
  if (!(v instanceof Date)) return v;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
}

export class PgConnection implements DbConnection {
  readonly meta: SchemaReader;
  readonly extras: DriverExtras;
  private inTx = false;
  private healthy = true;
  private cursor: { cur: PgCursor; done: boolean } | undefined;
  private outputOn = false;
  private notices: string[] = [];

  constructor(
    readonly raw: Client,
    private readonly lib: PgLib,
    private readonly config: ClientConfig
  ) {
    raw.on('error', () => (this.healthy = false));
    raw.on('end', () => (this.healthy = false));
    // RAISE NOTICE … 를 서버 출력으로
    raw.on('notice', (n) => {
      if (this.outputOn) this.notices.push(n.message ?? String(n));
    });
    this.meta = postgresSchemaReader((sql, values) => this.query(sql, values));
    const self = this;
    const output: ServerOutput = {
      get enabled() {
        return self.outputOn;
      },
      async setEnabled(on: boolean) {
        self.outputOn = on;
        self.notices = [];
      },
      async read() {
        const out = self.notices;
        self.notices = [];
        return out;
      },
    };
    this.extras = { output };
  }

  /** 열어 둔 커서를 닫는다 (다른 문장을 보내기 전에) */
  private async closeCursor() {
    const c = this.cursor;
    this.cursor = undefined;
    if (c && !c.done) await new Promise<void>((res) => c.cur.close(() => res()));
  }

  /** 딕셔너리 조회 등 (행은 배열로) */
  async query(sql: string, values: unknown[] = []): Promise<unknown[][]> {
    await this.closeCursor();
    const r = await this.raw.query({ text: sql, values, rowMode: 'array' });
    return r.rows as unknown[][];
  }

  private async ensureTx() {
    if (this.inTx) return;
    await this.raw.query('BEGIN');
    this.inTx = true;
  }

  async execute(sql: string, binds: Binds, pageSize: number): Promise<RunResult> {
    await this.closeCursor();
    const info = classify(sql, POSTGRES_RULES);
    const { sql: text, values } = toPositional(sql, binds, POSTGRES_RULES, 'dollar');
    const params = values.map(toPgValue);
    const started = Date.now();

    // 직접 친 BEGIN·COMMIT·ROLLBACK 은 그대로 보내고 상태만 맞춘다
    if (info.kind === 'tx') {
      await this.raw.query(text);
      const v = info.verb;
      if (v === 'BEGIN' || v === 'START') this.inTx = true;
      else if ((v === 'COMMIT' || v === 'END' || v === 'ROLLBACK' || v === 'ABORT') && !/\bto\b/i.test(sql)) this.inTx = false;
      return { kind: 'ok', ms: Date.now() - started };
    }

    const isQuery = info.kind === 'query' && !info.forUpdate;
    if (!isQuery) await this.ensureTx();
    const guarded = this.inTx;
    if (guarded) await this.raw.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      let result: RunResult;
      if (isQuery) {
        result = await this.openCursor(text, params, pageSize, started);
      } else {
        const r = await this.raw.query({ text, values: params, rowMode: 'array' });
        if (r.fields?.length) {
          // INSERT … RETURNING 등: 행이 온다 (다 받았다)
          result = { kind: 'rows', columns: toColumns(r.fields), page: { rows: toCells(r.fields, r.rows as unknown[][]), done: true }, ms: Date.now() - started };
        } else if (r.rowCount !== null && /^(INSERT|UPDATE|DELETE|MERGE|COPY)$/.test(r.command)) {
          result = { kind: 'count', rowsAffected: r.rowCount, ms: Date.now() - started };
        } else {
          result = { kind: 'ok', ms: Date.now() - started };
        }
      }
      if (guarded && !this.cursor) await this.raw.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return result;
    } catch (e) {
      // 이 문장만 되돌린다 (트랜잭션이 막히지 않게, 앞의 변경은 남는다)
      if (guarded && this.healthy) await this.raw.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`).catch(() => undefined);
      throw e;
    }
  }

  private openCursor(text: string, values: unknown[], pageSize: number, started: number): Promise<RunResult> {
    const cur = new this.lib.Cursor(text, values, { rowMode: 'array' });
    this.raw.query(cur as never);
    const state = { cur, done: false };
    this.cursor = state;
    let fields: FieldDef[] = [];
    const read = (n: number) =>
      new Promise<Page>((resolve, reject) => {
        if (state.done) return resolve({ rows: [], done: true });
        cur.read(n, (err, rows, result) => {
          if (err) {
            state.done = true;
            if (this.cursor === state) this.cursor = undefined;
            return reject(err);
          }
          fields = result?.fields ?? fields;
          const done = rows.length < n;
          if (done) {
            state.done = true;
            if (this.cursor === state) this.cursor = undefined;
            cur.close(() => undefined);
          }
          resolve({ rows: toCells(fields, rows), done });
        });
      });
    const self = this;
    const cursor: RowCursor = {
      next: (n) => {
        if (self.cursor !== state && !state.done) return Promise.reject(new Error('다른 문장을 실행해 이 결과의 커서가 닫혔습니다. 다시 실행하세요.'));
        return read(n);
      },
      close: async () => {
        if (self.cursor === state) await self.closeCursor();
      },
    };
    return read(pageSize).then((page) => ({
      kind: 'rows',
      columns: toColumns(fields),
      page,
      cursor: page.done ? undefined : cursor,
      ms: Date.now() - started,
    }));
  }

  async explain(sql: string, binds: Binds): Promise<string[]> {
    const { sql: text, values } = toPositional(sql, binds, POSTGRES_RULES, 'dollar');
    const rows = await this.query(`EXPLAIN ${text}`, values.map(toPgValue));
    return rows.map((r) => String(r[0]));
  }

  async commit() {
    await this.closeCursor();
    if (this.inTx) await this.raw.query('COMMIT');
    this.inTx = false;
  }

  async rollback() {
    await this.closeCursor();
    if (this.inTx) await this.raw.query('ROLLBACK');
    this.inTx = false;
  }

  /** 실행 중인 문장 취소: 다른 접속으로 pg_cancel_backend */
  async cancel() {
    const pid = (this.raw as unknown as { processID?: number }).processID;
    if (!pid) return;
    const side = new this.lib.pg.Client({ ...this.config, application_name: 'DevBoost cancel' });
    try {
      await side.connect();
      await side.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      await side.end().catch(() => undefined);
    }
  }

  isHealthy() {
    return this.healthy;
  }

  async ping() {
    // 커서를 열어 둔 동안은 서버에 다녀오지 않는다 (다녀오면 커서가 닫힌다)
    if (this.cursor) return;
    await this.raw.query('SELECT 1');
  }

  async close() {
    this.healthy = false;
    await this.raw.end();
  }
}

export function clientConfig(cfg: DbConnectionConfig, password: string): ClientConfig {
  const base: ClientConfig = cfg.targetKind === 'raw' ? { connectionString: cfg.target.trim() } : { host: cfg.host.trim(), port: cfg.port, database: cfg.target.trim() };
  return {
    ...base,
    user: cfg.user.trim() || undefined,
    password,
    connectionTimeoutMillis: 10_000,
    application_name: 'DevBoost',
    // 값은 서버가 보낸 글 그대로 (숫자 정밀도·날짜 시간대가 바뀌지 않게)
    types: { getTypeParser: () => (v: string) => v } as unknown as ClientConfig['types'],
  };
}

export async function openPostgres(cfg: DbConnectionConfig, password: string): Promise<{ connection: PgConnection; info: ServerInfo }> {
  const lib = loadLib<PgLib>('pg');
  const config = clientConfig(cfg, password);
  const started = Date.now();
  const raw = new lib.pg.Client(config);
  await raw.connect();
  try {
    const r = await raw.query({ text: `SELECT current_schema(), current_database(), current_setting('server_version')`, rowMode: 'array' });
    const row = (r.rows[0] ?? []) as unknown[];
    return {
      connection: new PgConnection(raw, lib, config),
      info: { product: 'PostgreSQL', version: String(row[2] ?? ''), schema: String(row[0] ?? 'public'), dbName: String(row[1] ?? ''), ms: Date.now() - started },
    };
  } catch (e) {
    await raw.end().catch(() => undefined);
    throw e;
  }
}
