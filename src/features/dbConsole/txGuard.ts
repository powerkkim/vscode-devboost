/**
 * 서버에 접속·잠금을 남기지 않기 위한 판단 (vscode 모듈에 의존하지 않아 단독 테스트가 가능하다).
 *  - 커밋하지 않은 채 쉬는 접속: 먼저 알리고, 더 지나면 롤백한다
 *  - 연결당 접속 수 상한: 넘으면 가장 오래 쉰 콘솔 접속을 닫을 후보로 고른다
 */

/** 커밋하지 않은 채 이만큼 쉬면 알린다: 10분 */
export const UNCOMMITTED_WARN_MS = 10 * 60_000;

export type IdleAction = 'none' | 'warn' | 'rollback';

/**
 * 커밋하지 않은 변경이 있는 접속이 idleMs 동안 쉬었을 때 할 일.
 * rollbackMs 가 0 이면 자동 롤백은 하지 않는다 (알림만). 알림은 한 번만 (warned)
 */
export function idleAction(idleMs: number, rollbackMs: number, warned: boolean, warnMs = UNCOMMITTED_WARN_MS): IdleAction {
  if (rollbackMs > 0 && idleMs >= rollbackMs) return 'rollback';
  // 자동 롤백이 알림보다 이르게 잡혀 있으면 그 절반에서 알린다
  const warnAt = rollbackMs > 0 ? Math.min(warnMs, rollbackMs / 2) : warnMs;
  if (!warned && idleMs >= warnAt) return 'warn';
  return 'none';
}

export interface SessionState {
  key: string;
  /** 콘솔만 쓰는 접속인가 (기본 접속은 트리도 쓰므로 닫을 후보가 아니다) */
  consoleOnly: boolean;
  /** 커밋하지 않은 변경이 있다 */
  dirty: boolean;
  /** 실행 중이다 */
  running: boolean;
  lastUsed: number;
}

/**
 * 접속을 하나 더 열어도 되는가. 상한에 닿았으면 닫을 후보(가장 오래 쉰, 커밋할 것 없고 쉬는 콘솔 접속)를 고른다.
 *  - { ok: true }: 그냥 열면 된다
 *  - { ok: false, victim }: victim 을 닫으면 열 수 있다
 *  - { ok: false }: 닫을 수 있는 접속이 없다 (모두 실행 중이거나 커밋 전)
 */
export function roomFor(sessions: SessionState[], max: number): { ok: boolean; victim?: string } {
  if (sessions.length < Math.max(1, max)) return { ok: true };
  const victim = sessions.filter((s) => s.consoleOnly && !s.dirty && !s.running).sort((a, b) => a.lastUsed - b.lastUsed)[0];
  return { ok: false, victim: victim?.key };
}
