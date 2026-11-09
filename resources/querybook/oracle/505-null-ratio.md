---
title: 칸별 비어 있는 비율 (데이터 품질 점검)
category: 데이터 점검
db: oracle
tags: NULL, 빈값, 결측, 품질, 채움률, COUNT, 데이터 정합성
---
## 상황
품목 마스터의 이름·규격 칸이 **얼마나 비어 있는지**(건수와 비율) 보고 싶다. 데이터 정비 대상과 진행률을 대시보드에 보일 때 쓴다.

## 예제 테이블
TB_PART (품목)

| PART_NO | PART_NM | SPEC |
|---|---|---|
| P1 | 볼트 | M8 |
| P2 | 너트 |  |
| P3 |  |  |
| P4 | 와셔 | 8mm |
| P5 | 핀 |  |

## 원하는 결과
| TOTAL | NM_EMPTY | NM_EMPTY_PCT | SPEC_EMPTY | SPEC_EMPTY_PCT |
|---:|---:|---:|---:|---:|
| 5 | 1 | 20 | 3 | 60 |

## 쿼리
```sql
SELECT COUNT(*) AS TOTAL,
       COUNT(*) - COUNT(TRIM(${칸1:PART_NM})) AS NM_EMPTY,
       ROUND((COUNT(*) - COUNT(TRIM(${칸1}))) / NULLIF(COUNT(*), 0) * 100, 1) AS NM_EMPTY_PCT,
       COUNT(*) - COUNT(TRIM(${칸2:SPEC})) AS SPEC_EMPTY,
       ROUND((COUNT(*) - COUNT(TRIM(${칸2}))) / NULLIF(COUNT(*), 0) * 100, 1) AS SPEC_EMPTY_PCT
  FROM ${테이블:TB_PART}
```

## 풀이
- `COUNT(칸)` 은 NULL 이 아닌 것만 센다 → 전체 − COUNT(칸) = 비어 있는 수.
- `TRIM` 을 씌워 공백만 들어간 값도 빈 것으로 센다 (Oracle 은 빈 문자열 `''` 을 NULL 로 본다).
- 칸이 더 있으면 두 줄씩 늘린다. 분류별로 보려면 `SELECT 분류, … GROUP BY 분류`.
- 대략만 보면 되는 큰 테이블은 통계 정보(`SELECT COLUMN_NAME, NUM_NULLS FROM ALL_TAB_COLUMNS WHERE TABLE_NAME = 'TB_PART'`)가 빠르다 — 마지막 통계 수집 시점 기준이다.

## 연습 실행
```sql
WITH TB_PART AS (
  SELECT 'P1' AS PART_NO, '볼트' AS PART_NM, 'M8' AS SPEC FROM DUAL UNION ALL
  SELECT 'P2', '너트', NULL FROM DUAL UNION ALL
  SELECT 'P3', NULL, ' ' FROM DUAL UNION ALL
  SELECT 'P4', '와셔', '8mm' FROM DUAL UNION ALL
  SELECT 'P5', '핀', NULL FROM DUAL
)
SELECT COUNT(*) AS TOTAL,
       COUNT(*) - COUNT(TRIM(PART_NM)) AS NM_EMPTY,
       ROUND((COUNT(*) - COUNT(TRIM(PART_NM))) / NULLIF(COUNT(*), 0) * 100, 1) AS NM_EMPTY_PCT,
       COUNT(*) - COUNT(TRIM(SPEC)) AS SPEC_EMPTY,
       ROUND((COUNT(*) - COUNT(TRIM(SPEC))) / NULLIF(COUNT(*), 0) * 100, 1) AS SPEC_EMPTY_PCT
  FROM TB_PART
```
