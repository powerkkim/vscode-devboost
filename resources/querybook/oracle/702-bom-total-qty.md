---
title: BOM 총 소요량 (단계별 수량을 곱해 내려가기, 재귀 WITH)
category: 계층·BOM
db: oracle
tags: 재귀 WITH, 총 소요량, 소요량 전개, 수량 곱, BOM, 계층, recursive
---
## 상황
완제품 A100 1개를 만들 때 **최하위 부품이 각각 몇 개 필요한지(총 소요량)** 알고 싶다. BOM 에는 단계마다 "상위 1개당 몇 개" 만 있으므로, 위 단계 수량을 차례로 **곱해** 내려가야 한다.
(트리 모양만 보는 것은 「BOM 상위 → 하위 전개」 항목)

## 예제 테이블
TB_BOM (상위 1개당 자품목 수량)

| PARENT_NO | CHILD_NO | QTY |
|---|---|---:|
| A100 | B10 | 2 |
| A100 | B20 | 1 |
| B10 | C1 | 4 |
| B10 | C2 | 1 |
| B20 | C1 | 2 |

## 원하는 결과
| LVL | TREE | QTY | TOTAL_QTY | PATH |
|---:|---|---:|---:|---|
| 1 | B10 | 2 | 2 | /B10 |
| 2 | └ C1 | 4 | 8 | /B10/C1 |
| 2 | └ C2 | 1 | 2 | /B10/C2 |
| 1 | B20 | 1 | 1 | /B20 |
| 2 | └ C1 | 2 | 2 | /B20/C1 |

C1 은 두 경로로 쓰여 합계 10개 (8 + 2), C2 는 2개.

## 쿼리
```sql
WITH R (LVL, CHILD_NO, QTY, TOTAL_QTY, PATH) AS (
  SELECT 1, ${자칸:CHILD_NO}, ${수량칸:QTY}, ${수량칸}, CAST('/' || ${자칸} AS VARCHAR2(4000))
    FROM ${테이블:TB_BOM}
   WHERE ${부모칸:PARENT_NO} = '${시작품목:A100}'
  UNION ALL
  SELECT r.LVL + 1, b.${자칸}, b.${수량칸}, r.TOTAL_QTY * b.${수량칸}, r.PATH || '/' || b.${자칸}
    FROM R r
    JOIN ${테이블} b ON b.${부모칸} = r.CHILD_NO
)
SEARCH DEPTH FIRST BY CHILD_NO SET ORD
CYCLE CHILD_NO SET IS_CYCLE TO 'Y' DEFAULT 'N'
SELECT LVL, LPAD(' ', (LVL - 1) * 2) || CHILD_NO AS TREE, QTY, TOTAL_QTY, PATH
  FROM R
 ORDER BY ORD
```

## 풀이
- 재귀 WITH: 첫 SELECT(시작점: A100 의 바로 아래) + 두 번째 SELECT(앞에서 나온 줄의 자품목을 부모로 하는 줄)를 더 이상 나오지 않을 때까지 되풀이한다.
- 핵심은 `r.TOTAL_QTY * b.QTY` — **위 단계까지의 누적 수량 × 이 단계 수량**. CONNECT BY 로는 이 곱셈이 어렵다.
- `SEARCH DEPTH FIRST BY … SET ORD` = 트리 순서(깊이 우선)로 번호를 매겨 정렬에 쓴다. `CYCLE … SET IS_CYCLE` = 잘못된 순환(A → B → A)이 있어도 멈춘다.
- PATH 는 첫 SELECT 에서 `CAST(… AS VARCHAR2(4000))` 으로 길이를 넉넉히 잡는다 (안 하면 첫 값 길이로 정해져 깊은 단계에서 오류).
- 부품별 총 소요량 합계: 이 쿼리의 마지막 SELECT 를 `SELECT CHILD_NO, SUM(TOTAL_QTY) FROM R GROUP BY CHILD_NO` 로 바꾼다. 최하위만이면 자식이 없는 행만 거른다.
- 11g R2 이상에서 된다.

## 연습 실행
```sql
WITH TB_BOM AS (
  SELECT 'A100' AS PARENT_NO, 'B10' AS CHILD_NO, 2 AS QTY FROM DUAL UNION ALL
  SELECT 'A100', 'B20', 1 FROM DUAL UNION ALL
  SELECT 'B10', 'C1', 4 FROM DUAL UNION ALL
  SELECT 'B10', 'C2', 1 FROM DUAL UNION ALL
  SELECT 'B20', 'C1', 2 FROM DUAL
), R (LVL, CHILD_NO, QTY, TOTAL_QTY, PATH) AS (
  SELECT 1, CHILD_NO, QTY, QTY, CAST('/' || CHILD_NO AS VARCHAR2(4000))
    FROM TB_BOM
   WHERE PARENT_NO = 'A100'
  UNION ALL
  SELECT r.LVL + 1, b.CHILD_NO, b.QTY, r.TOTAL_QTY * b.QTY, r.PATH || '/' || b.CHILD_NO
    FROM R r
    JOIN TB_BOM b ON b.PARENT_NO = r.CHILD_NO
)
SEARCH DEPTH FIRST BY CHILD_NO SET ORD
CYCLE CHILD_NO SET IS_CYCLE TO 'Y' DEFAULT 'N'
SELECT LVL, LPAD(' ', (LVL - 1) * 2) || CHILD_NO AS TREE, QTY, TOTAL_QTY, PATH
  FROM R
 ORDER BY ORD
```
