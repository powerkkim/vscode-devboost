import type { DialectRules } from '../sql/statements';
import type { DbKind } from './types';
import { ORACLE_RULES } from '../drivers/oracle/dialect';
import { POSTGRES_RULES } from '../drivers/postgres/dialect';
import { MYSQL_RULES } from '../drivers/mysql/dialect';

/**
 * DB 종류 → SQL 글 규칙만. 콘솔 화면(Webview)이 쓴다 — 드라이버 전체(Node 전용)를 화면 번들에 끌어들이지 않게 따로 둔다.
 */
const RULES: Record<DbKind, DialectRules> = {
  oracle: ORACLE_RULES,
  postgres: POSTGRES_RULES,
  mysql: MYSQL_RULES,
};

export function rulesOf(kind: DbKind | undefined): DialectRules {
  return RULES[kind ?? 'oracle'];
}
