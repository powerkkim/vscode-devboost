import type { DbConnectionConfig } from '../../connection/config';
import type { Binds, Cell, Column, DbConnection, DriverExtras, Page, RowCursor, RunResult, SchemaReader, ServerInfo } from '../../driver/types';
import { classify } from '../../sql/statements';
import { toPositional, type BindValue } from '../../sql/binds';
import { loadLib } from '../lib';
import { MYSQL_RULES } from './dialect';
import { mysqlSchemaReader } from './schema';

/**
 * MySQL·MariaDB 접속 (mysql2). vscode 모듈에 의존하지 않는다. 라이브러리는 처음 접속할 때 dist/drivers/mysql.js 에서 읽는다.
 *
 * 커밋: 접속하자마자 autocommit = 0 (콘솔은 자동 커밋하지 않는다). DDL 은 MySQL 이 앞의 변경까지 저절로 커밋한다.
 * 조회 결과: MySQL 은 일반 쿼리에 서버 커서가 없어서 행을 흘려 받으며(stream) 필요한 만큼 받고 멈춘다(pause).
 * 그 사이 접속은 그 쿼리에 묶이므로, 다른 문장을 보내기 전에 남은 쿼리를 KILL QUERY 로 멈춘다
 * (그 결과의 "다음 N행"은 더 쓸 수 없다)
 */

/* mysql2 의 콜백 API 중 쓰는 부분 */
interface MyField {
  name: string;
  columnType: number;
}
interface MyQuery {
  on(ev: 'fields', cb: (f: MyField[]) => void): MyQuery;
  on(ev: 'result', cb: (row: unknown) => void): MyQuery;
  on(ev: 'end', cb: () => void): MyQuery;
  on(ev: 'error', cb: (e: Error) => void): MyQuery;
}
interface MyConn {
  threadId: number | null;
  query(opts: object, values?: unknown[]): MyQuery;
  query(opts: object, values: unknown[] | undefined, cb: (err: Error | null, rows: unknown, fields?: MyField[]) => void): void;
  pause(): void;
  resume(): void;
  ping(cb: (err: Error | null) => void): void;
  end(cb?: (err?: Error) => void): void;
  on(ev: 'error' | 'end', cb: (e?: Error) => void): void;
}
interface MyLib {
  mysql: {
    createConnection(cfg: object): MyConn;
    Types: Record<string, number>;
  };
}

/** 칸 값이 이보다 길면 자른다 */
export const MAX_CELL_CHARS = 4000;
/** 숫자 형 이름 (mysql2 Types) */
const NUMERIC_TYPES = new Set(['DECIMAL', 'TINY', 'SHORT', 'LONG', 'FLOAT', 'DOUBLE', 'LONGLONG', 'INT24', 'NEWDECIMAL', 'YEAR']);

function toMyValue(v: BindValue): unknown {
  if (!(v instanceof Date)) return v;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
}

/**
 * 화면 칸으로: 숫자·날짜는 접속 설정(bigNumberStrings·dateStrings)으로 이미 글로 오고,
 * 바이너리(BLOB·BINARY)는 Buffer → 16진수, JSON 칸은 객체 → 글
 */
function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  let s: string;
  if (Buffer.isBuffer(v)) s = `0x${v.subarray(0, 2000).toString('hex').toUpperCase()}${v.length > 2000 ? '…' : ''}`;
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + '…' : s;
}

export class MyConnection implements DbConnection {
  readonly meta: SchemaReader;
  readonly extras: DriverExtras = {};
  private healthy = true;
  /** 흘려 받는 중인 조회 */
  private stream: { stop(): Promise<void>; done: boolean } | undefined;
  private readonly typeNames: Record<number, string>;

  constructor(
    readonly raw: MyConn,
    private readonly lib: MyLib,
    private readonly config: object
  ) {
    raw.on('error', () => (this.healthy = false));
    raw.on('end', () => (this.healthy = false));
    this.typeNames = Object.fromEntries(Object.entries(lib.mysql.Types).map(([k, v]) => [v, k]));
    this.meta = mysqlSchemaReader((sql, values) => this.query(sql, values));
  }

  private columns(fields: MyField[]): Column[] {
    return fields.map((f) => {
      const t = this.typeNames[f.columnType] ?? `type ${f.columnType}`;
      return { name: f.name, type: t.toLowerCase(), numeric: NUMERIC_TYPES.has(t) };
    });
  }

  private static cells(rows: unknown[][]): Cell[][] {
    return rows.map((r) => r.map(cellOf));
  }

  /** 흘려 받는 중인 조회를 멈춘다 (다른 문장을 보내기 전에) */
  private async stopStream() {
    const s = this.stream;
    this.stream = undefined;
    if (s && !s.done) await s.stop();
  }

  private run(sql: string, values: unknown[] = []): Promise<{ rows: unknown; fields?: MyField[] }> {
    return new Promise((resolve, reject) =>
      this.raw.query({ sql, rowsAsArray: true }, values, (err, rows, fields) => (err ? reject(err) : resolve({ rows, fields })))
    );
  }

  /** 딕셔너리 조회 등 (행은 배열로). ? 에 배열을 넣으면 IN 목록으로 펼친다 */
  async query(sql: string, values: unknown[] = []): Promise<unknown[][]> {
    await this.stopStream();
    const r = await this.run(sql, values);
    return Array.isArray(r.rows) ? (r.rows as unknown[][]) : [];
  }

  async execute(sql: string, binds: Binds, pageSize: number): Promise<RunResult> {
    await this.stopStream();
    const info = classify(sql, MYSQL_RULES);
    const { sql: text, values } = toPositional(sql, binds, MYSQL_RULES, 'question');
    const params = values.map(toMyValue);
    const started = Date.now();
    if (info.kind === 'query') return this.openStream(text, params, pageSize, started);
    const r = await this.run(text, params);
    if (Array.isArray(r.rows) && r.fields?.length) {
      // SHOW … 처럼 조회가 아닌 낱말로 시작하는데 행이 오는 문장
      return { kind: 'rows', columns: this.columns(r.fields), page: { rows: MyConnection.cells(r.rows as unknown[][]), done: true }, ms: Date.now() - started };
    }
    const ok = r.rows as { affectedRows?: number } | undefined;
    if (ok && typeof ok.affectedRows === 'number' && (info.kind === 'dml' || /^(REPLACE|LOAD)$/.test(info.verb))) {
      return { kind: 'count', rowsAffected: ok.affectedRows, ms: Date.now() - started };
    }
    return { kind: 'ok', ms: Date.now() - started };
  }

  /** 조회를 흘려 받는다: 버퍼가 차면 멈추고(pause), 더 달라고 하면 이어 받는다(resume) */
  private openStream(text: string, values: unknown[], pageSize: number, started: number): Promise<RunResult> {
    let fields: MyField[] = [];
    const buffer: unknown[][] = [];
    let want = pageSize;
    let error: Error | undefined;
    let paused = false;
    /** 멈추는 중: 남은 행은 버리고 다시 멈추지 않는다 */
    let stopping = false;
    const state = { done: false, stop: async () => undefined as void };
    let wake: (() => void) | undefined;
    const notify = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const q = this.raw.query({ sql: text, rowsAsArray: true }, values);
    q.on('fields', (f) => (fields = f ?? []));
    q.on('result', (row) => {
      if (stopping) return;
      buffer.push(row as unknown[]);
      if (buffer.length >= want && !paused) {
        paused = true;
        this.raw.pause();
      }
      if (buffer.length >= want) notify();
    });
    q.on('error', (e) => {
      error = e;
      state.done = true;
      notify();
    });
    q.on('end', () => {
      state.done = true;
      notify();
    });
    const ended = new Promise<void>((res) => {
      q.on('end', res);
      q.on('error', () => res());
    });
    // 남은 쿼리를 멈춘다: 다른 접속으로 KILL QUERY 를 보내고, 받던 것을 흘려 보낸다
    state.stop = async () => {
      if (state.done) return;
      stopping = true;
      buffer.length = 0;
      await this.killQuery().catch(() => undefined);
      paused = false;
      this.raw.resume();
      await ended;
    };
    this.stream = state;

    const take = async (n: number): Promise<Page> => {
      want = n;
      while (!state.done && buffer.length < n) {
        if (paused) {
          // resume() 은 멈춘 동안 쌓인 행을 그 자리에서 다시 흘려보낸다 → 기다리기 전에 다시 확인
          paused = false;
          this.raw.resume();
          continue;
        }
        await new Promise<void>((res) => (wake = res));
      }
      if (error) {
        if (this.stream === state) this.stream = undefined;
        throw error;
      }
      const rows = buffer.splice(0, n);
      const done = state.done && buffer.length === 0;
      if (done && this.stream === state) this.stream = undefined;
      return { rows: MyConnection.cells(rows), done };
    };
    const self = this;
    const cursor: RowCursor = {
      next: (n) => {
        if (self.stream !== state && !(state.done && buffer.length)) return Promise.reject(new Error('다른 문장을 실행해 이 결과의 쿼리가 멈췄습니다. 다시 실행하세요.'));
        return take(n);
      },
      close: async () => {
        if (self.stream === state) await self.stopStream();
      },
    };
    return take(pageSize).then((page) => ({
      kind: 'rows',
      columns: this.columns(fields),
      page,
      cursor: page.done ? undefined : cursor,
      ms: Date.now() - started,
    }));
  }

  /** 이 접속에서 실행 중인 쿼리를 멈춘다 (다른 접속으로) */
  private async killQuery() {
    const id = this.raw.threadId;
    if (!id) return;
    const side = this.lib.mysql.createConnection({ ...this.config, connectTimeout: 5000 });
    try {
      await new Promise<void>((res, rej) => side.query({ sql: `KILL QUERY ${Number(id)}` }, [], (err) => (err ? rej(err) : res())));
    } finally {
      side.end(() => undefined);
    }
  }

  async explain(sql: string, binds: Binds): Promise<string[]> {
    const { sql: text, values } = toPositional(sql, binds, MYSQL_RULES, 'question');
    const params = values.map(toMyValue);
    // MySQL 8 은 나무 모양(FORMAT=TREE), 안 되면(MariaDB·5.7) 표를 글로
    try {
      const rows = await this.query(`EXPLAIN FORMAT=TREE ${text}`, params);
      return String(rows[0]?.[0] ?? '').split('\n');
    } catch {
      await this.stopStream();
      const r = await this.run(`EXPLAIN ${text}`, params);
      const fields = (r.fields ?? []).map((f) => f.name);
      const rows = ((r.rows as unknown[][]) ?? []).map((row) => row.map((v) => (v === null ? 'NULL' : String(v))));
      const widths = fields.map((f, i) => Math.max(f.length, ...rows.map((row) => row[i].length)));
      const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
      const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
      return [sep, line(fields), sep, ...rows.map(line), sep];
    }
  }

  async commit() {
    await this.query('COMMIT');
  }

  async rollback() {
    await this.query('ROLLBACK');
  }

  async cancel() {
    await this.killQuery();
  }

  isHealthy() {
    return this.healthy;
  }

  async ping() {
    // 흘려 받는 중이면 서버에 다녀오지 않는다 (그 쿼리를 멈추게 된다)
    if (this.stream && !this.stream.done) return;
    await new Promise<void>((res, rej) => this.raw.ping((err) => (err ? rej(err) : res())));
  }

  async close() {
    await this.stopStream().catch(() => undefined);
    this.healthy = false;
    await new Promise<void>((res) => this.raw.end(() => res()));
  }
}

export function connectionConfig(cfg: DbConnectionConfig, password: string): object {
  const base = cfg.targetKind === 'raw' ? { uri: cfg.target.trim().replace(/^mariadb:/i, 'mysql:') } : { host: cfg.host.trim(), port: cfg.port, database: cfg.target.trim() };
  return {
    ...base,
    user: cfg.user.trim() || undefined,
    password,
    connectTimeout: 10_000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    multipleStatements: false,
  };
}

export async function openMysql(cfg: DbConnectionConfig, password: string): Promise<{ connection: MyConnection; info: ServerInfo }> {
  const lib = loadLib<MyLib>('mysql');
  const config = connectionConfig(cfg, password);
  const started = Date.now();
  const raw = lib.mysql.createConnection(config);
  const conn = new MyConnection(raw, lib, config);
  try {
    // 자동 커밋 끄기 (콘솔의 커밋·롤백으로 확정)
    await conn.query('SET autocommit = 0');
    const row = (await conn.query('SELECT DATABASE(), VERSION()'))[0] ?? [];
    const version = String(row[1] ?? '');
    return {
      connection: conn,
      info: { product: /mariadb/i.test(version) ? 'MariaDB' : 'MySQL', version, schema: String(row[0] ?? ''), dbName: String(row[0] ?? ''), ms: Date.now() - started },
    };
  } catch (e) {
    raw.end(() => undefined);
    throw e;
  }
}
