---
title: KPI 한 줄 요약 (오늘·어제·이번 달·지난달 건수와 금액)
category: 대시보드 통계
db: oracle
tags: KPI, 요약, 오늘, 어제, 이번 달, 지난달, 카드, 조건부 집계
---
## 상황
대시보드 맨 위 숫자 카드에 **오늘 건수·금액, 어제 건수, 이번 달 건수·금액, 지난달 금액**을 보여 주고 싶다. 쿼리를 여러 번 돌리지 않고 **한 번에 한 줄로** 뽑는다.

## 예제 테이블
ORDERS (주문, 오늘은 2026-11-09 라고 하자)

| ORDER_DT | AMT |
|---|---:|
| 2026-11-09 | 100 |
| 2026-11-09 | 50 |
| 2026-11-08 | 70 |
| 2026-11-01 | 30 |
| 2026-10-31 | 200 |

## 원하는 결과
| TODAY_CNT | TODAY_AMT | YDAY_CNT | MONTH_CNT | MONTH_AMT | PREV_MONTH_AMT |
|---:|---:|---:|---:|---:|---:|
| 2 | 150 | 1 | 4 | 250 | 200 |

## 쿼리
```sql
SELECT COUNT(CASE WHEN ${날짜칸:ORDER_DT} >= TRUNC(SYSDATE) THEN 1 END) AS TODAY_CNT,
       NVL(SUM(CASE WHEN ${날짜칸} >= TRUNC(SYSDATE) THEN ${값칸:AMT} END), 0) AS TODAY_AMT,
       COUNT(CASE WHEN ${날짜칸} >= TRUNC(SYSDATE) - 1 AND ${날짜칸} < TRUNC(SYSDATE) THEN 1 END) AS YDAY_CNT,
       COUNT(CASE WHEN ${날짜칸} >= TRUNC(SYSDATE, 'MM') THEN 1 END) AS MONTH_CNT,
       NVL(SUM(CASE WHEN ${날짜칸} >= TRUNC(SYSDATE, 'MM') THEN ${값칸} END), 0) AS MONTH_AMT,
       NVL(SUM(CASE WHEN ${날짜칸} < TRUNC(SYSDATE, 'MM') THEN ${값칸} END), 0) AS PREV_MONTH_AMT
  FROM ${테이블:ORDERS}
 WHERE ${날짜칸} >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -1)
```

## 풀이
- 한 번 읽으면서 칸마다 조건을 달리해 센다 (`CASE WHEN 조건 THEN 1 END`). 쿼리를 6번 돌리는 것보다 훨씬 가볍다.
- `TRUNC(SYSDATE)` = 오늘 0시, `TRUNC(SYSDATE, 'MM')` = 이번 달 1일 0시, `ADD_MONTHS(…, -1)` = 지난달 1일.
- WHERE 로 지난달 1일 이후만 읽게 범위를 좁혀 둔다 (날짜 인덱스).
- 금액이 하나도 없으면 SUM 이 NULL 이라 `NVL(…, 0)` 으로 0 을 보인다.
- 연습 실행은 오늘을 2026-11-09 로 고정했다 (`SYSDATE` 대신 `B.D`).

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT DATE '2026-11-09' AS ORDER_DT, 100 AS AMT FROM DUAL UNION ALL
  SELECT DATE '2026-11-09', 50 FROM DUAL UNION ALL
  SELECT DATE '2026-11-08', 70 FROM DUAL UNION ALL
  SELECT DATE '2026-11-01', 30 FROM DUAL UNION ALL
  SELECT DATE '2026-10-31', 200 FROM DUAL
), B AS (SELECT DATE '2026-11-09' AS D FROM DUAL)
SELECT COUNT(CASE WHEN o.ORDER_DT >= B.D THEN 1 END) AS TODAY_CNT,
       NVL(SUM(CASE WHEN o.ORDER_DT >= B.D THEN o.AMT END), 0) AS TODAY_AMT,
       COUNT(CASE WHEN o.ORDER_DT >= B.D - 1 AND o.ORDER_DT < B.D THEN 1 END) AS YDAY_CNT,
       COUNT(CASE WHEN o.ORDER_DT >= TRUNC(B.D, 'MM') THEN 1 END) AS MONTH_CNT,
       NVL(SUM(CASE WHEN o.ORDER_DT >= TRUNC(B.D, 'MM') THEN o.AMT END), 0) AS MONTH_AMT,
       NVL(SUM(CASE WHEN o.ORDER_DT < TRUNC(B.D, 'MM') THEN o.AMT END), 0) AS PREV_MONTH_AMT
  FROM ORDERS o CROSS JOIN B
 WHERE o.ORDER_DT >= ADD_MONTHS(TRUNC(B.D, 'MM'), -1)
```
