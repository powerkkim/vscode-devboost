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

  /** 하는 일(또는 기다리는 일)이 있는지. 있으면 끊김 확인을 건너뛴다 — 긴 쿼리 뒤에 줄을 선 확인이 "답 없음"으로 보이지 않게 */
  get busy(): boolean {
    return this.running > 0;
  }

  /** 접속을 쓰는 일은 이것으로 감싼다 (앞의 일이 끝나면 시작한다) */
  use<T>(run: (connection: DbConnection) => Promise<T>): Promise<T> {
    this.running++;
    const p = this.tail.then(() => run(this.connection));
    this.tail = p.then(
      () => undefined,
      () => undefined
    );
    return p.finally(() => {
      this.running--;
    });
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
