---
title: 쉼표로 이어 붙인 값을 행으로 나누기 (REGEXP_SUBSTR)
category: 조회 기법
db: oracle
tags: 문자열 나누기, 쉼표, 구분자, REGEXP_SUBSTR, REGEXP_COUNT, split, LISTAGG 반대
---
## 상황
사용자 권한이 한 칸에 `ADMIN,USER` 처럼 쉼표로 이어 저장돼 있다. **값 하나에 한 줄씩** 나눠서 권한별로 세거나 다른 테이블과 조인하고 싶다. (「여러 행을 한 줄로 합치기」 의 반대)

## 예제 테이블
USER_ROLES (사용자 권한)

| USER_ID | ROLES |
|---|---|
| U1 | ADMIN,USER |
| U2 | USER |
| U3 | USER, AUDIT ,REPORT |

## 원하는 결과
| USER_ID | SEQ | ITEM |
|---|---:|---|
| U1 | 1 | ADMIN |
| U1 | 2 | USER |
| U2 | 1 | USER |
| U3 | 1 | USER |
| U3 | 2 | AUDIT |
| U3 | 3 | REPORT |

## 쿼리
```sql
SELECT t.${키칸:USER_ID},
       n.N AS SEQ,
       TRIM(REGEXP_SUBSTR(t.${목록칸:ROLES}, '[^,]+', 1, n.N)) AS ITEM
  FROM ${테이블:USER_ROLES} t
  JOIN (SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= ${최대개수:50}) n
    ON n.N <= REGEXP_COUNT(t.${목록칸}, '[^,]+')
 ORDER BY 1, 2
```

## 풀이
- `SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= 50` = 1~50 숫자표. 한 칸에 들어 있는 값 개수만큼(`REGEXP_COUNT`) 이 숫자표와 조인해 줄을 늘린다.
- `REGEXP_SUBSTR(문자열, '[^,]+', 1, n)` = 쉼표가 아닌 글자 덩어리 중 n 번째. `TRIM` 으로 앞뒤 공백 제거.
- 구분자가 다르면 정규식의 `,` 를 바꾼다 (세미콜론이면 `'[^;]+'`).
- 빈 값(`A,,B`)은 덩어리로 세지 않아 건너뛴다.
- 테이블의 각 행에 `CONNECT BY` 를 바로 쓰는 흔한 방법은 행이 여러 개면 결과가 엉키거나 느려진다. 숫자표 조인이 안전하다.

## 연습 실행
```sql
WITH USER_ROLES AS (
  SELECT 'U1' AS USER_ID, 'ADMIN,USER' AS ROLES FROM DUAL UNION ALL
  SELECT 'U2', 'USER' FROM DUAL UNION ALL
  SELECT 'U3', 'USER, AUDIT ,REPORT' FROM DUAL
)
SELECT t.USER_ID,
       n.N AS SEQ,
       TRIM(REGEXP_SUBSTR(t.ROLES, '[^,]+', 1, n.N)) AS ITEM
  FROM USER_ROLES t
  JOIN (SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 50) n
    ON n.N <= REGEXP_COUNT(t.ROLES, '[^,]+')
 ORDER BY 1, 2
```
