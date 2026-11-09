---
title: 기간이 겹치는 행 찾기 (유효기간·예약 중복)
category: 날짜·기간
db: oracle
tags: 기간 겹침, 중복 기간, 유효기간, 예약, 셀프 조인, GREATEST, LEAST
---
## 상황
품목 단가에 유효기간(시작일~종료일)이 있는데, **같은 품목에 기간이 겹치는 단가가 두 개** 등록돼 있으면 어느 단가를 쓸지 모호해진다. 겹치는 쌍과 겹치는 구간을 찾고 싶다. 회의실 예약 중복 검사도 같다.

## 예제 테이블
PRICE_PERIOD (단가 유효기간)

| ID | PART_NO | FROM_DT | TO_DT |
|---:|---|---|---|
| 1 | P1 | 2026-01-01 | 2026-03-31 |
| 2 | P1 | 2026-03-15 | 2026-06-30 |
| 3 | P1 | 2026-07-01 | 2026-12-31 |
| 4 | P2 | 2026-01-01 | 2026-12-31 |

## 원하는 결과
| PART_NO | A_ID | B_ID | OVERLAP_FROM | OVERLAP_TO |
|---|---:|---:|---|---|
| P1 | 1 | 2 | 2026-03-15 | 2026-03-31 |

## 쿼리
```sql
SELECT a.${묶는칸:PART_NO}, a.${키칸:ID} AS A_ID, b.${키칸} AS B_ID,
       GREATEST(a.${시작칸:FROM_DT}, b.${시작칸}) AS OVERLAP_FROM,
       LEAST(a.${종료칸:TO_DT}, b.${종료칸}) AS OVERLAP_TO
  FROM ${테이블:PRICE_PERIOD} a
  JOIN ${테이블} b
    ON b.${묶는칸} = a.${묶는칸}
   AND a.${키칸} < b.${키칸}
   AND a.${시작칸} <= b.${종료칸}
   AND b.${시작칸} <= a.${종료칸}
 ORDER BY 1, 2, 3
```

## 풀이
- 두 기간 A, B 가 겹치는 조건은 딱 하나: **A 시작 ≤ B 종료 그리고 B 시작 ≤ A 종료**. (겹치지 않는 경우 — A 가 B 보다 완전히 앞이거나 뒤 — 를 뒤집은 것)
- 같은 테이블을 a, b 로 두 번 읽어(셀프 조인) 같은 품목끼리 비교. `a.ID < b.ID` 로 (1,2)·(2,1) 이 두 번 나오거나 자기 자신과 비교되는 것을 막는다.
- 겹치는 구간 = 늦은 시작(`GREATEST`) ~ 이른 종료(`LEAST`).
- 종료일이 NULL(계속 유효)이면 `NVL(종료칸, DATE '9999-12-31')` 로 바꿔 비교한다.
- 끝나는 날과 시작하는 날이 같은 것(3-31 종료, 3-31 시작)도 겹침으로 본다. 경계가 맞닿는 것은 허용하려면 `<` 로 바꾼다.

## 연습 실행
```sql
WITH PRICE_PERIOD AS (
  SELECT 1 AS ID, 'P1' AS PART_NO, DATE '2026-01-01' AS FROM_DT, DATE '2026-03-31' AS TO_DT FROM DUAL UNION ALL
  SELECT 2, 'P1', DATE '2026-03-15', DATE '2026-06-30' FROM DUAL UNION ALL
  SELECT 3, 'P1', DATE '2026-07-01', DATE '2026-12-31' FROM DUAL UNION ALL
  SELECT 4, 'P2', DATE '2026-01-01', DATE '2026-12-31' FROM DUAL
)
SELECT a.PART_NO, a.ID AS A_ID, b.ID AS B_ID,
       GREATEST(a.FROM_DT, b.FROM_DT) AS OVERLAP_FROM,
       LEAST(a.TO_DT, b.TO_DT) AS OVERLAP_TO
  FROM PRICE_PERIOD a
  JOIN PRICE_PERIOD b
    ON b.PART_NO = a.PART_NO AND a.ID < b.ID
   AND a.FROM_DT <= b.TO_DT AND b.FROM_DT <= a.TO_DT
 ORDER BY 1, 2, 3
```
