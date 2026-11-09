---
title: 월별 합계와 연간 누적 (누적합, 목표 달성률)
category: 대시보드 통계
db: oracle
tags: 누적, 누적합, 월별, 연누계, SUM OVER ORDER BY, 달성률
---
## 상황
월별 매출과 함께 **1월부터 그달까지의 누적 매출(연누계)과 누적 비율**을 보고 싶다. 목표 대비 달성률 그래프를 그릴 때도 쓴다.

## 예제 테이블
ORDERS (주문)

| ORDER_DT | AMT |
|---|---:|
| 2026-01-05 | 60 |
| 2026-01-20 | 40 |
| 2026-02-11 | 300 |
| 2026-03-02 | 100 |

## 원하는 결과
| MON | AMT | CUM_AMT | CUM_PCT |
|---|---:|---:|---:|
| 2026-01 | 100 | 100 | 20 |
| 2026-02 | 300 | 400 | 80 |
| 2026-03 | 100 | 500 | 100 |

## 쿼리
```sql
SELECT MON, AMT,
       SUM(AMT) OVER (PARTITION BY SUBSTR(MON, 1, 4) ORDER BY MON) AS CUM_AMT,
       ROUND(SUM(AMT) OVER (PARTITION BY SUBSTR(MON, 1, 4) ORDER BY MON)
             / SUM(AMT) OVER (PARTITION BY SUBSTR(MON, 1, 4)) * 100, 1) AS CUM_PCT
  FROM (SELECT TO_CHAR(${날짜칸:ORDER_DT}, 'YYYY-MM') AS MON,
               SUM(${값칸:AMT}) AS AMT
          FROM ${테이블:ORDERS}
         WHERE ${날짜칸} >= ${시작일:TRUNC(SYSDATE, 'YYYY')}
         GROUP BY TO_CHAR(${날짜칸}, 'YYYY-MM'))
 ORDER BY MON
```

## 풀이
- 안쪽: `TO_CHAR(일자, 'YYYY-MM')` 로 월별 합계.
- `SUM(AMT) OVER (ORDER BY MON)` = 첫 달부터 이번 달까지의 합 (누적합). `ORDER BY` 가 있으면 "처음부터 나까지", 없으면 "전체".
- `PARTITION BY SUBSTR(MON, 1, 4)` = 연도가 바뀌면 누적을 0 부터 다시. 여러 해를 같이 볼 때 필요하다.
- 목표 달성률은 `CUM_AMT / 연목표 * 100` 으로 바꾸면 된다.

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT DATE '2026-01-05' AS ORDER_DT, 60 AS AMT FROM DUAL UNION ALL
  SELECT DATE '2026-01-20', 40 FROM DUAL UNION ALL
  SELECT DATE '2026-02-11', 300 FROM DUAL UNION ALL
  SELECT DATE '2026-03-02', 100 FROM DUAL
)
SELECT MON, AMT,
       SUM(AMT) OVER (PARTITION BY SUBSTR(MON, 1, 4) ORDER BY MON) AS CUM_AMT,
       ROUND(SUM(AMT) OVER (PARTITION BY SUBSTR(MON, 1, 4) ORDER BY MON)
             / SUM(AMT) OVER (PARTITION BY SUBSTR(MON, 1, 4)) * 100, 1) AS CUM_PCT
  FROM (SELECT TO_CHAR(ORDER_DT, 'YYYY-MM') AS MON, SUM(AMT) AS AMT
          FROM ORDERS
         GROUP BY TO_CHAR(ORDER_DT, 'YYYY-MM'))
 ORDER BY MON
```
