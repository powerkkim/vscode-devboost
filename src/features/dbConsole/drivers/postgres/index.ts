import type { DbDriver } from '../../driver/types';
import { postgresConnect } from './connect';
import { POSTGRES_RULES } from './dialect';
import { postgresErrors } from './errors';
import { openPostgres } from './session';

/** PostgreSQL 드라이버 (pg, 9.6 이상). 라이브러리는 처음 접속할 때 읽는다 */
export const postgresDriver: DbDriver = {
  kind: 'postgres',
  label: 'PostgreSQL',
  open: openPostgres,
  rules: POSTGRES_RULES,
  errors: postgresErrors,
  connect: postgresConnect,
  // DDL 도 트랜잭션 안에서 실행된다 (커밋해야 남는다)
  ddlCommits: false,
};
