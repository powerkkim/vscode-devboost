---
title: 이 칸 조합이 데이터상 유일한지 검사
category: 데이터 점검
db: oracle
tags: 유일, 유일키, 중복 검사, GROUP BY, HAVING, 키 후보, UNIQUE
---
## 상황
"PART_NO + REV 가 이 테이블의 키(유일한 조합)로 쓰이고 있나?" 를 **실제 데이터로** 확인하고 싶다.
제약(PK·UK)이 정의돼 있지 않거나, 정의를 믿기 어렵거나, 새로 유니크 제약을 걸기 전에 위반하는 데이터가 있는지 볼 때 쓴다.
(제약이 어떻게 정의돼 있는지는 「PK·유니크 키 칸 조합」 항목)

## 예제 테이블
TB_PART (품목)

| PART_NO | REV | PART_NM |
|---|---:|---|
| P001 | 1 | 볼트 |
| P001 | 2 | 볼트 개정 |
| P002 | 1 | 너트 |
| P002 | 1 | 너트(잘못 들어감) |

## 원하는 결과
같은 조합이 두 번 이상인 것만 나온다. **한 줄도 안 나오면 유일하다.**

| PART_NO | REV | CNT |
|---|---:|---:|
| P002 | 1 | 2 |

## 쿼리
```sql
SELECT ${키칸들:PART_NO, REV}, COUNT(*) AS CNT
  FROM ${테이블:TB_PART}
 GROUP BY ${키칸들}
HAVING COUNT(*) > 1
 ORDER BY CNT DESC
```

## 풀이
- `GROUP BY 키칸들` 로 같은 조합끼리 묶고, `HAVING COUNT(*) > 1` 로 두 번 이상 나온 조합만 남긴다.
- 결과가 **0행이면 그 조합은 유일**하다. 나온 행이 유일하지 않게 만드는 데이터다.
- NULL 주의: `GROUP BY` 는 NULL 끼리 같은 묶음으로 본다. 그런데 Oracle 유니크 제약은 칸이 **모두** NULL 인 행은 여러 개 허용한다. NULL 이 섞인 조합이 나오면 제약을 걸 수 있는지 따로 판단한다.
- 큰 테이블에서 전체 건수와 함께 보고 싶으면:
  `SELECT COUNT(*) 전체, COUNT(DISTINCT PART_NO || '|' || REV) 조합수 FROM TB_PART` — 두 수가 같으면 유일.

## 바꿔 쓸 곳
- 키칸들 자리에 검사할 칸을 쉼표로 (하나여도 됨)

## 연습 실행
```sql
WITH TB_PART AS (
  SELECT 'P001' AS PART_NO, 1 AS REV, '볼트' AS PART_NM FROM DUAL UNION ALL
  SELECT 'P001', 2, '볼트 개정' FROM DUAL UNION ALL
  SELECT 'P002', 1, '너트' FROM DUAL UNION ALL
  SELECT 'P002', 1, '너트(잘못 들어감)' FROM DUAL
)
SELECT PART_NO, REV, COUNT(*) AS CNT
  FROM TB_PART
 GROUP BY PART_NO, REV
HAVING COUNT(*) > 1
 ORDER BY CNT DESC
```
