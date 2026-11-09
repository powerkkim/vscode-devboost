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

  /** 접속을 쓰는 일은 이것으로 감싼다 (앞의 일이 끝나면 시작한다) */
  use<T>(run: (connection: DbConnection) => Promise<T>): Promise<T> {
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
   * Oracle 은 실행 중인 접속은 닫히지 않는다) — 서버에 일하는 세션이 남지 않게
   */
  async close(waitMs = 5000): Promise<void> {
    if (this.running > 0) {
      await this.connection.cancel().catch(() => undefined);
      const settled = this.tail.then(() => true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((res) => (timer = setTimeout(() => res(false), waitMs)));
      const done = await Promise.race([settled, timeout]);
      clearTimeout(timer);
      if (!done) {
        // 멈추지 않았다: 닫기를 해 보고, 안 되면(실행 중이라 닫을 수 없음) 끝나는 대로 닫는다
        await this.connection.close().catch(() => this.tail.then(() => this.connection.close()));
        return;
      }
    }
    await this.connection.close();
  }
}
