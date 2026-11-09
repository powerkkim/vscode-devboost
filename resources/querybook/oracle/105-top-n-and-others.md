---
title: 상위 N개만 보이고 나머지는 '기타'로 묶기
category: 집계·분석
db: oracle
tags: TOP N, 기타, ROW_NUMBER, 차트, 순위, 그 외
---
## 상황
고객이 수백 명이라 차트에 다 그릴 수 없다. **매출 상위 3명은 이름으로, 나머지는 '기타' 한 줄로 합쳐서** 보고 싶다.

## 예제 테이블
ORDERS (주문)

| CUST | AMT |
|---|---:|
| A사 | 500 |
| B사 | 300 |
| C사 | 200 |
| D사 | 100 |
| E사 | 50 |

## 원하는 결과
| NAME | AMT |
|---|---:|
| A사 | 500 |
| B사 | 300 |
| C사 | 200 |
| 기타 | 150 |

## 쿼리
```sql
SELECT CASE WHEN RN <= ${몇개:3} THEN NAME ELSE '기타' END AS NAME,
       SUM(AMT) AS AMT
  FROM (SELECT ${이름칸:CUST} AS NAME,
               SUM(${값칸:AMT}) AS AMT,
               ROW_NUMBER() OVER (ORDER BY SUM(${값칸}) DESC) AS RN
          FROM ${테이블:ORDERS}
         GROUP BY ${이름칸})
 GROUP BY CASE WHEN RN <= ${몇개} THEN NAME ELSE '기타' END
 ORDER BY MIN(RN)
```

## 풀이
- 안쪽: 고객별 합계를 내고 큰 순서로 1, 2, 3… 번호(`RN`).
- 바깥: 번호가 N 이하면 이름 그대로, 아니면 '기타' 로 바꿔서 **한 번 더 GROUP BY** → 기타가 한 줄로 합쳐진다.
- `ORDER BY MIN(RN)` = 상위 순서대로, 기타(가장 작은 번호가 N+1)는 맨 끝.
- 상위 N 안에 동점이 있을 때 둘 다 보이고 싶으면 `ROW_NUMBER` 대신 `RANK`.

## 연습 실행
```sql
WITH ORDERS AS (
  SELECT 'A사' AS CUST, 500 AS AMT FROM DUAL UNION ALL
  SELECT 'B사', 300 FROM DUAL UNION ALL
  SELECT 'C사', 200 FROM DUAL UNION ALL
  SELECT 'D사', 100 FROM DUAL UNION ALL
  SELECT 'E사', 50 FROM DUAL
)
SELECT CASE WHEN RN <= 3 THEN NAME ELSE '기타' END AS NAME,
       SUM(AMT) AS AMT
  FROM (SELECT CUST AS NAME, SUM(AMT) AS AMT,
               ROW_NUMBER() OVER (ORDER BY SUM(AMT) DESC) AS RN
          FROM ORDERS
         GROUP BY CUST)
 GROUP BY CASE WHEN RN <= 3 THEN NAME ELSE '기타' END
 ORDER BY MIN(RN)
```
