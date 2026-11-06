import type { ErrorInfo } from '../../driver/types';

/**
 * PostgreSQL 오류 해석 (vscode·pg 모듈에 의존하지 않는다).
 * pg 는 서버 오류에 SQLSTATE(42P01 등)를 code 로, 문장 안의 자리를 position(1부터)으로 준다.
 * 네트워크 오류는 Node 의 코드(ECONNREFUSED 등)
 */
const HINTS: Record<string, string> = {
  '28P01': '사용자 이름 또는 비밀번호가 틀립니다',
  '28000': '이 사용자는 접속할 수 없습니다 (pg_hba.conf 확인)',
  '3D000': '그런 데이터베이스가 없습니다',
  '42P01': '테이블 또는 뷰가 없습니다 (이름·스키마·search_path 확인)',
  '42703': '없는 칸 이름입니다',
  '42601': 'SQL 문법 오류입니다',
  '42883': '그런 함수(또는 그 인자 형)가 없습니다',
  '42501': '권한이 없습니다',
  '23505': '중복된 값입니다 (유일 제약 위반)',
  '23503': '참조 제약 위반입니다',
  '23502': 'NULL 을 넣을 수 없는 칸입니다',
  '22P02': '값의 형식이 맞지 않습니다',
  '25P02': '앞 문장이 실패해 트랜잭션이 막혀 있습니다 (롤백하세요)',
  '40P01': '교착 상태(deadlock)로 취소됐습니다',
  '55P03': '다른 세션이 잠그고 있습니다',
  '57014': '실행을 취소했습니다',
  '57P01': '서버가 접속을 끊었습니다 (관리자 종료)',
  ECONNREFUSED: '서버가 연결을 거부했습니다 (호스트·포트, 서버가 떠 있는지 확인)',
  ENOTFOUND: '호스트를 찾을 수 없습니다',
  ETIMEDOUT: '응답이 없습니다 (호스트·포트, 방화벽·VPN 확인)',
  ECONNRESET: '접속이 끊겼습니다',
};

const LOST = new Set(['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', '08000', '08003', '08006']);

const text = (e: unknown) => String((e as { message?: unknown } | undefined)?.message ?? e);

export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code ? code : undefined;
}

export function explainError(e: unknown): string {
  const first = text(e).split('\n')[0].trim();
  const code = errorCode(e);
  const hint = code ? HINTS[code] : undefined;
  const detail = (e as { detail?: unknown } | undefined)?.detail;
  const msg = hint ? `${hint} — ${first}${code && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ''}` : first;
  return typeof detail === 'string' && detail ? `${msg} · ${detail}` : msg;
}

export function isConnectionLost(e: unknown): boolean {
  const code = errorCode(e);
  if (code && LOST.has(code)) return true;
  return /Connection terminated|Client has encountered a connection error|not queryable|Client was closed/i.test(text(e));
}

export const postgresErrors: ErrorInfo = {
  code: errorCode,
  explain: explainError,
  isConnectionLost,
  isAuthFailure: (e) => ['28P01', '28000'].includes(errorCode(e) ?? ''),
  isCancel: (e) => errorCode(e) === '57014',
  // pg 는 1부터 센다
  offset: (e) => {
    const p = Number((e as { position?: unknown } | undefined)?.position);
    return Number.isFinite(p) && p > 0 ? p - 1 : undefined;
  },
};
