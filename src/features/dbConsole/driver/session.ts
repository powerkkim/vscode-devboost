import type { DbConnection, DbDriver, ServerInfo } from './types';

/**
 * 열려 있는 접속 하나 (어느 DB든). vscode 모듈에 의존하지 않는다.
 *
 * 접속 하나는 한 번에 한 가지만 하므로 use() 로 감싼 일은 차례로 줄을 선다.
 * 쿼리를 실행하는 동안 트리에서 테이블을 펼치면, 오류를 내지 않고 쿼리가 끝난 뒤에 읽는다.
 */
export class DbSession {
  constructor(
    readonly driver: DbDriver,
    readonly connection: DbConnection,
    readonly info: ServerInfo
  ) {}

  private running = 0;
  private tail: Promise<unknown> = Promise.resolve();
  /** 마지막으로 쓴 시각 (오래 안 쓴 콘솔 접속을 닫으려고) */
  lastUsed = Date.now();

  /** 하는 일(또는 기다리는 일)이 있는지. 있으면 끊김 확인을 건너뛴다 — 긴 쿼리 뒤에 줄을 선 확인이 "답 없음"으로 보이지 않게 */
  get busy(): boolean {
    return this.running > 0;
  }

  /**
   * 서버에 열린 트랜잭션이 있는가 (알 수 없으면 undefined). 줄을 서서 묻지만 "쓴 시각"은 건드리지 않는다 —
   * 쉬는 접속을 살피는 확인이 그 접속을 쓰는 것으로 보이지 않게
   */
  async openTransaction(waitMs = 3000): Promise<boolean | undefined> {
    if (this.closed || !this.connection.hasOpenTransaction || !this.connection.isHealthy()) return undefined;
    const before = this.lastUsed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 서버가 답하지 않으면(네트워크가 죽음) 기다리지 않는다 — 닫기 · 정리가 여기서 멈추지 않게
      return await Promise.race([
        this.use((c) => c.hasOpenTransaction!()).catch(() => undefined),
        new Promise<undefined>((res) => (timer = setTimeout(() => res(undefined), waitMs))),
      ]);
    } finally {
      clearTimeout(timer);
      this.lastUsed = before;
    }
  }

  /** 닫기를 시작했다: 새 일을 받지 않는다 (닫는 중의 ROLLBACK · 닫기와 새 문장이 겹치지 않게) */
  private closed = false;

  /** 접속을 쓰는 일은 이것으로 감싼다 (앞의 일이 끝나면 시작한다) */
  use<T>(run: (connection: DbConnection) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('접속을 닫았습니다. 다시 실행하면 접속합니다.'));
    this.running++;
    this.lastUsed = Date.now();
    const p = this.tail.then(() => run(this.connection));
    this.tail = p.then(
      () => undefined,
      () => undefined
    );
    return p.finally(() => {
      this.running--;
      this.lastUsed = Date.now();
    });
  }

  /**
   * 접속을 닫는다. 실행 중인 일이 있으면 먼저 서버에서 멈추고(cancel) 끝나기를 기다린 뒤 닫는다.
   * 그냥 닫으면 서버는 쿼리가 끝날 때까지 그 세션을 계속 돌린다 (PostgreSQL 은 클라이언트가 떠난 것을 쿼리가 끝나야 안다,
   * Oracle 은 실행 중인 접속은 닫히지 않는다) — 서버에 일하는 세션이 남지 않게.
   * 닫기 전에 ROLLBACK 을 직접 보낸다: 커밋하지 않은 변경과 잠금을 드라이버·서버의 닫기 동작에 맡기지 않고 여기서 푼다
   */
  async close(waitMs = 5000, rollback = true): Promise<void> {
    if (this.closed) return this.closing;
    this.closed = true;
    // rollback=false: 이미 끊긴 것으로 판정한 접속 — 답 없는 서버에 ROLLBACK 을 보내 기다리지 않고 드라이버 쪽만 정리한다
    this.closing = rollback ? this.closeNow(waitMs) : this.connection.close();
    return this.closing;
  }

  private closing: Promise<void> | undefined;

  private async closeNow(waitMs: number): Promise<void> {
    if (this.running > 0) {
      await this.connection.cancel().catch(() => undefined);
      const settled = this.tail.then(() => true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((res) => (timer = setTimeout(() => res(false), waitMs)));
      const done = await Promise.race([settled, timeout]);
      clearTimeout(timer);
      if (!done) {
        // 멈추지 않았다: 닫기를 해 보고, 안 되면(실행 중이라 닫을 수 없음) 끝나는 대로 닫는다
        await this.connection.close().catch(() => this.tail.then(() => this.connection.close()).catch(() => undefined));
        return;
      }
    }
    const rollback = this.rollbackQuietly();
    const finished = await rollback.done;
    try {
      await this.connection.close();
    } catch (e) {
      // 닫지 못했다 (큰 롤백이 아직 도는 중 등): 접속을 버려두지 않고, 롤백이 끝나는 대로 다시 닫는다
      if (finished) throw e;
      await rollback.settled.then(() => this.connection.close()).catch(() => undefined);
    }
  }

  /**
   * 닫기 전 롤백. 끊긴 접속이면 건너뛴다. done: 롤백이 끝났으면 true, waitMs 안에 끝나지 않았으면 false
   * (큰 트랜잭션의 롤백은 오래 걸린다 — 그때는 닫기를 먼저 해 보고, settled 뒤에 다시 닫는다)
   */
  private rollbackQuietly(waitMs = 2000): { done: Promise<boolean>; settled: Promise<void> } {
    if (!this.connection.isHealthy()) return { done: Promise.resolve(true), settled: Promise.resolve() };
    const settled = Promise.resolve()
      .then(() => this.connection.rollback())
      .then(
        () => undefined,
        () => undefined
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = Promise.race([settled.then(() => true), new Promise<boolean>((res) => (timer = setTimeout(() => res(false), waitMs)))]).finally(() => clearTimeout(timer));
    return { done, settled };
  }
}
