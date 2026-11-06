/**
 * 접속이 살아 있는지 확인 (vscode·드라이버 모듈에 의존하지 않는다).
 * checkAlive(): 주기적으로 불러 끊긴 접속을 찾는다 (회사 방화벽이 쉬는 접속을 말없이 끊는 경우 등).
 * 어떤 오류가 "끊김"인지는 드라이버(errors.isConnectionLost)가 정한다.
 */

/** 확인에 필요한 접속의 부분 */
export interface Pingable {
  /** 서버에 다녀오지 않고 아는 범위에서 살아 있는지 (소켓이 닫혔으면 false) */
  isHealthy(): boolean;
  /** 서버에 한 번 다녀온다. 끊겼으면 오류 */
  ping(): Promise<void>;
}

export type Alive = { alive: true } | { alive: false; reason: string };

const firstLine = (e: unknown) => String((e as { message?: unknown } | undefined)?.message ?? e).split('\n')[0];

/**
 * 접속이 살아 있는지: 소켓 상태를 보고, 괜찮아 보이면 서버에 한 번 다녀와 본다.
 * 방화벽이 말없이 끊은 접속은 소켓이 멀쩡해 보이고 요청에 답이 없으므로, timeoutMs 안에 답이 없으면 끊긴 것으로 본다.
 * explain: 오류 → 화면에 보여 줄 이유 (드라이버의 것)
 */
export async function checkAlive(conn: Pingable, timeoutMs: number, explain: (e: unknown) => string = firstLine): Promise<Alive> {
  if (!conn.isHealthy()) return { alive: false, reason: '서버와의 연결이 닫혔습니다' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Alive>((resolve) => {
    timer = setTimeout(() => resolve({ alive: false, reason: `서버가 ${Math.round(timeoutMs / 1000)}초 동안 답이 없습니다` }), timeoutMs);
  });
  const ping = conn.ping().then(
    (): Alive => ({ alive: true }),
    (e): Alive => ({ alive: false, reason: explain(e) })
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
