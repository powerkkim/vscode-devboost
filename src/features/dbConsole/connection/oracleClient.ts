import type { Connection } from 'oracledb';
import { DbConnectionConfig, buildConnectString } from './connectString';

/**
 * Oracle 접속 (node-oracledb Thin 모드). vscode 모듈에 의존하지 않는다.
 * 드라이버는 처음 접속할 때 불러온다 (확장을 켤 때는 읽지 않음).
 */

/** 접속에 허용할 시간 (초) */
export const CONNECT_TIMEOUT_SEC = 10;

export interface ServerInfo {
  /** 예: "19.3.0.0.0" */
  version: string;
  /** 현재 스키마 */
  schema: string;
  /** DB 이름 */
  dbName: string;
  /** 접속에 걸린 시간 */
  ms: number;
}

/** 열려 있는 접속 하나 */
export class OracleSession {
  constructor(
    /** 드라이버의 접속 객체 (쿼리 실행에 쓴다) */
    readonly connection: Connection,
    readonly info: ServerInfo
  ) {}

  private running = 0;

  /** 접속으로 무언가 실행하는 중인지 (실행 중에는 끊김 확인을 건너뛴다) */
  get busy(): boolean {
    return this.running > 0;
  }

  /**
   * 접속을 쓰는 작업은 이것으로 감싼다.
   * 접속 하나는 한 번에 한 가지만 하므로, 실행 중에 끊김 확인이 끼어들면 긴 쿼리 뒤에 줄을 서서 "답 없음"으로 잘못 보인다
   */
  async use<T>(run: (connection: Connection) => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await run(this.connection);
    } finally {
      this.running--;
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

export async function openSession(cfg: DbConnectionConfig, password: string): Promise<OracleSession> {
  // 여기서 require: 처음 접속할 때 드라이버를 읽는다
  const oracledb = require('oracledb') as typeof import('oracledb');
  const started = Date.now();
  const connection = await oracledb.getConnection({
    user: cfg.user.trim(),
    password,
    connectString: buildConnectString(cfg),
    connectTimeout: CONNECT_TIMEOUT_SEC,
    transportConnectTimeout: CONNECT_TIMEOUT_SEC,
  });
  try {
    const r = await connection.execute(
      `select sys_context('userenv','current_schema'), sys_context('userenv','db_name') from dual`
    );
    const row = r.rows?.[0] ?? [];
    return new OracleSession(connection, {
      version: connection.oracleServerVersionString,
      schema: String(row[0] ?? ''),
      dbName: String(row[1] ?? ''),
      ms: Date.now() - started,
    });
  } catch (e) {
    await connection.close().catch(() => undefined);
    throw e;
  }
}

/** 접속해 보고 바로 닫는다 */
export async function testConnection(cfg: DbConnectionConfig, password: string): Promise<ServerInfo> {
  const s = await openSession(cfg, password);
  await s.close().catch(() => undefined);
  return s.info;
}

/** 오류 코드별 안내 (자주 만나는 접속 실패). 드라이버가 준 영어 메시지 앞에 붙인다 */
const HINTS: Record<string, string> = {
  'ORA-01017': '사용자 이름 또는 비밀번호가 틀립니다',
  'ORA-28000': '계정이 잠겨 있습니다 (DBA 에게 잠금 해제 요청)',
  'ORA-28001': '비밀번호가 만료됐습니다 (비밀번호를 바꾼 뒤 다시 접속)',
  'ORA-01045': '이 계정에 접속 권한(CREATE SESSION)이 없습니다',
  'ORA-12514': '리스너가 이 서비스 이름을 모릅니다 (서비스 이름인지 SID 인지 확인)',
  'ORA-12505': '리스너가 이 SID 를 모릅니다 (SID 인지 서비스 이름인지 확인)',
  'NJS-518': '리스너가 이 서비스 이름을 모릅니다 (서비스 이름인지 SID 인지 확인)',
  'NJS-519': '리스너가 이 SID 를 모릅니다 (SID 인지 서비스 이름인지 확인)',
  'NJS-503': '서버에 연결하지 못했습니다 (호스트·포트, 방화벽·VPN 확인)',
  'NJS-511': '서버가 연결을 거부했습니다 (포트가 맞는지, 리스너가 떠 있는지 확인)',
  'NJS-510': `${CONNECT_TIMEOUT_SEC}초 안에 응답이 없습니다 (호스트·포트, 방화벽·VPN 확인)`,
  'NJS-500': '접속이 끊겼습니다',
  'NJS-501': '접속이 끊겼습니다',
  'NJS-521': '접속이 끊겼습니다',
  'NJS-514': '연결 문자열의 형식이 틀립니다',
  'NJS-515': '연결 문자열의 형식이 틀립니다',
  'NJS-138': 'Oracle 12.1 보다 낮은 서버라 접속할 수 없습니다 (Thin 모드는 12.1 이상만 지원)',
  'NJS-116': '이 계정의 비밀번호가 옛 방식(10G)으로만 저장돼 있어 접속할 수 없습니다 (DBA 에게 비밀번호 재설정 요청)',
};

/** 오류에서 코드(ORA-01017, NJS-503 …)를 꺼낸다 */
export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z]{3}-\d+$/.test(code)) return code;
  return /\b([A-Z]{3}-\d{3,5})\b/.exec(errorText(e))?.[1];
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | undefined)?.message;
  return typeof msg === 'string' ? msg : String(e);
}

/** 화면에 보여 줄 오류 한 줄: "안내 — 원래 메시지 첫 줄" */
export function explainError(e: unknown): string {
  const first = errorText(e).split('\n')[0].trim();
  const code = errorCode(e);
  const hint = code ? HINTS[code] : undefined;
  return hint ? `${hint} — ${first}` : first;
}
