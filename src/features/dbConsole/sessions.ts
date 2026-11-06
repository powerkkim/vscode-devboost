import { DbConnectionConfig } from './connection/config';
import { checkAlive } from './connection/health';
import { DbSession } from './driver/session';
import { driverFor } from './driver/registry';

/** 드라이버로 접속을 연다 */
export async function openSession(cfg: DbConnectionConfig, password: string): Promise<DbSession> {
  const driver = driverFor(cfg);
  const { connection, info } = await driver.open(cfg, password);
  return new DbSession(driver, connection, info);
}

/** 끊긴 접속 */
export interface LostSession {
  id: string;
  /** 화면에 보여 줄 이유 */
  reason: string;
}

export interface SessionsOptions {
  /** 접속을 여는 함수 (테스트에서 바꿔 끼운다) */
  open?: (cfg: DbConnectionConfig, password: string) => Promise<DbSession>;
  /** 서버에 다녀와 확인하는 간격 (ms). 0 이면 서버에는 다녀오지 않는다 */
  checkEveryMs?: number;
  /** 소켓 상태만 보는(서버에 가지 않는) 확인 간격 (ms) */
  localCheckMs?: number;
  /** 서버가 이 시간 안에 답하지 않으면 끊긴 것으로 본다 (ms) */
  pingTimeoutMs?: number;
}

/** 서버에 다녀오는 확인: 5분마다 (자주 할 이유가 없다 — 끊김은 다음에 쓸 때도 알게 된다) */
export const DEFAULT_CHECK_MS = 5 * 60_000;
/** 소켓 상태만 보는 확인: 30초마다 (네트워크를 쓰지 않는다) */
export const DEFAULT_LOCAL_CHECK_MS = 30_000;
/** 서버 확인에서 답을 기다리는 시간: 10초 (느린 망에서 멀쩡한 접속을 끊김으로 잡지 않게 넉넉히) */
export const DEFAULT_PING_TIMEOUT_MS = 10_000;

type Listener<T> = (value: T) => void;

/** vscode.EventEmitter 와 같은 모양의 작은 이벤트 (vscode 모듈 없이 테스트할 수 있게) */
class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const l of [...this.listeners]) l(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

/**
 * 열려 있는 접속들 (연결 하나에 접속 하나). 기능을 끄거나 VS Code 를 닫으면 모두 닫는다.
 *
 * 끊김 감지:
 *  - 소켓 확인: localCheckMs 마다 소켓이 닫혔는지만 본다 (서버에 가지 않음). 서버가 끊거나 세션이 죽은 경우를 잡는다
 *  - 서버 확인: checkEveryMs 마다 열린 접속에 한 번씩 다녀와 본다. 방화벽이 말없이 끊은 접속(소켓은 멀쩡해 보임)을 잡는다.
 *    끊겼으면 목록에서 빼고 onDidLose 로 알린다.
 *    쿼리를 실행하는 중인 접속은 건너뛴다 (접속 하나는 한 번에 한 가지만 해서, 긴 쿼리 뒤에 줄을 선 확인이 "답 없음"으로 보인다)
 *  - 쓰다가 난 오류: reportError() 에 넘기면 끊겨서 난 오류인지 가려 같은 처리를 한다
 * vscode 모듈에 의존하지 않는다
 */
export class Sessions {
  private readonly open = new Map<string, DbSession>();
  /** 접속하는 중인 연결 (같은 연결을 두 번 열지 않게) */
  private readonly opening = new Map<string, Promise<DbSession>>();
  private readonly changed = new Emitter<void>();
  private readonly lost = new Emitter<LostSession>();
  /** 접속이 열리거나 닫힐 때 */
  readonly onDidChange = this.changed.event;
  /** 접속이 끊긴 것을 알아챘을 때 (사용자가 끊은 것은 아님) */
  readonly onDidLose = this.lost.event;

  private readonly openFn: (cfg: DbConnectionConfig, password: string) => Promise<DbSession>;
  private checkEveryMs: number;
  private readonly localCheckMs: number;
  private readonly pingTimeoutMs: number;
  /** 마지막으로 서버에 다녀와 확인한 시각 (타이머를 켠 시각부터 센다) */
  private lastServerCheck = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<string[]> | undefined;
  private disposed = false;

  constructor(options: SessionsOptions = {}) {
    this.openFn = options.open ?? openSession;
    this.checkEveryMs = options.checkEveryMs ?? DEFAULT_CHECK_MS;
    this.localCheckMs = options.localCheckMs ?? DEFAULT_LOCAL_CHECK_MS;
    this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  }

  get(id: string): DbSession | undefined {
    return this.open.get(id);
  }

  isConnected(id: string): boolean {
    return this.open.has(id);
  }

  isConnecting(id: string): boolean {
    return this.opening.has(id);
  }

  /** 이미 열려 있으면 그 접속을 돌려준다 */
  async connect(cfg: DbConnectionConfig, password: string): Promise<DbSession> {
    const have = this.open.get(cfg.id);
    if (have) return have;
    let p = this.opening.get(cfg.id);
    if (!p) {
      p = this.openFn(cfg, password);
      this.opening.set(cfg.id, p);
      this.changed.fire();
      const mine = p;
      p.then(
        (s) => {
          if (!this.disposed && this.opening.get(cfg.id) === mine) {
            this.opening.delete(cfg.id);
            this.open.set(cfg.id, s);
            this.schedule();
          } else {
            void s.close().catch(() => undefined); // 접속하는 사이에 연결을 지웠거나 기능을 껐음
          }
          this.changed.fire();
        },
        () => {
          if (this.opening.get(cfg.id) === mine) this.opening.delete(cfg.id);
          this.changed.fire();
        }
      );
    }
    return p;
  }

  /** 사용자가 끊음 */
  async disconnect(id: string): Promise<void> {
    this.opening.delete(id);
    const s = this.open.get(id);
    if (!s) return;
    this.open.delete(id);
    this.schedule();
    this.changed.fire();
    await s.close().catch(() => undefined);
  }

  /** 서버에 다녀와 확인하는 간격을 바꾼다 (설정 변경). 0 이면 서버에는 다녀오지 않는다 (소켓 확인은 계속) */
  setCheckInterval(ms: number) {
    this.checkEveryMs = ms;
  }

  /** 열린 접속이 있을 때만 타이머를 돌린다. 타이머는 소켓 확인 간격으로 돌고, 서버 확인은 그 간격이 찼을 때만 한다 */
  private schedule() {
    const want = !this.disposed && this.open.size > 0;
    if (want && !this.timer) {
      this.lastServerCheck = Date.now();
      this.timer = setInterval(() => this.tick(), this.localCheckMs);
      this.timer.unref?.(); // 이 타이머 때문에 프로세스가 끝나지 못하는 일이 없게
    } else if (!want && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick() {
    if (this.checkEveryMs > 0 && Date.now() - this.lastServerCheck >= this.checkEveryMs) {
      void this.checkNow(); // 서버에 다녀오는 확인 (소켓 확인 포함)
      return;
    }
    // 소켓 상태만: 서버에 가지 않는다
    for (const [id, s] of [...this.open]) {
      if (!s.busy && !s.connection.isHealthy()) this.drop(id, s, '서버와의 연결이 닫혔습니다');
    }
  }

  /**
   * 열린 접속을 모두 확인하고 끊긴 것을 정리한다. 끊긴 연결의 id 들을 돌려준다.
   * 확인이 겹치지 않게, 도는 중에 또 부르면 같은 결과를 기다린다
   */
  checkNow(): Promise<string[]> {
    if (!this.checking) {
      this.checking = this.checkAll().finally(() => (this.checking = undefined));
    }
    return this.checking;
  }

  private async checkAll(): Promise<string[]> {
    this.lastServerCheck = Date.now();
    const dropped: string[] = [];
    await Promise.all(
      [...this.open].map(async ([id, s]) => {
        if (s.busy) return; // 쿼리 실행 중 — 끊겼다면 그 쿼리의 오류로 알게 된다
        const r = await checkAlive(s.connection, this.pingTimeoutMs, s.driver.errors.explain);
        // 확인하는 사이에 쿼리가 시작됐으면(답이 늦은 이유) 판정하지 않는다. 사용자가 끊었거나 다시 접속했으면 건드리지 않는다
        if (r.alive || s.busy || this.open.get(id) !== s) return;
        this.drop(id, s, r.reason);
        dropped.push(id);
      })
    );
    return dropped;
  }

  /**
   * 접속을 쓰다가 난 오류를 알린다. 접속이 끊겨서 난 오류면 목록에서 빼고 true.
   * (쿼리 오류 ORA-00942 등은 접속과 관계없으므로 false)
   */
  reportError(id: string, e: unknown): boolean {
    const s = this.open.get(id);
    if (!s || !s.driver.errors.isConnectionLost(e)) return false;
    this.drop(id, s, s.driver.errors.explain(e));
    return true;
  }

  private drop(id: string, s: DbSession, reason: string) {
    this.open.delete(id);
    this.schedule();
    void s.close().catch(() => undefined); // 이미 끊긴 접속이라 실패해도 된다 (드라이버 쪽 자원 정리)
    this.changed.fire();
    this.lost.fire({ id, reason });
  }

  dispose() {
    this.disposed = true;
    this.schedule();
    this.opening.clear();
    for (const s of this.open.values()) void s.close().catch(() => undefined);
    this.open.clear();
    this.changed.dispose();
    this.lost.dispose();
  }
}
