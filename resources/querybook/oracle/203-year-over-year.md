---
title: 전년 동월 대비 (올해·작년 같은 달 나란히)
category: 대시보드 통계
db: oracle
tags: 전년 대비, 전년 동월, YoY, 증감률, 연도 비교, 조건부 집계
---
## 상황
월별 매출을 **올해와 작년 같은 달을 나란히** 놓고 증감률까지 보고 싶다. 계절을 타는 데이터는 전월보다 전년 같은 달과 비교해야 맞다.

## 예제 테이블
ORDERS (주문)

| ORDER_DT | AMT |
|---|---:|
| 2025-01-10 | 100 |
| 2025-02-10 | 200 |
| 2026-01-15 | 150 |
| 2026-02-03 | 180 |

## 원하는 결과
| MM | THIS_YEAR | LAST_YEAR | YOY_PCT |
|---|---:|---:|---:|
| 01 | 150 | 100 | 50 |
| 02 | 180 | 200 | -10 |

## 쿼리
```sql
SELECT MM, THIS_YEAR, LAST_YEAR,
       ROUND((THIS_YEAR - LAST_YEAR) / NULLIF(LAST_YEAR, 0) * 100, 1) AS YOY_PCT
  FROM (SELECT TO_CHAR(${날짜칸:ORDER_DT}, 'MM') AS MM,
               SUM(CASE WHEN EXTRACT(YEAR FROM ${날짜칸}) = ${올해:2026} THEN ${값칸:AMT} END) AS THIS_YEAR,
               SUM(CASE WHEN EXTRACT(YEAR FROM ${날짜칸}) = ${올해} - 1 THEN ${값칸} END) AS LAST_YEAR
          FROM ${테이블:ORDERS}
         WHERE ${날짜칸} >= TO_DATE((${올해} - 1) || '0101', 'YYYYMMDD')
           AND ${날짜칸} < TO_DATE((${올해} + 1) || '0101', 'YYYYMMDD')
         GROUP BY TO_CHAR(${날짜칸}, 'MM'))
 ORDER BY MM
```

## 풀이
- 월(`MM`)로 묶고, 연도에 따라 올해 칸·작년 칸에 나눠 더한다 (조건부 집계 — 「상태별 건수를 칸으로 펼치기」 와 같은 방법).
- WHERE 는 작년 1월 1일 이상, 내년 1월 1일 미만 — 칸에 함수를 씌우지 않아 인덱스를 탄다.
- 작년에 없던 달은 LAST_YEAR 가 NULL 이고 증감률도 NULL.
- 전월 대비는 월별 합계에 `LAG(AMT) OVER (ORDER BY 월)` (「일별 건수와 전일 대비」 와 같은 방법).

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT DATE '2025-01-10' AS ORDER_DT, 100 AS AMT FROM DUAL UNION ALL
  SELECT DATE '2025-02-10', 200 FROM DUAL UNION ALL
  SELECT DATE '2026-01-15', 150 FROM DUAL UNION ALL
  SELECT DATE '2026-02-03', 180 FROM DUAL
)
SELECT MM, THIS_YEAR, LAST_YEAR,
       ROUND((THIS_YEAR - LAST_YEAR) / NULLIF(LAST_YEAR, 0) * 100, 1) AS YOY_PCT
  FROM (SELECT TO_CHAR(ORDER_DT, 'MM') AS MM,
               SUM(CASE WHEN EXTRACT(YEAR FROM ORDER_DT) = 2026 THEN AMT END) AS THIS_YEAR,
               SUM(CASE WHEN EXTRACT(YEAR FROM ORDER_DT) = 2025 THEN AMT END) AS LAST_YEAR
          FROM ORDERS
         GROUP BY TO_CHAR(ORDER_DT, 'MM'))
 ORDER BY MM
```
