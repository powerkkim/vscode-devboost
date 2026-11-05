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

  /** 칸의 타입 (DB_TYPE_NUMBER 등과 === 로 비교한다) */
  export interface DbType {
    /** VARCHAR2, NUMBER, DATE … */
    readonly columnTypeName: string;
  }

  /** 조회 결과의 칸 정보 */
  export interface ColumnMeta {
    name: string;
    dbType?: DbType;
    dbTypeName?: string;
  }

  export interface ExecuteOptions {
    /** true: 행을 한꺼번에 받지 않고 ResultSet 으로 받는다 */
    resultSet?: boolean;
    autoCommit?: boolean;
    /** 칸마다 불려, 어떤 JS 타입으로 받을지 정한다 (undefined 면 기본) */
    fetchTypeHandler?: (meta: ColumnMeta) => { type?: DbType } | undefined;
  }

  export interface ResultSet {
    readonly metaData?: ColumnMeta[];
    /** 다음 count 행. 남은 것이 적으면 그만큼만 */
    getRows(count: number): Promise<unknown[][]>;
    close(): Promise<void>;
  }

  export interface Result {
    rows?: unknown[][];
    metaData?: ColumnMeta[];
    resultSet?: ResultSet;
    /** INSERT·UPDATE·DELETE·MERGE 가 바꾼 행 수 */
    rowsAffected?: number;
  }

  export interface Connection {
    /** 예: "19.3.0.0.0" */
    readonly oracleServerVersionString: string;
    execute(sql: string, binds?: unknown[] | Record<string, unknown>, options?: ExecuteOptions): Promise<Result>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    /** 실행 중인 문장을 멈춘다 (다른 호출이 도는 중에도 부를 수 있다) */
    breakExecution(): Promise<void>;
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

  export const DB_TYPE_NUMBER: DbType;
  export const DB_TYPE_VARCHAR: DbType;
  export const DB_TYPE_DATE: DbType;
  export const DB_TYPE_CLOB: DbType;
  export const DB_TYPE_NCLOB: DbType;
  export const DB_TYPE_BLOB: DbType;
  /** fetchTypeHandler 에서: 글자로 받는다 */
  export const STRING: DbType;
  /** fetchTypeHandler 에서: 바이트(Buffer)로 받는다 */
  export const BUFFER: DbType;
}
