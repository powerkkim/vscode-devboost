import { DbConnectionConfig, kindOf } from '../connection/config';
import type { DbDriver, DbKind } from './types';
import { oracleDriver } from '../drivers/oracle';
import { postgresDriver } from '../drivers/postgres';

/**
 * DB 종류 → 드라이버. 공통 코드가 drivers/<db>/ 를 직접 부르지 않고 이곳을 거친다.
 * (드라이버 모듈 자체는 가볍다. 실제 DB 드라이버 라이브러리는 처음 접속할 때 불러온다)
 */
const DRIVERS: Record<DbKind, DbDriver> = {
  oracle: oracleDriver,
  postgres: postgresDriver,
  mysql: postgresDriver, // 아래에서 바꾼다
};

export function driverOf(kind: DbKind | undefined): DbDriver {
  return DRIVERS[kind ?? 'oracle'];
}

export function driverFor(cfg: Pick<DbConnectionConfig, 'kind'>): DbDriver {
  return driverOf(kindOf(cfg));
}

/** 목록에 보여 줄 한 줄: user@host:port/service */
export function describeConnection(c: DbConnectionConfig): string {
  return `${c.user}@${driverFor(c).connect.describeTarget(c)}`;
}
