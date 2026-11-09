---
title: 처음 값·마지막 값을 각 행 옆에 (FIRST_VALUE, LAST_VALUE)
category: 순위·최신값
db: oracle
tags: FIRST_VALUE, LAST_VALUE, 최초 값, 최종 값, 변동, 단가 이력, 기준 대비
---
## 상황
품목 단가 이력을 날짜순으로 보면서, 각 줄 옆에 **그 품목의 최초 단가와 최종(현재) 단가**를 붙이고, 최초 대비 얼마나 올랐는지 보고 싶다.

## 예제 테이블
PRICE_HIST (단가 이력)

| PART_NO | CHG_DT | PRICE |
|---|---|---:|
| P1 | 2026-01-01 | 100 |
| P1 | 2026-03-01 | 120 |
| P1 | 2026-06-01 | 150 |
| P2 | 2026-02-01 | 50 |
| P2 | 2026-05-01 | 45 |

## 원하는 결과
| PART_NO | CHG_DT | PRICE | FIRST_PRICE | LAST_PRICE | FROM_FIRST_PCT |
|---|---|---:|---:|---:|---:|
| P1 | 2026-01-01 | 100 | 100 | 150 | 0 |
| P1 | 2026-03-01 | 120 | 100 | 150 | 20 |
| P1 | 2026-06-01 | 150 | 100 | 150 | 50 |
| P2 | 2026-02-01 | 50 | 50 | 45 | 0 |
| P2 | 2026-05-01 | 45 | 50 | 45 | -10 |

## 쿼리
```sql
SELECT ${묶는칸:PART_NO}, ${순서칸:CHG_DT}, ${값칸:PRICE},
       FIRST_VALUE(${값칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}) AS FIRST_PRICE,
       LAST_VALUE(${값칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}
                                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS LAST_PRICE,
       ROUND((${값칸} / FIRST_VALUE(${값칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}) - 1) * 100, 1) AS FROM_FIRST_PCT
  FROM ${테이블:PRICE_HIST}
 ORDER BY ${묶는칸}, ${순서칸}
```

## 풀이
- `FIRST_VALUE(값) OVER (PARTITION BY 품목 ORDER BY 일자)` = 그 품목에서 일자순 첫 값.
- **LAST_VALUE 함정**: `ORDER BY` 를 쓰면 기본 범위가 "처음부터 지금 줄까지" 라서, 그냥 쓰면 마지막 값이 아니라 **지금 줄의 값**이 나온다. 그래서 `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` (그룹 전체)을 꼭 붙인다.
- 같은 결과를 `FIRST_VALUE(값) OVER (PARTITION BY 품목 ORDER BY 일자 DESC)` 로도 얻을 수 있다 (함정이 없어 더 안전).
- NULL 을 건너뛰려면 `FIRST_VALUE(값 IGNORE NULLS)`.

## 연습 실행
```sql
WITH PRICE_HIST AS (
  SELECT 'P1' AS PART_NO, DATE '2026-01-01' AS CHG_DT, 100 AS PRICE FROM DUAL UNION ALL
  SELECT 'P1', DATE '2026-03-01', 120 FROM DUAL UNION ALL
  SELECT 'P1', DATE '2026-06-01', 150 FROM DUAL UNION ALL
  SELECT 'P2', DATE '2026-02-01', 50 FROM DUAL UNION ALL
  SELECT 'P2', DATE '2026-05-01', 45 FROM DUAL
)
SELECT PART_NO, CHG_DT, PRICE,
       FIRST_VALUE(PRICE) OVER (PARTITION BY PART_NO ORDER BY CHG_DT) AS FIRST_PRICE,
       LAST_VALUE(PRICE) OVER (PARTITION BY PART_NO ORDER BY CHG_DT
                               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS LAST_PRICE,
       ROUND((PRICE / FIRST_VALUE(PRICE) OVER (PARTITION BY PART_NO ORDER BY CHG_DT) - 1) * 100, 1) AS FROM_FIRST_PCT
  FROM PRICE_HIST
 ORDER BY PART_NO, CHG_DT
```
