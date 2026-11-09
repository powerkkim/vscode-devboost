---
title: 일별 건수·금액과 전일 대비 증감
category: 대시보드 통계
db: oracle
tags: 일별, 전일 대비, 증감, 증감률, LAG, 추이, 라인 차트
---
## 상황
대시보드에 최근 30일 일별 주문 건수와 금액, 그리고 **어제보다 얼마나 늘었는지(증감·증감률)** 를 보여 주고 싶다.

## 예제 테이블
ORDERS (주문, 주문일시에 시각이 있다)

| ORDER_DT | AMT |
|---|---:|
| 2026-11-01 09:10 | 100 |
| 2026-11-01 15:20 | 50 |
| 2026-11-02 10:00 | 200 |
| 2026-11-03 08:30 | 120 |
| 2026-11-03 11:00 | 80 |
| 2026-11-03 17:45 | 40 |

## 원하는 결과
| DAY | CNT | AMT | DIFF | DIFF_PCT |
|---|---:|---:|---:|---:|
| 2026-11-01 | 2 | 150 |  |  |
| 2026-11-02 | 1 | 200 | 50 | 33.3 |
| 2026-11-03 | 3 | 240 | 40 | 20 |

## 쿼리
```sql
SELECT DAY, CNT, AMT,
       AMT - LAG(AMT) OVER (ORDER BY DAY) AS DIFF,
       ROUND((AMT - LAG(AMT) OVER (ORDER BY DAY)) / NULLIF(LAG(AMT) OVER (ORDER BY DAY), 0) * 100, 1) AS DIFF_PCT
  FROM (SELECT TRUNC(${날짜칸:ORDER_DT}) AS DAY,
               COUNT(*) AS CNT,
               SUM(${값칸:AMT}) AS AMT
          FROM ${테이블:ORDERS}
         WHERE ${날짜칸} >= TRUNC(SYSDATE) - ${며칠:30}
         GROUP BY TRUNC(${날짜칸}))
 ORDER BY DAY
```

## 풀이
- `TRUNC(일시)` = 시각을 떼고 날짜만 → 같은 날끼리 묶인다. 월별이면 `TRUNC(일시, 'MM')`, 주별이면 `TRUNC(일시, 'IW')` (월요일 시작).
- `LAG(AMT) OVER (ORDER BY DAY)` = 바로 앞 줄(전날)의 금액. 첫날은 앞 줄이 없어 NULL.
- 증감률 = (오늘 − 어제) ÷ 어제 × 100. 어제가 0 이면 나눌 수 없으므로 `NULLIF(…, 0)` 로 NULL.
- 주문이 없는 날은 줄이 아예 없어서 "전날" 이 이틀 전이 된다. 날짜를 빠짐없이 보이려면 「빠진 날짜 채우기」 항목과 함께 쓴다.
- `WHERE 날짜칸 >= …` 처럼 칸에 함수를 씌우지 않고 비교해야 날짜 인덱스를 탄다.

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT TIMESTAMP '2026-11-01 09:10:00' AS ORDER_DT, 100 AS AMT FROM DUAL UNION ALL
  SELECT TIMESTAMP '2026-11-01 15:20:00', 50 FROM DUAL UNION ALL
  SELECT TIMESTAMP '2026-11-02 10:00:00', 200 FROM DUAL UNION ALL
  SELECT TIMESTAMP '2026-11-03 08:30:00', 120 FROM DUAL UNION ALL
  SELECT TIMESTAMP '2026-11-03 11:00:00', 80 FROM DUAL UNION ALL
  SELECT TIMESTAMP '2026-11-03 17:45:00', 40 FROM DUAL
)
SELECT DAY, CNT, AMT,
       AMT - LAG(AMT) OVER (ORDER BY DAY) AS DIFF,
       ROUND((AMT - LAG(AMT) OVER (ORDER BY DAY)) / NULLIF(LAG(AMT) OVER (ORDER BY DAY), 0) * 100, 1) AS DIFF_PCT
  FROM (SELECT TRUNC(CAST(ORDER_DT AS DATE)) AS DAY, COUNT(*) AS CNT, SUM(AMT) AS AMT
          FROM ORDERS
         GROUP BY TRUNC(CAST(ORDER_DT AS DATE)))
 ORDER BY DAY
```
