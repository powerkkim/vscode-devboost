import { errorCode, explainError } from './oracleClient';

/**
 * 접속이 살아 있는지 확인 (vscode 모듈에 의존하지 않는다).
 *  - checkAlive(): 주기적으로 불러 끊긴 접속을 찾는다 (회사 방화벽이 쉬는 접속을 말없이 끊는 경우 등)
 *  - isConnectionLost(): 쿼리를 실행하다 난 오류가 "접속이 끊겨서"인지 가린다
 */

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

export function isConnectionLost(e: unknown): boolean {
  const code = errorCode(e);
  return code !== undefined && LOST.has(code);
}

/** 확인에 필요한 드라이버 접속의 부분 */
export interface Pingable {
  /** 서버에 다녀오지 않고 아는 범위에서 살아 있는지 (소켓이 닫혔으면 false) */
  isHealthy(): boolean;
  /** 서버에 한 번 다녀온다. 끊겼으면 오류 */
  ping(): Promise<void>;
}

export type Alive = { alive: true } | { alive: false; reason: string };

/**
 * 접속이 살아 있는지: 소켓 상태를 보고, 괜찮아 보이면 서버에 한 번 다녀와 본다.
 * 방화벽이 말없이 끊은 접속은 소켓이 멀쩡해 보이고 요청에 답이 없으므로, timeoutMs 안에 답이 없으면 끊긴 것으로 본다
 */
export async function checkAlive(conn: Pingable, timeoutMs: number): Promise<Alive> {
  if (!conn.isHealthy()) return { alive: false, reason: '서버와의 연결이 닫혔습니다' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Alive>((resolve) => {
    timer = setTimeout(() => resolve({ alive: false, reason: `서버가 ${Math.round(timeoutMs / 1000)}초 동안 답이 없습니다` }), timeoutMs);
  });
  const ping = conn.ping().then(
    (): Alive => ({ alive: true }),
    (e): Alive => ({ alive: false, reason: explainError(e) })
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
