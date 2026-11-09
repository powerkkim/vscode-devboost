---
title: 페이지 나누기와 전체 건수를 한 번에 (목록 화면용)
category: 조회 기법
db: oracle
tags: 페이징, OFFSET FETCH, ROWNUM, 전체 건수, COUNT OVER, 목록 조회
---
## 상황
목록 화면에 **2페이지(한 페이지 2건)** 를 보여 주면서 **전체 건수**도 함께 알려 줘야 한다. 목록 쿼리와 건수 쿼리를 두 번 돌리지 않고 한 번에.

## 예제 테이블
TB_PART (품목)

| PART_NO | PART_NM |
|---|---|
| P1 | 볼트 |
| P2 | 너트 |
| P3 | 와셔 |
| P4 | 핀 |
| P5 | 스프링 |

## 원하는 결과
| PART_NO | PART_NM | TOTAL_CNT |
|---|---|---:|
| P3 | 와셔 | 5 |
| P4 | 핀 | 5 |

## 쿼리
```sql
SELECT t.*, COUNT(*) OVER () AS TOTAL_CNT
  FROM ${테이블:TB_PART} t
 WHERE ${조건:1 = 1}
 ORDER BY ${정렬칸:PART_NO}
OFFSET (${페이지:2} - 1) * ${크기:2} ROWS FETCH NEXT ${크기} ROWS ONLY
```

## 풀이
- `OFFSET n ROWS FETCH NEXT m ROWS ONLY` (12c 이상) = 앞의 n 건을 건너뛰고 m 건. n = (페이지 − 1) × 크기.
- `COUNT(*) OVER ()` 는 페이지로 자르기 **전** 전체 건수를 각 줄에 붙인다 → 건수 쿼리를 따로 안 돌려도 된다.
- **정렬은 꼭 유일하게**: 정렬 칸에 같은 값이 많으면 페이지 사이에서 행이 겹치거나 빠진다. 키를 끝에 더한다 (`ORDER BY 등록일 DESC, PART_NO`).
- 11g 이하 (`OFFSET` 이 없을 때):

```sql
SELECT *
  FROM (SELECT x.*, ROWNUM AS RN
          FROM (SELECT t.*, COUNT(*) OVER () AS TOTAL_CNT FROM TB_PART t ORDER BY PART_NO) x
         WHERE ROWNUM <= 4)
 WHERE RN > 2
```
- 뒤쪽 페이지일수록 건너뛸 행을 다 읽으므로 느려진다. 아주 큰 목록은 "마지막으로 본 키 다음부터"(`WHERE PART_NO > :lastKey … FETCH NEXT 20 ROWS ONLY`) 방식이 빠르다.
- MyBatis 에서는 페이지·크기 자리를 `#{offset}`·`#{size}` 로.

## 연습 실행
```sql
WITH TB_PART AS (
  SELECT 'P1' AS PART_NO, '볼트' AS PART_NM FROM DUAL UNION ALL
  SELECT 'P2', '너트' FROM DUAL UNION ALL
  SELECT 'P3', '와셔' FROM DUAL UNION ALL
  SELECT 'P4', '핀' FROM DUAL UNION ALL
  SELECT 'P5', '스프링' FROM DUAL
)
SELECT t.*, COUNT(*) OVER () AS TOTAL_CNT
  FROM TB_PART t
 ORDER BY PART_NO
OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY
```
