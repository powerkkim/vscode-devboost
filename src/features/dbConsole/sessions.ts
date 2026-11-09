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

/**
 * 접속 키: 연결 하나에 접속을 여럿 둘 수 있다 (콘솔마다 따로).
 *  - 연결 id 그대로: 기본 접속 — 트리·딕셔너리 읽기와 첫 번째 콘솔이 쓴다
 *  - "연결 id#N": N번째 콘솔만 쓰는 접속
 */
export const sessionKey = (connectionId: string, consoleNo = 1) => (consoleNo <= 1 ? connectionId : `${connectionId}#${consoleNo}`);
/** 접속 키 → 연결 id */
export const connectionOfKey = (key: string) => {
  const i = key.indexOf('#');
  return i < 0 ? key : key.slice(0, i);
};
/** 콘솔만 쓰는 접속인가 (기본 접속이 아님) */
export const isConsoleKey = (key: string) => key.includes('#');

/** 접속하는 사이에 끊었거나 연결을 지웠음 (연 접속은 바로 닫았다). 알릴 오류가 아니다 */
export class ConnectAborted extends Error {
  constructor() {
    super('접속하는 사이에 접속을 닫았습니다');
  }
}

/** 끊긴 접속 */
export interface LostSession {
  /** 접속 키 */
  id: string;
  /** 연결 id */
  connectionId: string;
  /** 화면에 보여 줄 이유 */
  reason: string;
}

export interface SessionsOptions {
  /** 접속을 여는 함수 (테스트에서 바꿔 끼운다). key 는 접속 키 */
  open?: (cfg: DbConnectionConfig, password: string, key: string) => Promise<DbSession>;
  /** 콘솔만 쓰는 접속을 이 시간 동안 안 쓰면 닫는다 (ms). 0 이면 닫지 않는다 */
  idleCloseMs?: number;
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
/** 콘솔만 쓰는 접속을 안 쓰면 닫는 시간: 30분 */
export const DEFAULT_IDLE_CLOSE_MS = 30 * 60_000;
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
 * 열려 있는 접속들 (접속 키마다 하나 — 연결 하나에 기본 접속과 콘솔별 접속). 기능을 끄거나 VS Code 를 닫으면 모두 닫는다.
 *
 * 서버에 접속이 남지 않게:
 *  - 콘솔별 접속은 콘솔을 닫으면 닫는다 (콘솔이 부른다)
 *  - 콘솔별 접속을 idleCloseMs 동안 안 쓰면 닫는다. 커밋하지 않은 변경이 있으면(keepOpen) 닫지 않는다
 *  - 접속하는 사이에 끊거나 지우면, 열린 뒤 바로 닫는다
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

  private readonly openFn: (cfg: DbConnectionConfig, password: string, key: string) => Promise<DbSession>;
  private checkEveryMs: number;
  private idleCloseMs: number;
  /** 닫으면 안 되는 접속인가 (커밋하지 않은 변경·실행 중). 콘솔이 정한다 */
  private keepOpen: (key: string) => boolean = () => false;
  private readonly idle = new Emitter<string>();
  /** 오래 안 써서 닫았을 때 (접속 키) */
  readonly onDidCloseIdle = this.idle.event;
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
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    Sessions.live.add(this);
  }

  /** 안 쓰는 콘솔 접속을 닫는 시간을 바꾼다 (설정 변경). 0 이면 닫지 않는다 */
  setIdleClose(ms: number) {
    this.idleCloseMs = ms;
  }

  /** 닫으면 안 되는 접속을 알려 줄 함수 (커밋하지 않은 변경이 있는 콘솔) */
  setKeepOpen(fn: (key: string) => boolean) {
    this.keepOpen = fn;
  }

  /** 그 연결에 열린(또는 여는 중인) 접속 키들 */
  keysOf(connectionId: string): string[] {
    return [...new Set([...this.open.keys(), ...this.opening.keys()])].filter((k) => connectionOfKey(k) === connectionId);
  }

  /** 그 연결에 열린 접속 수 (기본 + 콘솔별) */
  countOf(connectionId: string): number {
    return [...this.open.keys()].filter((k) => connectionOfKey(k) === connectionId).length;
  }

  /** 열린 접속 수 (모든 연결) */
  get size(): number {
    return this.open.size;
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

  /**
   * 이미 열려 있으면 그 접속을 돌려준다. key 는 접속 키 (기본: 연결의 기본 접속).
   * 접속하는 사이에 끊었으면(disconnect) 열린 접속을 바로 닫고 오류로 끝낸다 — 쓰는 쪽이 닫힌 접속을 들고 있지 않게
   */
  async connect(cfg: DbConnectionConfig, password: string, key: string = cfg.id): Promise<DbSession> {
    if (this.disposed) throw new ConnectAborted();
    const have = this.open.get(key);
    if (have) return have;
    let p = this.opening.get(key);
    if (!p) {
      const mine: Promise<DbSession> = this.openFn(cfg, password, key).then(
        (s) => {
          if (!this.disposed && this.opening.get(key) === mine) {
            this.opening.delete(key);
            s.lastUsed = Date.now();
            this.open.set(key, s);
            this.schedule();
            this.changed.fire();
            return s;
          }
          void s.close().catch(() => undefined); // 접속하는 사이에 끊었거나 연결을 지웠거나 기능을 껐음
          this.changed.fire();
          throw new ConnectAborted();
        },
        (e) => {
          if (this.opening.get(key) === mine) this.opening.delete(key);
          this.changed.fire();
          throw e;
        }
      );
      p = mine;
      this.opening.set(key, p);
      this.changed.fire();
    }
    return p;
  }

  /** 접속 하나를 닫는다 (접속 키). 여는 중이면 열린 뒤 바로 닫는다 */
  async disconnect(key: string): Promise<void> {
    const wasOpening = this.opening.delete(key);
    const s = this.open.get(key);
    if (!s) {
      if (wasOpening) this.changed.fire();
      return;
    }
    this.open.delete(key);
    this.schedule();
    this.changed.fire();
    await s.close().catch(() => undefined);
  }

  /** 그 연결의 접속을 모두 닫는다 (기본 + 콘솔별). 끊기·연결 수정·삭제 */
  async disconnectAll(connectionId: string): Promise<void> {
    await Promise.all(this.keysOf(connectionId).map((k) => this.disconnect(k)));
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
    this.closeIdle();
    if (this.checkEveryMs > 0 && Date.now() - this.lastServerCheck >= this.checkEveryMs) {
      void this.checkNow(); // 서버에 다녀오는 확인 (소켓 확인 포함)
      return;
    }
    // 소켓 상태만: 서버에 가지 않는다
    for (const [id, s] of [...this.open]) {
      if (!s.busy && !s.connection.isHealthy()) this.drop(id, s, '서버와의 연결이 닫혔습니다');
    }
  }

  /** 오래 안 쓴 콘솔 접속을 닫는다 (기본 접속은 사용자가 끊을 때까지 둔다). 실행 중이거나 커밋하지 않은 변경이 있으면 두고 */
  closeIdle(now = Date.now()): string[] {
    if (!(this.idleCloseMs > 0)) return [];
    const closed: string[] = [];
    for (const [key, s] of [...this.open]) {
      if (!isConsoleKey(key) || s.busy || now - s.lastUsed < this.idleCloseMs || this.keepOpen(key)) continue;
      this.open.delete(key);
      void s.close().catch(() => undefined);
      closed.push(key);
    }
    if (closed.length) {
      this.schedule();
      this.changed.fire();
      for (const k of closed) this.idle.fire(k);
    }
    return closed;
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
    this.lost.fire({ id, connectionId: connectionOfKey(id), reason });
  }

  /** 모두 닫는다 (실행 중이면 서버에서 멈춘 뒤). 닫기가 끝나면 풀리는 Promise — 확장을 끌 때 기다린다 */
  dispose(): Promise<void> {
    if (this.disposed) return this.closing ?? Promise.resolve();
    this.disposed = true;
    Sessions.live.delete(this);
    this.schedule();
    this.opening.clear();
    const all = [...this.open.values()];
    this.open.clear();
    this.changed.dispose();
    this.lost.dispose();
    this.idle.dispose();
    this.closing = Promise.all(all.map((s) => s.close().catch(() => undefined))).then(() => undefined);
    return this.closing;
  }

  private closing: Promise<void> | undefined;
  private static readonly live = new Set<Sessions>();

  /** 확장을 끌 때(deactivate): 열린 접속을 모두 닫고 기다린다 (오래 걸리면 timeoutMs 에서 그만 기다림) */
  static closeAll(timeoutMs = 4000): Promise<void> {
    const all = [...Sessions.live].map((x) => x.dispose());
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([Promise.all(all).then(() => undefined), new Promise<void>((res) => (timer = setTimeout(res, timeoutMs)))]).finally(() => clearTimeout(timer));
  }
}
