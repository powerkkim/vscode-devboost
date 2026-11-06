import type { Connection } from 'oracledb';
import type { DbConnectionConfig } from '../../connection/config';
import type { Binds, DbConnection, DriverExtras, RunResult, SchemaReader, ServerInfo } from '../../driver/types';
import { buildConnectString } from './connect';
import { CONNECT_TIMEOUT_SEC, errorCode, explainError } from './errors';
import { runStatement, explainPlan } from './execute';
import { oracleSchemaReader } from './schema';
import { oracleServerOutput } from './output';

export { errorCode, explainError, CONNECT_TIMEOUT_SEC };

/**
 * Oracle 접속 (node-oracledb Thin 모드). vscode 모듈에 의존하지 않는다.
 * 드라이버는 처음 접속할 때 불러온다 (확장을 켤 때는 읽지 않음).
 */

/** 드라이버의 접속을 DB 콘솔의 약속(DbConnection)에 맞춘다 */
export class OracleConnection implements DbConnection {
  readonly meta: SchemaReader;
  readonly extras: DriverExtras;

  constructor(readonly raw: Connection) {
    this.meta = oracleSchemaReader(raw);
    this.extras = { output: oracleServerOutput(raw) };
  }

  execute(sql: string, binds: Binds, pageSize: number): Promise<RunResult> {
    return runStatement(this.raw, sql, pageSize, binds);
  }

  async explain(sql: string, binds: Binds): Promise<string[]> {
    return (await explainPlan(this.raw, sql, binds)).lines;
  }

  commit() {
    return this.raw.commit();
  }

  rollback() {
    return this.raw.rollback();
  }

  cancel() {
    return this.raw.breakExecution();
  }

  isHealthy() {
    return this.raw.isHealthy();
  }

  ping() {
    return this.raw.ping();
  }

  close() {
    return this.raw.close();
  }
}

export async function openOracle(cfg: DbConnectionConfig, password: string): Promise<{ connection: OracleConnection; info: ServerInfo }> {
  // 여기서 require: 처음 접속할 때 드라이버를 읽는다
  const oracledb = require('oracledb') as typeof import('oracledb');
  const started = Date.now();
  const raw = await oracledb.getConnection({
    user: cfg.user.trim(),
    password,
    connectString: buildConnectString(cfg),
    connectTimeout: CONNECT_TIMEOUT_SEC,
    transportConnectTimeout: CONNECT_TIMEOUT_SEC,
  });
  try {
    const r = await raw.execute(`select sys_context('userenv','current_schema'), sys_context('userenv','db_name') from dual`);
    const row = r.rows?.[0] ?? [];
    return {
      connection: new OracleConnection(raw),
      info: {
        product: 'Oracle',
        version: raw.oracleServerVersionString,
        schema: String(row[0] ?? ''),
        dbName: String(row[1] ?? ''),
        ms: Date.now() - started,
      },
    };
  } catch (e) {
    await raw.close().catch(() => undefined);
    throw e;
  }
}

/** 접속해 보고 바로 닫는다 */
export async function testConnection(cfg: DbConnectionConfig, password: string): Promise<ServerInfo> {
  const s = await openOracle(cfg, password);
  await s.connection.close().catch(() => undefined);
  return s.info;
}
