/**
 * node-oracledb 의 타입 (패키지에 타입이 들어 있지 않아, DevBoost 가 쓰는 부분만 적는다).
 * Thin 모드만 쓴다 — Oracle Client 설치가 필요 없고 Oracle Database 12.1 이상에 접속한다.
 */
declare module 'oracledb' {
  export interface ConnectionAttributes {
    user?: string;
    password?: string;
    /** EZConnect("host:port/service") 또는 TNS 설명자("(DESCRIPTION=…)") */
    connectString?: string;
    /** 접속 전체에 허용할 시간 (초) */
    connectTimeout?: number;
    /** TCP 연결에 허용할 시간 (초) */
    transportConnectTimeout?: number;
  }

  export interface Result {
    rows?: unknown[][];
    metaData?: { name: string }[];
    rowsAffected?: number;
  }

  export interface Connection {
    /** 예: "19.3.0.0.0" */
    readonly oracleServerVersionString: string;
    execute(sql: string, binds?: unknown[] | Record<string, unknown>, options?: Record<string, unknown>): Promise<Result>;
    close(): Promise<void>;
    /** 서버에 한 번 다녀온다. 접속이 끊겼으면 오류 */
    ping(): Promise<void>;
    /** 서버에 다녀오지 않고 아는 범위에서 접속이 살아 있는지 */
    isHealthy(): boolean;
  }

  export function getConnection(attrs: ConnectionAttributes): Promise<Connection>;

  /** true = Thin 모드 (initOracleClient 를 부르지 않으면 항상 true) */
  export const thin: boolean;
  export const versionString: string;
}
