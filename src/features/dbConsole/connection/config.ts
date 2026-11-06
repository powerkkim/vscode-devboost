import type { DbKind } from '../driver/types';

/**
 * DB 연결 정보와 입력값 확인 중 DB 종류와 관계없는 부분 (vscode·드라이버 모듈에 의존하지 않아 단독 테스트 가능).
 * 주소를 어떻게 적는지(서비스 이름·SID·JDBC URL)는 드라이버의 connect 가 맡는다.
 */

/** 접속 대상을 적는 방식: 서비스 이름 / SID / 연결 문자열 전체. 드라이버가 뜻을 정한다 (예: Oracle 은 서비스 이름·SID·TNS 설명자) */
export type TargetKind = 'service' | 'sid' | 'raw';

export interface DbConnectionConfig {
  id: string;
  /** DB 종류. 예전에 저장한 연결에는 없다 → Oracle */
  kind?: DbKind;
  /** 목록에 보이는 이름 */
  name: string;
  /** targetKind 가 'raw' 면 쓰지 않는다 */
  host: string;
  port: number;
  targetKind: TargetKind;
  /** 서비스 이름 / SID / 연결 문자열 전체 */
  target: string;
  user: string;
  /** 읽기 전용으로 쓸 연결 (변경 쿼리를 막는 데 쓴다) */
  readOnly: boolean;
  /** 운영 DB 표시 (목록에서 빨간색) */
  production: boolean;
  /** 비밀번호를 저장해 두는지. false 면 접속할 때 묻는다 */
  savePassword: boolean;
}

export const kindOf = (c: Pick<DbConnectionConfig, 'kind'>): DbKind => c.kind ?? 'oracle';

// ───────── 입력값 확인 (틀리면 이유, 맞으면 undefined) ─────────

export function checkName(v: string): string | undefined {
  return v.trim() ? undefined : '이름을 넣으세요';
}

export function checkHost(v: string): string | undefined {
  const t = v.trim();
  if (!t) return '호스트(서버 주소)를 넣으세요';
  if (/\s/.test(t)) return '호스트에 공백이 있습니다';
  if (/[()=/]/.test(t)) return '호스트에 쓸 수 없는 글자가 있습니다 (괄호, =, /)';
  return undefined;
}

export function checkPort(v: string): string | undefined {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return '포트는 숫자입니다';
  const n = Number(t);
  return n >= 1 && n <= 65535 ? undefined : '포트는 1~65535 사이입니다';
}

export function checkUser(v: string): string | undefined {
  return v.trim() ? undefined : '사용자 이름을 넣으세요';
}
