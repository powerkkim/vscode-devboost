import type { DialectRules } from '../../sql/statements';

/**
 * PostgreSQL 의 SQL 글 규칙 (콘솔 화면에서도 쓴다).
 *  - 문장은 ; 에서 끝난다. 함수 본문 등은 $$ … $$ 로 감싸므로 안의 ; 는 세지 않는다 (/ 줄 규칙은 없다)
 *  - x::int 같은 형 변환의 :: 는 파라미터가 아니다
 */
export const POSTGRES_RULES: DialectRules = {
  slashTerminator: false,
  qQuote: false,
  dollarQuote: true,
  procedureCall: ['call', 'do'],
};
