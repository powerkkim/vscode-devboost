---
title: 부모 없는 자식 행 찾기 (참조 무결성 점검, NOT EXISTS)
category: 데이터 점검
db: oracle
tags: NOT EXISTS, 고아 데이터, 참조 무결성, FK 없음, 마스터 없음, 정합성
---
## 상황
BOM 의 자품목 번호가 품목 마스터에 없는 경우가 있다 (FK 가 없어서 잘못 들어갔거나, 마스터가 지워짐). **마스터에 없는 값을 가진 행**을 찾고 싶다.

## 예제 테이블
TB_PART (품목 마스터)

| PART_NO |
|---|
| A100 |
| B10 |

TB_BOM (BOM)

| PARENT_NO | CHILD_NO |
|---|---|
| A100 | B10 |
| A100 | B99 |

## 원하는 결과
| PARENT_NO | CHILD_NO |
|---|---|
| A100 | B99 |

## 쿼리
```sql
SELECT c.*
  FROM ${자식테이블:TB_BOM} c
 WHERE c.${참조칸:CHILD_NO} IS NOT NULL
   AND NOT EXISTS (SELECT 1
                     FROM ${부모테이블:TB_PART} p
                    WHERE p.${부모키칸:PART_NO} = c.${참조칸})
```

## 풀이
- `NOT EXISTS (부모에서 같은 키 찾기)` = 부모에 짝이 없는 자식만 남긴다.
- `NOT IN (SELECT 부모키 FROM 부모)` 도 비슷하지만, 부모 키에 NULL 이 하나라도 있으면 **결과가 0건**이 되는 함정이 있어 NOT EXISTS 를 쓴다.
- 부모 칸(PARENT_NO)도 점검하려면 참조칸 자리만 바꿔 한 번 더.
- 건수만 보려면 `SELECT COUNT(*)`. 지울 때는 같은 조건으로 `DELETE FROM 자식 c WHERE NOT EXISTS (…)` — 먼저 SELECT 로 확인하고.
- 이런 데이터를 막으려면 FK 제약을 건다 (`ALTER TABLE TB_BOM ADD CONSTRAINT … FOREIGN KEY (CHILD_NO) REFERENCES TB_PART (PART_NO)`) — 이 점검 결과가 0건이어야 걸린다.

## 연습 실행
```sql
WITH TB_PART AS (
  SELECT 'A100' AS PART_NO FROM DUAL UNION ALL
  SELECT 'B10' FROM DUAL
), TB_BOM AS (
  SELECT 'A100' AS PARENT_NO, 'B10' AS CHILD_NO FROM DUAL UNION ALL
  SELECT 'A100', 'B99' FROM DUAL
)
SELECT c.*
  FROM TB_BOM c
 WHERE c.CHILD_NO IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM TB_PART p WHERE p.PART_NO = c.CHILD_NO)
```
