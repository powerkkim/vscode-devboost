---
title: 누적 비율로 A·B·C 등급 나누기 (파레토, ABC 분석)
category: 집계·분석
db: oracle
tags: 파레토, ABC 분석, 누적 비율, 80/20, 재고 등급, SUM OVER
---
## 상황
품목이 많은데 매출의 대부분은 소수 품목에서 나온다. **매출 큰 순으로 누적 비율을 내고, 누적 70% 까지는 A, 90% 까지는 B, 나머지는 C** 등급을 붙이고 싶다. 재고·구매 관리에서 중점 품목을 고를 때 쓴다.

## 예제 테이블
SALES (품목별 매출 — 같은 품목이 여러 줄이어도 된다)

| PART_NO | AMT |
|---|---:|
| P1 | 500 |
| P2 | 200 |
| P3 | 150 |
| P4 | 100 |
| P5 | 50 |

## 원하는 결과
| PART_NO | AMT | PCT | CUM_PCT | GRADE |
|---|---:|---:|---:|---|
| P1 | 500 | 50 | 50 | A |
| P2 | 200 | 20 | 70 | A |
| P3 | 150 | 15 | 85 | B |
| P4 | 100 | 10 | 95 | C |
| P5 | 50 | 5 | 100 | C |

## 쿼리
```sql
SELECT ${품목칸:PART_NO}, AMT, PCT, CUM_PCT,
       CASE WHEN CUM_PCT <= ${A기준:70} THEN 'A'
            WHEN CUM_PCT <= ${B기준:90} THEN 'B'
            ELSE 'C' END AS GRADE
  FROM (SELECT ${품목칸}, AMT,
               ROUND(AMT / SUM(AMT) OVER () * 100, 1) AS PCT,
               ROUND(SUM(AMT) OVER (ORDER BY AMT DESC, ${품목칸} ROWS UNBOUNDED PRECEDING)
                     / SUM(AMT) OVER () * 100, 1) AS CUM_PCT
          FROM (SELECT ${품목칸}, SUM(${값칸:AMT}) AS AMT
                  FROM ${테이블:SALES}
                 GROUP BY ${품목칸}))
 ORDER BY AMT DESC, ${품목칸}
```

## 풀이
- 가장 안쪽: 품목별 합계.
- 가운데: `SUM(AMT) OVER (ORDER BY AMT DESC … ROWS UNBOUNDED PRECEDING)` = 큰 순으로 세웠을 때 **첫 줄부터 나까지의 합** (누적합). 전체 합(`OVER ()`)으로 나누면 누적 비율.
- `ROWS UNBOUNDED PRECEDING` 을 꼭 쓴다. 빼면 금액이 같은 품목들이 한꺼번에 더해져 누적값이 건너뛴다. 정렬에 품목번호를 더한 것도 같은 이유.
- 바깥: 누적 비율로 등급. 기준(70·90)은 회사 기준에 맞춘다.

## 연습 실행
```sql
WITH SALES AS (
  SELECT 'P1' AS PART_NO, 500 AS AMT FROM DUAL UNION ALL
  SELECT 'P2', 200 FROM DUAL UNION ALL
  SELECT 'P3', 150 FROM DUAL UNION ALL
  SELECT 'P4', 100 FROM DUAL UNION ALL
  SELECT 'P5', 50 FROM DUAL
)
SELECT PART_NO, AMT, PCT, CUM_PCT,
       CASE WHEN CUM_PCT <= 70 THEN 'A' WHEN CUM_PCT <= 90 THEN 'B' ELSE 'C' END AS GRADE
  FROM (SELECT PART_NO, AMT,
               ROUND(AMT / SUM(AMT) OVER () * 100, 1) AS PCT,
               ROUND(SUM(AMT) OVER (ORDER BY AMT DESC, PART_NO ROWS UNBOUNDED PRECEDING)
                     / SUM(AMT) OVER () * 100, 1) AS CUM_PCT
          FROM (SELECT PART_NO, SUM(AMT) AS AMT FROM SALES GROUP BY PART_NO))
 ORDER BY AMT DESC, PART_NO
```
