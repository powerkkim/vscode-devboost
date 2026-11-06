import type { ErrorInfo } from '../../driver/types';

/**
 * MySQL·MariaDB 오류 해석 (vscode·mysql2 모듈에 의존하지 않는다).
 * mysql2 는 서버 오류의 이름(ER_NO_SUCH_TABLE 등)을 code 로, 번호를 errno 로 준다
 */
const HINTS: Record<string, string> = {
  ER_ACCESS_DENIED_ERROR: '사용자 이름 또는 비밀번호가 틀립니다',
  ER_DBACCESS_DENIED_ERROR: '이 데이터베이스에 접근할 권한이 없습니다',
  ER_BAD_DB_ERROR: '그런 데이터베이스가 없습니다',
  ER_NO_SUCH_TABLE: '테이블 또는 뷰가 없습니다',
  ER_BAD_FIELD_ERROR: '없는 칸 이름입니다',
  ER_PARSE_ERROR: 'SQL 문법 오류입니다',
  ER_DUP_ENTRY: '중복된 값입니다 (유일 제약 위반)',
  ER_NO_REFERENCED_ROW_2: '부모 키가 없습니다 (참조 제약 위반)',
  ER_ROW_IS_REFERENCED_2: '자식 행이 있어 지울 수 없습니다 (참조 제약 위반)',
  ER_BAD_NULL_ERROR: 'NULL 을 넣을 수 없는 칸입니다',
  ER_TABLEACCESS_DENIED_ERROR: '권한이 없습니다',
  ER_LOCK_WAIT_TIMEOUT: '다른 세션이 잠그고 있어 기다리다 멈췄습니다',
  ER_LOCK_DEADLOCK: '교착 상태(deadlock)로 취소됐습니다',
  ER_QUERY_INTERRUPTED: '실행을 취소했습니다',
  ECONNREFUSED: '서버가 연결을 거부했습니다 (호스트·포트, 서버가 떠 있는지 확인)',
  ENOTFOUND: '호스트를 찾을 수 없습니다',
  ETIMEDOUT: '응답이 없습니다 (호스트·포트, 방화벽·VPN 확인)',
  PROTOCOL_CONNECTION_LOST: '접속이 끊겼습니다',
};

const LOST = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ER_SERVER_SHUTDOWN', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ER_CONNECTION_KILLED']);

const text = (e: unknown) => String((e as { message?: unknown } | undefined)?.message ?? e);

export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code ? code : undefined;
}

export function explainError(e: unknown): string {
  const first = text(e).split('\n')[0].trim();
  const code = errorCode(e);
  const hint = code ? HINTS[code] : undefined;
  return hint ? `${hint} — ${first}` : first;
}

export function isConnectionLost(e: unknown): boolean {
  const code = errorCode(e);
  if (code && LOST.has(code)) return true;
  return /closed state|Connection lost/i.test(text(e));
}

export const mysqlErrors: ErrorInfo = {
  code: errorCode,
  explain: explainError,
  isConnectionLost,
  isAuthFailure: (e) => errorCode(e) === 'ER_ACCESS_DENIED_ERROR',
  isCancel: (e) => errorCode(e) === 'ER_QUERY_INTERRUPTED',
  // MySQL 은 오류 자리를 글자 수로 알려 주지 않는다 ("near '…' at line N")
  offset: () => undefined,
};
