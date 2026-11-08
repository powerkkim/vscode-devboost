---
title: 중복 행 찾기 (중복된 행을 전부, 몇 번 겹쳤는지와 함께)
category: 데이터 점검
db: oracle
tags: 중복, COUNT OVER, ROWID, 중복 삭제, 하나만 남기기
---
## 상황
BOM 에 같은 상위·자품목 조합이 두 번 저장된 것 같다. 중복된 조합만이 아니라 **중복된 행 자체를 모든 칸과 함께** 보고, 어떤 것을 지울지 판단하고 싶다.

## 예제 테이블
TB_BOM (BOM)

| PARENT_NO | CHILD_NO | QTY | REG_DT |
|---|---|---:|---|
| P100 | C1 | 2 | 2026-01-05 |
| P100 | C1 | 2 | 2026-03-10 |
| P100 | C2 | 1 | 2026-01-05 |
| P200 | C1 | 4 | 2026-02-01 |

## 원하는 결과
| PARENT_NO | CHILD_NO | QTY | REG_DT | DUP_CNT |
|---|---|---:|---|---:|
| P100 | C1 | 2 | 2026-01-05 | 2 |
| P100 | C1 | 2 | 2026-03-10 | 2 |

## 쿼리
```sql
SELECT *
  FROM (SELECT t.*,
               COUNT(*) OVER (PARTITION BY ${키칸들:PARENT_NO, CHILD_NO}) AS DUP_CNT
          FROM ${테이블:TB_BOM} t)
 WHERE DUP_CNT > 1
 ORDER BY ${키칸들}
```

## 풀이
- `COUNT(*) OVER (PARTITION BY 키칸들)` 은 각 행 옆에 "같은 키를 가진 행이 몇 개인지" 를 붙인다 (행은 줄지 않음).
- 그 수가 2 이상인 행만 남기면 중복된 행이 전부, 모든 칸과 함께 나온다.
- 하나만 남기고 지우기 (먼저 위 쿼리로 확인하고, 실행 뒤 커밋 전에 다시 확인):

```sql
DELETE FROM TB_BOM
 WHERE ROWID IN (SELECT RID
                   FROM (SELECT ROWID AS RID,
                                ROW_NUMBER() OVER (PARTITION BY PARENT_NO, CHILD_NO ORDER BY REG_DT) AS RN
                           FROM TB_BOM)
                  WHERE RN > 1)
```
- 위 DELETE 는 키마다 `ORDER BY` 첫 번째(가장 먼저 등록된) 행만 남긴다. 최신을 남기려면 `ORDER BY REG_DT DESC`.

## 연습 실행
```sql
WITH TB_BOM AS (
  SELECT 'P100' AS PARENT_NO, 'C1' AS CHILD_NO, 2 AS QTY, DATE '2026-01-05' AS REG_DT FROM DUAL UNION ALL
  SELECT 'P100', 'C1', 2, DATE '2026-03-10' FROM DUAL UNION ALL
  SELECT 'P100', 'C2', 1, DATE '2026-01-05' FROM DUAL UNION ALL
  SELECT 'P200', 'C1', 4, DATE '2026-02-01' FROM DUAL
)
SELECT *
  FROM (SELECT t.*,
               COUNT(*) OVER (PARTITION BY PARENT_NO, CHILD_NO) AS DUP_CNT
          FROM TB_BOM t)
 WHERE DUP_CNT > 1
 ORDER BY PARENT_NO, CHILD_NO, REG_DT
```
