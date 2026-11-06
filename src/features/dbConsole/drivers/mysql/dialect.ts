import type { DialectRules } from '../../sql/statements';

/**
 * MySQL·MariaDB 의 SQL 글 규칙 (콘솔 화면에서도 쓴다).
 *  - `이름` 따옴표, # 한 줄 주석(#{…} 는 MyBatis 파라미터), 문자열 안의 \' 
 *  - 문장은 ; 에서 끝난다. DELIMITER 지시문은 콘솔에서 쓰지 않는다 (프로시저 본문은 선택해서 한 문장으로 실행)
 */
export const MYSQL_RULES: DialectRules = {
  slashTerminator: false,
  qQuote: false,
  backtick: true,
  hashComment: true,
  backslashEscape: true,
  procedureCall: ['call'],
};
