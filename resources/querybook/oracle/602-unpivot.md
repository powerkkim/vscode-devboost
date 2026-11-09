---
title: 칸을 행으로 세우기 (월별 칸 → 월별 행, UNPIVOT)
category: 조회 기법
db: oracle
tags: UNPIVOT, 열을 행으로, 세로로, 월별 칸, 정규화, 차트 데이터
---
## 상황
계획 테이블이 품목마다 한 줄에 1월·2월·3월 칸(M01, M02, M03)으로 되어 있다. 차트나 집계를 하려면 **품목·월·수량 세 칸의 세로 모양**이 편하다.

## 예제 테이블
PLAN (월별 계획 — 월이 칸)

| PART_NO | M01 | M02 | M03 |
|---|---:|---:|---:|
| P1 | 10 | 20 | 30 |
| P2 | 5 |  | 15 |

## 원하는 결과
| PART_NO | MON | QTY |
|---|---|---:|
| P1 | M01 | 10 |
| P1 | M02 | 20 |
| P1 | M03 | 30 |
| P2 | M01 | 5 |
| P2 | M03 | 15 |

## 쿼리
```sql
SELECT ${키칸:PART_NO}, MON, QTY
  FROM ${테이블:PLAN}
UNPIVOT (QTY FOR MON IN (${칸목록:M01, M02, M03}))
 ORDER BY ${키칸}, MON
```

## 풀이
- `UNPIVOT (값칸이름 FOR 구분칸이름 IN (칸1, 칸2, …))` = 칸1·칸2… 를 각각 한 줄로 세우고, 어느 칸이었는지를 구분칸(MON)에, 값을 값칸(QTY)에 넣는다.
- 값이 NULL 인 칸은 기본으로 빠진다 (P2 의 M02). 넣으려면 `UNPIVOT INCLUDE NULLS (…)`.
- 구분 값을 바꾸려면 `IN (M01 AS '01', M02 AS '02', M03 AS '03')`.
- 반대(행 → 칸)는 「상태별 건수를 칸으로 펼치기」 의 조건부 집계나 PIVOT.
- 11g 미만이면 `SELECT PART_NO, 'M01', M01 FROM PLAN UNION ALL SELECT PART_NO, 'M02', M02 FROM PLAN …`.

## 연습 실행
```sql
WITH PLAN AS (
  SELECT 'P1' AS PART_NO, 10 AS M01, 20 AS M02, 30 AS M03 FROM DUAL UNION ALL
  SELECT 'P2', 5, NULL, 15 FROM DUAL
)
SELECT PART_NO, MON, QTY
  FROM PLAN
UNPIVOT (QTY FOR MON IN (M01, M02, M03))
 ORDER BY PART_NO, MON
```
