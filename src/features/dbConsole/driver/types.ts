import type { DbConnectionConfig, TargetKind } from '../connection/config';
import type { DialectRules } from '../sql/statements';
import type { BindType, BindValue } from '../sql/binds';

/**
 * DB 콘솔이 DB 종류와 관계없이 쓰는 약속 (vscode 모듈에 의존하지 않는다).
 *
 * 공통 코드(콘솔·결과·연결 목록·안전장치)는 이 약속만 보고, DB마다 다른 일(접속·실행·딕셔너리 조회·오류 해석·
 * 문장 나누기 규칙)은 drivers/<db>/ 안에서만 한다. 한 DB에만 있는 기능(Oracle 의 DBMS_OUTPUT 등)은
 * DbConnection.extras 로 내놓고, 화면은 그 기능이 있을 때만 보여 준다 — 다른 DB 접속에 섞이지 않게.
 */

export type DbKind = 'oracle';

/** 화면에 보여 줄 칸 값. null 은 DB 의 NULL */
export type Cell = string | null;

export interface Column {
  name: string;
  /** VARCHAR2, NUMBER, DATE … (DB가 알려 준 이름 그대로) */
  type: string;
  /** 숫자 칸 (오른쪽 정렬) */
  numeric: boolean;
}

export interface Page {
  rows: Cell[][];
  /** 더 가져올 행이 없음 */
  done: boolean;
}

/** 열어 둔 조회 결과: 다음 행들을 이어 받는다. 다 받았거나 필요 없어지면 닫는다 */
export interface RowCursor {
  next(count: number): Promise<Page>;
  close(): Promise<void>;
}

export type RunResult =
  | { kind: 'rows'; columns: Column[]; page: Page; cursor?: RowCursor; ms: number }
  | { kind: 'count'; rowsAffected: number; ms: number }
  | { kind: 'ok'; ms: number };

/** 문장에 넘길 파라미터 값 (이름 → 값과 타입) */
export type Binds = Record<string, { value: BindValue; type: BindType }>;

export interface ServerInfo {
  /** 제품 이름 (목록·상태 표시에 쓴다): Oracle */
  product: string;
  /** 예: "19.3.0.0.0" */
  version: string;
  /** 지금 스키마 */
  schema: string;
  /** DB 이름 */
  dbName: string;
  /** 접속에 걸린 시간 */
  ms: number;
}

// ───────── 딕셔너리 ─────────

/** 다른 이름으로 테이블·뷰를 가리키는 것 (Oracle 시노님 등) */
export interface SynonymInfo {
  name: string;
  /** 가리키는 대상의 스키마 */
  targetOwner: string;
  targetName: string;
}

export interface SchemaObjects {
  tables: string[];
  views: string[];
  synonyms: SynonymInfo[];
}

export interface TableColumn {
  name: string;
  /** VARCHAR2(10), NUMBER(10,2), DATE … */
  type: string;
  nullable: boolean;
}

/** 참조 관계 하나 (fromTable 의 fromColumns → toTable 의 toColumns). 칸 순서가 맞춰져 있다 */
export interface Relation {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

/** 스키마(소유자)를 받는 딕셔너리 조회. 이름은 DB에 저장된 그대로(Oracle 은 대개 대문자) */
export interface SchemaReader {
  /** 볼 수 있는 스키마들 (트리에서 스키마를 바꿀 때) */
  schemas(): Promise<string[]>;
  objects(owner: string): Promise<SchemaObjects>;
  columns(owner: string, table: string): Promise<TableColumn[]>;
  /** 기본 키 칸 (테이블 → 칸들, 정의 순서) */
  primaryKeys(owner: string, tables: string[]): Promise<Record<string, string[]>>;
  /** 주어진 테이블들 사이의 참조 관계 */
  relations(owner: string, tables: string[]): Promise<Relation[]>;
}

// ───────── 한 DB에만 있는 기능 ─────────

/** 서버 출력 (Oracle DBMS_OUTPUT) */
export interface ServerOutput {
  /** 켜기·끄기 (이 접속에만) */
  setEnabled(on: boolean): Promise<void>;
  readonly enabled: boolean;
  /** 쌓인 줄을 꺼낸다 (꺼낸 줄은 서버에서 지워진다) */
  read(): Promise<string[]>;
}

export interface DriverExtras {
  output?: ServerOutput;
}

// ───────── 접속 ─────────

/** 드라이버가 연 접속 하나. 한 번에 한 가지만 한다 (줄 세우기는 DbSession 이 맡는다) */
export interface DbConnection {
  execute(sql: string, binds: Binds, pageSize: number): Promise<RunResult>;
  /** 실행계획 표 (문장을 실제로 실행하지는 않는다) */
  explain(sql: string, binds: Binds): Promise<string[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** 실행 중인 문장을 멈춘다 (줄을 서지 않고 바로) */
  cancel(): Promise<void>;
  /** 서버에 다녀오지 않고 아는 범위에서 살아 있는지 */
  isHealthy(): boolean;
  /** 서버에 한 번 다녀온다. 끊겼으면 오류 */
  ping(): Promise<void>;
  close(): Promise<void>;
  readonly meta: SchemaReader;
  readonly extras: DriverExtras;
}

/** 오류 해석 */
export interface ErrorInfo {
  /** 오류 코드 (ORA-01017, NJS-503 …) */
  code(e: unknown): string | undefined;
  /** 화면에 보여 줄 한 줄 */
  explain(e: unknown): string;
  /** 접속이 끊겨서 난 오류인가 */
  isConnectionLost(e: unknown): boolean;
  /** 계정·비밀번호 문제라 기억한 비밀번호를 버려야 하는가 */
  isAuthFailure(e: unknown): boolean;
  /** 사용자가 취소해서 난 오류인가 */
  isCancel(e: unknown): boolean;
  /** 문장 안에서 오류가 난 자리 (알 때만) */
  offset(e: unknown): number | undefined;
}

/** 연결 입력 화면에서 DB마다 다른 것 */
export interface ConnectInfo {
  defaultPort: number;
  /** 접속 방식 칸의 선택지 (값 → 화면 이름) */
  targetKinds: { value: TargetKind; label: string }[];
  /** JDBC URL 예시 (입력 칸 안내) */
  jdbcExample: string;
  /** 목록에 보여 줄 주소 부분: host:port/service */
  describeTarget(c: Pick<DbConnectionConfig, 'host' | 'port' | 'targetKind' | 'target'>): string;
  /** 접속에 실제로 넘기는 문자열 (입력 화면 미리보기) */
  connectString(c: Pick<DbConnectionConfig, 'host' | 'port' | 'targetKind' | 'target'>): string;
  checkTarget(kind: TargetKind, v: string): string | undefined;
  /** 호스트 칸에 한꺼번에 붙여 넣은 것(JDBC URL, host:port/service …)을 나눈다 */
  parseHostInput(text: string): HostInput | undefined;
}

/** 호스트 칸에 넣은 글에서 읽어 낸 것. 호스트만 썼으면 host 만 있다 */
export interface HostInput {
  host: string;
  port?: number;
  targetKind?: TargetKind;
  target?: string;
  user?: string;
}

export interface DbDriver {
  kind: DbKind;
  /** 화면 이름: Oracle */
  label: string;
  open(cfg: DbConnectionConfig, password: string): Promise<{ connection: DbConnection; info: ServerInfo }>;
  rules: DialectRules;
  errors: ErrorInfo;
  connect: ConnectInfo;
}
