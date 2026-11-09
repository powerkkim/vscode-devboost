---
title: 구간별 분포 (금액대별 건수, 히스토그램)
category: 집계·분석
db: oracle
tags: 구간, 분포, 히스토그램, FLOOR, 금액대, 나이대, 버킷
---
## 상황
주문 금액이 어느 구간에 몰려 있는지 보고 싶다. **0~99, 100~199, 200~299 … 처럼 100 단위 구간별 건수와 비율**. 나이대별 인원, 처리시간 구간별 건수도 같은 방법이다.

## 예제 테이블
ORDERS (주문)

| ORDER_NO | AMT |
|---:|---:|
| 1 | 30 |
| 2 | 80 |
| 3 | 120 |
| 4 | 150 |
| 5 | 180 |
| 6 | 250 |

## 원하는 결과
| BUCKET_FROM | BUCKET_TO | CNT | PCT |
|---:|---:|---:|---:|
| 0 | 99 | 2 | 33.3 |
| 100 | 199 | 3 | 50 |
| 200 | 299 | 1 | 16.7 |

## 쿼리
```sql
SELECT FLOOR(${값칸:AMT} / ${구간크기:100}) * ${구간크기} AS BUCKET_FROM,
       FLOOR(${값칸} / ${구간크기}) * ${구간크기} + ${구간크기} - 1 AS BUCKET_TO,
       COUNT(*) AS CNT,
       ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 1) AS PCT
  FROM ${테이블:ORDERS}
 GROUP BY FLOOR(${값칸} / ${구간크기})
 ORDER BY BUCKET_FROM
```

## 풀이
- `FLOOR(값 / 100)` = 0, 1, 2 … 구간 번호. 여기에 100 을 곱하면 구간 시작값.
- 같은 구간 번호끼리 `GROUP BY` 해서 건수, `RATIO_TO_REPORT` 로 비율.
- 건이 하나도 없는 구간은 결과에 나오지 않는다. 차트에 빈 구간도 그리려면 구간 목록(`SELECT (LEVEL - 1) * 100 FROM DUAL CONNECT BY LEVEL <= 10`)을 만들어 LEFT JOIN 한다 (「빠진 날짜 채우기」 와 같은 방법).
- 구간 폭이 일정하지 않으면(0~1만, 1만~5만, 5만 이상) `CASE WHEN AMT < 10000 THEN '1만 미만' WHEN … END` 로 묶는다.

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT 1 AS ORDER_NO, 30 AS AMT FROM DUAL UNION ALL
  SELECT 2, 80 FROM DUAL UNION ALL
  SELECT 3, 120 FROM DUAL UNION ALL
  SELECT 4, 150 FROM DUAL UNION ALL
  SELECT 5, 180 FROM DUAL UNION ALL
  SELECT 6, 250 FROM DUAL
)
SELECT FLOOR(AMT / 100) * 100 AS BUCKET_FROM,
       FLOOR(AMT / 100) * 100 + 99 AS BUCKET_TO,
       COUNT(*) AS CNT,
       ROUND(RATIO_TO_REPORT(COUNT(*)) OVER () * 100, 1) AS PCT
  FROM ORDERS
 GROUP BY FLOOR(AMT / 100)
 ORDER BY BUCKET_FROM
```
