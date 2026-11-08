---
title: BOM 상위 → 하위 전개 (계층 쿼리, 레벨·경로 포함)
category: 계층·BOM
db: oracle
tags: CONNECT BY, START WITH, LEVEL, SYS_CONNECT_BY_PATH, 계층, 트리, 정전개
---
## 상황
BOM 테이블은 "상위 품목 → 자품목" 한 단계씩만 저장돼 있다. 완제품 A100 아래로 **모든 단계의 하위 품목을 트리 모양으로** 펼쳐 보고 싶다.
조직도(상위 부서 → 하위 부서), 메뉴 트리, 코드 계층도 같은 구조다.

## 예제 테이블
TB_BOM (상위 → 자품목, 한 단계씩)

| PARENT_NO | CHILD_NO | QTY |
|---|---|---:|
| A100 | B10 | 2 |
| A100 | B20 | 1 |
| B10 | C1 | 4 |
| B10 | C2 | 1 |
| B20 | C1 | 2 |

## 원하는 결과
| LVL | TREE | QTY | PATH |
|---:|---|---:|---|
| 1 | B10 | 2 | /B10 |
| 2 | └ C1 | 4 | /B10/C1 |
| 2 | └ C2 | 1 | /B10/C2 |
| 1 | B20 | 1 | /B20 |
| 2 | └ C1 | 2 | /B20/C1 |

## 쿼리
```sql
SELECT LEVEL AS LVL,
       LPAD(' ', (LEVEL - 1) * 2) || ${자칸:CHILD_NO} AS TREE,
       ${자칸}, ${수량칸:QTY},
       SYS_CONNECT_BY_PATH(${자칸}, '/') AS PATH,
       CONNECT_BY_ISLEAF AS IS_LEAF
  FROM ${테이블:TB_BOM}
 START WITH ${부모칸:PARENT_NO} = '${시작품목:A100}'
CONNECT BY NOCYCLE PRIOR ${자칸} = ${부모칸}
 ORDER SIBLINGS BY ${자칸}
```

## 풀이
- `START WITH` = 어디서 시작할지 (최상위 품목).
- `CONNECT BY PRIOR 자칸 = 부모칸` = "앞 줄의 자품목이 다음 줄의 상위 품목" 으로 이어 내려간다. 거꾸로(`PRIOR 부모칸 = 자칸`) 쓰면 하위 → 상위(역전개, 어디에 쓰이나).
- `LEVEL` = 몇 단계 아래인지, `SYS_CONNECT_BY_PATH` = 맨 위부터 이 품목까지의 경로, `CONNECT_BY_ISLEAF` = 1 이면 더 내려갈 것이 없는 최하위.
- `NOCYCLE` = 잘못된 데이터로 A → B → A 처럼 돌아오는 고리가 있어도 멈추지 않고 끝낸다 (고리가 있는 곳은 `CONNECT_BY_ISCYCLE` 로 찾는다).
- `ORDER SIBLINGS BY` = 트리 모양은 그대로 두고 같은 단계끼리만 정렬. 그냥 `ORDER BY` 를 쓰면 트리가 흐트러진다.
- 총 소요량(위 단계 수량을 곱한 값)은 이 구조만으로는 안 나온다 — 재귀 WITH 로 곱해 내려가는 방법을 쓴다.

## 연습 실행
```sql
WITH TB_BOM AS (
  SELECT 'A100' AS PARENT_NO, 'B10' AS CHILD_NO, 2 AS QTY FROM DUAL UNION ALL
  SELECT 'A100', 'B20', 1 FROM DUAL UNION ALL
  SELECT 'B10', 'C1', 4 FROM DUAL UNION ALL
  SELECT 'B10', 'C2', 1 FROM DUAL UNION ALL
  SELECT 'B20', 'C1', 2 FROM DUAL
)
SELECT LEVEL AS LVL,
       LPAD(' ', (LEVEL - 1) * 2) || CHILD_NO AS TREE,
       QTY,
       SYS_CONNECT_BY_PATH(CHILD_NO, '/') AS PATH,
       CONNECT_BY_ISLEAF AS IS_LEAF
  FROM TB_BOM
 START WITH PARENT_NO = 'A100'
CONNECT BY NOCYCLE PRIOR CHILD_NO = PARENT_NO
 ORDER SIBLINGS BY CHILD_NO
```
