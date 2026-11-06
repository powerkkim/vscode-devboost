import type { DbDriver } from '../../driver/types';
import { mysqlConnect } from './connect';
import { MYSQL_RULES } from './dialect';
import { mysqlErrors } from './errors';
import { openMysql } from './session';

/** MySQL·MariaDB 드라이버 (mysql2, MySQL 5.7·8 / MariaDB 10 이상). 라이브러리는 처음 접속할 때 읽는다 */
export const mysqlDriver: DbDriver = {
  kind: 'mysql',
  label: 'MySQL',
  open: openMysql,
  rules: MYSQL_RULES,
  errors: mysqlErrors,
  connect: mysqlConnect,
  // DDL 을 실행하면 그 앞의 변경까지 저절로 커밋된다
  ddlCommits: true,
};
