---
title: 두 테이블 데이터 비교 (어느 쪽에만 있나, MINUS 양방향)
category: 데이터 점검
db: oracle
tags: MINUS, 비교, 차이, 백업 비교, 운영 개발 비교, 이관 검증, 동기화
---
## 상황
백업 테이블과 지금 테이블(또는 이관 전·후, 개발·운영)이 **어떻게 다른지** 보고 싶다. 한쪽에만 있는 행, 값이 달라진 행.

## 예제 테이블
TB_PART (지금)

| PART_NO | PART_NM |
|---|---|
| P1 | 볼트 |
| P2 | 너트 |
| P3 | 와셔 |

TB_PART_BK (백업)

| PART_NO | PART_NM |
|---|---|
| P1 | 볼트 |
| P2 | 너트 M8 |
| P4 | 핀 |

## 원하는 결과
| SIDE | PART_NO | PART_NM |
|---|---|---|
| A에만 | P2 | 너트 |
| B에만 | P2 | 너트 M8 |
| A에만 | P3 | 와셔 |
| B에만 | P4 | 핀 |

## 쿼리
```sql
SELECT 'A에만' AS SIDE, a.*
  FROM (SELECT ${칸목록:PART_NO, PART_NM} FROM ${A테이블:TB_PART}
        MINUS
        SELECT ${칸목록} FROM ${B테이블:TB_PART_BK}) a
UNION ALL
SELECT 'B에만' AS SIDE, b.*
  FROM (SELECT ${칸목록} FROM ${B테이블}
        MINUS
        SELECT ${칸목록} FROM ${A테이블}) b
 ORDER BY 2, 1
```

## 풀이
- `A MINUS B` = A 에 있고 B 에는 **똑같은 행이 없는** 것. 양쪽으로 한 번씩 하고 UNION ALL 로 합쳤다.
- 같은 키(P2)가 양쪽에 다 나오면 **값이 바뀐 행**, 한쪽에만 나오면 추가·삭제된 행이다.
- 비교할 칸만 칸목록에 적는다 (수정일시처럼 늘 다른 칸은 빼야 차이가 묻히지 않는다).
- MINUS 는 중복을 없애고 비교하며, NULL 끼리는 같다고 본다 (일반 `=` 비교와 달라 비교에 편하다).
- 결과가 0건이면 두 테이블(그 칸들)이 같다. 다른 DB 연결끼리는 DB 링크(`TB_PART@운영링크`)가 있을 때만 가능하다.

## 연습 실행
```sql
WITH TB_PART AS (
  SELECT 'P1' AS PART_NO, '볼트' AS PART_NM FROM DUAL UNION ALL
  SELECT 'P2', '너트' FROM DUAL UNION ALL
  SELECT 'P3', '와셔' FROM DUAL
), TB_PART_BK AS (
  SELECT 'P1' AS PART_NO, '볼트' AS PART_NM FROM DUAL UNION ALL
  SELECT 'P2', '너트 M8' FROM DUAL UNION ALL
  SELECT 'P4', '핀' FROM DUAL
)
SELECT 'A에만' AS SIDE, a.*
  FROM (SELECT PART_NO, PART_NM FROM TB_PART MINUS SELECT PART_NO, PART_NM FROM TB_PART_BK) a
UNION ALL
SELECT 'B에만' AS SIDE, b.*
  FROM (SELECT PART_NO, PART_NM FROM TB_PART_BK MINUS SELECT PART_NO, PART_NM FROM TB_PART) b
 ORDER BY 2, 1
```
