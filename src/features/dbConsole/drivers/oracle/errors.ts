import type { ErrorInfo } from '../../driver/types';

/**
 * Oracle·node-oracledb 오류 해석 (vscode·oracledb 모듈에 의존하지 않는다).
 */

/** 접속에 허용할 시간 (초) — 안내 문구에도 쓴다 */
export const CONNECT_TIMEOUT_SEC = 10;

/** 오류 코드별 안내 (자주 만나는 것). 드라이버가 준 영어 메시지 앞에 붙인다 */
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
  // 쿼리를 실행할 때 자주 만나는 오류
  'ORA-00942': '테이블 또는 뷰가 없습니다 (이름·스키마·권한 확인)',
  'ORA-00904': '없는 칸 이름입니다',
  'ORA-00933': 'SQL 문장이 올바르게 끝나지 않았습니다',
  'ORA-00936': '식이 빠졌습니다',
  'ORA-00923': 'FROM 이 있어야 할 자리에 없습니다',
  'ORA-00001': '중복된 값입니다 (유일 제약 위반)',
  'ORA-01400': 'NULL 을 넣을 수 없는 칸입니다',
  'ORA-02291': '부모 키가 없습니다 (참조 제약 위반)',
  'ORA-02292': '자식 행이 있어 지울 수 없습니다 (참조 제약 위반)',
  'ORA-01031': '권한이 없습니다',
  'ORA-00054': '다른 세션이 잠그고 있습니다 (그쪽에서 커밋·롤백해야 풀립니다)',
  'ORA-01013': '실행을 취소했습니다',
};

/**
 * 접속이 끊겼다는 뜻의 오류 코드.
 * 드라이버가 ORA-03113·ORA-03114·ORA-00028 등을 NJS-500 으로 바꿔 주지만, 원래 코드로 올 때도 대비해 함께 둔다
 */
const LOST = new Set([
  'NJS-003', // 닫힌(쓸 수 없는) 접속
  'NJS-500', // 접속이 닫힘
  'NJS-501', // 서버와 연락이 끊김
  'NJS-521', // 통신 채널이 끝남
  'ORA-00028', // 세션이 강제 종료됨 (kill session)
  'ORA-01012', // 로그온돼 있지 않음
  'ORA-02396', // 쉬는 시간 한도를 넘김 (IDLE_TIME)
  'ORA-03113', // 통신 채널이 끝남
  'ORA-03114', // 접속돼 있지 않음
  'ORA-03135', // 접속이 끊김
  'ORA-12537', // 접속이 닫힘
]);

const AUTH = new Set(['ORA-01017', 'ORA-28000', 'ORA-28001', 'NJS-116']);

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | undefined)?.message;
  return typeof msg === 'string' ? msg : String(e);
}

/** 오류에서 코드(ORA-01017, NJS-503 …)를 꺼낸다 */
export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z]{3}-\d+$/.test(code)) return code;
  return /\b([A-Z]{3}-\d{3,5})\b/.exec(errorText(e))?.[1];
}

/** 화면에 보여 줄 오류 한 줄: "안내 — 원래 메시지 첫 줄" */
export function explainError(e: unknown): string {
  const first = errorText(e).split('\n')[0].trim();
  const code = errorCode(e);
  const hint = code ? HINTS[code] : undefined;
  return hint ? `${hint} — ${first}` : first;
}

export function isConnectionLost(e: unknown): boolean {
  const code = errorCode(e);
  return code !== undefined && LOST.has(code);
}

/** 오류가 난 자리 (문장 안에서 몇 번째 글자인지). 드라이버가 알려 줄 때만 */
export function errorOffset(e: unknown): number | undefined {
  const off = (e as { offset?: unknown } | undefined)?.offset;
  return typeof off === 'number' && off >= 0 ? off : undefined;
}

export const oracleErrors: ErrorInfo = {
  code: errorCode,
  explain: explainError,
  isConnectionLost,
  isAuthFailure: (e) => AUTH.has(errorCode(e) ?? ''),
  isCancel: (e) => errorCode(e) === 'ORA-01013',
  offset: errorOffset,
};
