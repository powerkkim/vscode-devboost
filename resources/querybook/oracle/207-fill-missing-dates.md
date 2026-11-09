---
title: 빠진 날짜 채우기 (데이터 없는 날도 0 으로, 차트용)
category: 대시보드 통계
db: oracle
tags: 달력, 날짜 생성, CONNECT BY LEVEL, LEFT JOIN, 0 채우기, 빈 날짜, 차트
---
## 상황
일별 건수를 차트로 그리는데 주문이 없는 날은 줄이 아예 없어서 **선이 건너뛰고 날짜 간격이 틀어진다**. 기간 안의 모든 날짜를 만들고, 없는 날은 0 으로 채우고 싶다.

## 예제 테이블
ORDERS (주문 — 11-02, 11-04 에는 주문이 없다)

| ORDER_DT | AMT |
|---|---:|
| 2026-11-01 | 100 |
| 2026-11-01 | 50 |
| 2026-11-03 | 200 |
| 2026-11-05 | 70 |

## 원하는 결과
| DAY | CNT | AMT |
|---|---:|---:|
| 2026-11-01 | 2 | 150 |
| 2026-11-02 | 0 | 0 |
| 2026-11-03 | 1 | 200 |
| 2026-11-04 | 0 | 0 |
| 2026-11-05 | 1 | 70 |

## 쿼리
```sql
WITH CAL AS (
  SELECT DATE '${시작일:2026-11-01}' + LEVEL - 1 AS DAY
    FROM DUAL
 CONNECT BY LEVEL <= DATE '${종료일:2026-11-30}' - DATE '${시작일}' + 1
)
SELECT c.DAY,
       COUNT(o.${날짜칸:ORDER_DT}) AS CNT,
       NVL(SUM(o.${값칸:AMT}), 0) AS AMT
  FROM CAL c
  LEFT JOIN ${테이블:ORDERS} o
    ON o.${날짜칸} >= c.DAY AND o.${날짜칸} < c.DAY + 1
 GROUP BY c.DAY
 ORDER BY c.DAY
```

## 풀이
- `SELECT 시작일 + LEVEL - 1 FROM DUAL CONNECT BY LEVEL <= N` = 시작일부터 하루씩 N 개의 날짜를 만든다 (달력 테이블 대신).
- 달력에 실데이터를 **LEFT JOIN** → 주문이 없는 날도 달력 줄은 남는다.
- `COUNT(o.칸)` 은 NULL 을 세지 않으므로 없는 날은 0. `COUNT(*)` 를 쓰면 1 이 되니 주의.
- 조인 조건을 `TRUNC(o.일시) = c.DAY` 대신 범위(`>= c.DAY AND < c.DAY + 1`)로 써야 일시 칸 인덱스를 탄다.
- 최근 30일로 하려면 `TRUNC(SYSDATE) - 29 + LEVEL - 1 … CONNECT BY LEVEL <= 30`.
- 월 달력은 `ADD_MONTHS(DATE '2026-01-01', LEVEL - 1)` 로 같은 방법.

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT DATE '2026-11-01' AS ORDER_DT, 100 AS AMT FROM DUAL UNION ALL
  SELECT DATE '2026-11-01', 50 FROM DUAL UNION ALL
  SELECT DATE '2026-11-03', 200 FROM DUAL UNION ALL
  SELECT DATE '2026-11-05', 70 FROM DUAL
), CAL AS (
  SELECT DATE '2026-11-01' + LEVEL - 1 AS DAY
    FROM DUAL
 CONNECT BY LEVEL <= DATE '2026-11-05' - DATE '2026-11-01' + 1
)
SELECT c.DAY, COUNT(o.ORDER_DT) AS CNT, NVL(SUM(o.AMT), 0) AS AMT
  FROM CAL c
  LEFT JOIN ORDERS o ON o.ORDER_DT >= c.DAY AND o.ORDER_DT < c.DAY + 1
 GROUP BY c.DAY
 ORDER BY c.DAY
```
