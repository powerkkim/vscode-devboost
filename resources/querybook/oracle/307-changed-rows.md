---
title: 값이 바뀐 시점만 뽑기 (이전 행과 비교, LAG)
category: 순위·최신값
db: oracle
tags: LAG, LEAD, 변경 시점, 이전 값, 변화, 중복 제거, 이력 압축
---
## 상황
일별로 단가를 기록하는 이력 테이블에 같은 값이 계속 반복돼 있다. **단가가 실제로 바뀐 날만** (이전 값과 함께) 보고 싶다.

## 예제 테이블
PRICE_DAILY (일별 단가)

| PART_NO | DAY | PRICE |
|---|---|---:|
| P1 | 2026-01-01 | 100 |
| P1 | 2026-02-01 | 100 |
| P1 | 2026-03-01 | 120 |
| P1 | 2026-04-01 | 120 |
| P1 | 2026-05-01 | 100 |

## 원하는 결과
| PART_NO | DAY | PREV_PRICE | PRICE |
|---|---|---:|---:|
| P1 | 2026-01-01 |  | 100 |
| P1 | 2026-03-01 | 100 | 120 |
| P1 | 2026-05-01 | 120 | 100 |

## 쿼리
```sql
SELECT ${묶는칸:PART_NO}, ${순서칸:DAY}, PREV_VALUE AS PREV_PRICE, ${값칸:PRICE}
  FROM (SELECT t.*,
               LAG(${값칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}) AS PREV_VALUE
          FROM ${테이블:PRICE_DAILY} t)
 WHERE PREV_VALUE IS NULL
    OR PREV_VALUE <> ${값칸}
 ORDER BY ${묶는칸}, ${순서칸}
```

## 풀이
- `LAG(값) OVER (PARTITION BY 품목 ORDER BY 일자)` = 같은 품목의 **바로 앞 줄 값**. `LEAD` 는 바로 다음 줄.
- 앞 값과 다르거나(바뀜) 앞 값이 없으면(첫 줄) 남긴다.
- 값 자체가 NULL 일 수 있으면 비교가 빠지므로 `DECODE(PREV_VALUE, 값, 0, 1) = 1` 로 쓴다 (DECODE 는 NULL 끼리 같다고 본다).
- `LAG(값, 2)` = 두 줄 앞, `LAG(값, 1, 0)` = 앞 줄이 없으면 0.

## 연습 실행
```sql
WITH PRICE_DAILY AS (
  SELECT 'P1' AS PART_NO, DATE '2026-01-01' AS DAY, 100 AS PRICE FROM DUAL UNION ALL
  SELECT 'P1', DATE '2026-02-01', 100 FROM DUAL UNION ALL
  SELECT 'P1', DATE '2026-03-01', 120 FROM DUAL UNION ALL
  SELECT 'P1', DATE '2026-04-01', 120 FROM DUAL UNION ALL
  SELECT 'P1', DATE '2026-05-01', 100 FROM DUAL
)
SELECT PART_NO, DAY, PREV_VALUE AS PREV_PRICE, PRICE
  FROM (SELECT t.*, LAG(PRICE) OVER (PARTITION BY PART_NO ORDER BY DAY) AS PREV_VALUE
          FROM PRICE_DAILY t)
 WHERE PREV_VALUE IS NULL OR PREV_VALUE <> PRICE
 ORDER BY PART_NO, DAY
```
