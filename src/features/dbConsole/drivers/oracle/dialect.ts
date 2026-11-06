import type { DialectRules } from '../../sql/statements';

/**
 * Oracle 의 SQL 글 규칙 (vscode·oracledb 모듈에 의존하지 않는다 — 콘솔 화면(Webview)에서도 쓴다).
 *  - `/` 만 있는 줄이 문장 끝 (SQL*Plus·SQL Developer 관례)
 *  - PL/SQL 블록(BEGIN·DECLARE·CREATE PROCEDURE …)은 `/` 줄에서만 끝난다
 *  - q'[ … ]' 따옴표
 */
export const ORACLE_RULES: DialectRules = {
  slashTerminator: true,
  qQuote: true,
  blockStart: /^(?:declare|begin)\b|^create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:procedure|function|package|trigger|type|library)\b/i,
  procedureCall: ['call', 'exec', 'execute'],
};
