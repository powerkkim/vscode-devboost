---
title: 날짜 계산 모음 (이번 달 첫날·말일, 주 시작, 지난달, 분기, 주차)
category: 날짜·기간
db: oracle
tags: TRUNC, LAST_DAY, ADD_MONTHS, 월초, 월말, 주차, 분기, 날짜 함수
---
## 상황
조회 조건에 "이번 달 1일 ~ 말일", "지난달", "이번 주 월요일 ~ 일요일" 같은 날짜가 자주 필요한데 매번 헷갈린다. **기준일 하나로 자주 쓰는 날짜를 한 번에** 뽑아 보고 골라 쓰고 싶다.

## 예제 테이블
테이블 없이 기준일 하나 (2026-11-09, 월요일).

## 원하는 결과
실제로는 한 줄에 칸으로 나온다. 보기 쉽게 세로로 적으면:

| 칸 | 값 | 뜻 |
|---|---|---|
| MONTH_FIRST | 2026-11-01 | 이번 달 1일 |
| MONTH_LAST | 2026-11-30 | 이번 달 말일 |
| WEEK_MON | 2026-11-09 | 이번 주 월요일 |
| WEEK_SUN | 2026-11-15 | 이번 주 일요일 |
| PREV_MONTH_FIRST | 2026-10-01 | 지난달 1일 |
| PREV_MONTH_LAST | 2026-10-31 | 지난달 말일 |
| QUARTER_FIRST | 2026-10-01 | 이번 분기 첫날 |
| YEAR_FIRST | 2026-01-01 | 올해 1월 1일 |
| ISO_WEEK | 46 | 올해 몇째 주 (ISO) |
| PLUS_3M | 2027-02-09 | 3개월 뒤 같은 날 |

## 쿼리
```sql
SELECT TRUNC(D, 'MM') AS MONTH_FIRST,
       TRUNC(LAST_DAY(D)) AS MONTH_LAST,
       TRUNC(D, 'IW') AS WEEK_MON,
       TRUNC(D, 'IW') + 6 AS WEEK_SUN,
       ADD_MONTHS(TRUNC(D, 'MM'), -1) AS PREV_MONTH_FIRST,
       TRUNC(D, 'MM') - 1 AS PREV_MONTH_LAST,
       TRUNC(D, 'Q') AS QUARTER_FIRST,
       TRUNC(D, 'YYYY') AS YEAR_FIRST,
       TO_CHAR(D, 'IW') AS ISO_WEEK,
       ADD_MONTHS(TRUNC(D), 3) AS PLUS_3M
  FROM (SELECT ${기준일:SYSDATE} AS D FROM DUAL)
```

## 풀이
- `TRUNC(날짜, 'MM')` = 그 달 1일 0시, `'IW'` = 그 주 월요일, `'Q'` = 분기 첫날, `'YYYY'` = 1월 1일. 그냥 `TRUNC(날짜)` 는 그날 0시.
- `LAST_DAY` 는 시각을 그대로 두므로 `TRUNC` 를 한 번 더 씌웠다.
- 날짜 ± 숫자 = 그만큼의 **일**. 달 단위는 `ADD_MONTHS` (1월 31일 + 1개월 = 2월 말일로 맞춰 준다).
- 조회 조건은 "이상 ~ 미만" 으로 쓴다: 이번 달 = `일자 >= TRUNC(SYSDATE, 'MM') AND 일자 < ADD_MONTHS(TRUNC(SYSDATE, 'MM'), 1)`. `BETWEEN 1일 AND 말일` 은 말일 0시 이후(시각이 있는 값)를 놓친다.
- 기준일 자리에 `DATE '2026-11-09'` 처럼 넣으면 그날 기준으로 계산된다.

## 연습 실행
```sql
SELECT TRUNC(D, 'MM') AS MONTH_FIRST,
       TRUNC(LAST_DAY(D)) AS MONTH_LAST,
       TRUNC(D, 'IW') AS WEEK_MON,
       TRUNC(D, 'IW') + 6 AS WEEK_SUN,
       ADD_MONTHS(TRUNC(D, 'MM'), -1) AS PREV_MONTH_FIRST,
       TRUNC(D, 'MM') - 1 AS PREV_MONTH_LAST,
       TRUNC(D, 'Q') AS QUARTER_FIRST,
       TRUNC(D, 'YYYY') AS YEAR_FIRST,
       TO_CHAR(D, 'IW') AS ISO_WEEK,
       ADD_MONTHS(TRUNC(D), 3) AS PLUS_3M
  FROM (SELECT DATE '2026-11-09' AS D FROM DUAL)
```
