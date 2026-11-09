---
title: 소계·총계 붙이기 (부서별·직무별 합계에 부서 소계와 전체 총계)
category: 집계·분석
db: oracle
tags: ROLLUP, GROUPING, 소계, 총계, 합계 행, 집계표
---
## 상황
부서·직무별 인원과 월급 합계를 내면서, **부서마다 소계 줄**과 **맨 아래 총계 줄**도 같은 결과에 넣고 싶다.
엑셀 피벗의 "부분합" 처럼 보이게.

## 예제 테이블
EMP (사원)

| EMP_NAME | DEPT_NO | JOB | SAL |
|---|---:|---|---:|
| 김철수 | 10 | 개발 | 300 |
| 이영희 | 10 | 기획 | 200 |
| 박민수 | 20 | 개발 | 400 |
| 최지은 | 20 | 개발 | 350 |
| 정우성 | 20 | 영업 | 250 |

## 원하는 결과
| DEPT | JOB_NM | CNT | SAL_SUM |
|---|---|---:|---:|
| 10 | 개발 | 1 | 300 |
| 10 | 기획 | 1 | 200 |
| 10 | 소계 | 2 | 500 |
| 20 | 개발 | 2 | 750 |
| 20 | 영업 | 1 | 250 |
| 20 | 소계 | 3 | 1000 |
| 총계 |  | 5 | 1500 |

## 쿼리
```sql
SELECT CASE WHEN GROUPING(${큰묶음:DEPT_NO}) = 1 THEN '총계' ELSE TO_CHAR(${큰묶음}) END AS DEPT,
       CASE WHEN GROUPING(${큰묶음}) = 1 THEN NULL
            WHEN GROUPING(${작은묶음:JOB}) = 1 THEN '소계'
            ELSE TO_CHAR(${작은묶음}) END AS JOB_NM,
       COUNT(*) AS CNT,
       SUM(${값칸:SAL}) AS SAL_SUM
  FROM ${테이블:EMP}
 GROUP BY ROLLUP(${큰묶음}, ${작은묶음})
 ORDER BY GROUPING(${큰묶음}), ${큰묶음}, GROUPING(${작은묶음}), ${작은묶음}
```

## 풀이
- `ROLLUP(A, B)` 는 (A, B) 별 합계 + A 별 합계(소계) + 전체 합계(총계) 를 한 번에 만든다.
- 소계·총계 줄에서는 묶지 않은 칸이 NULL 로 나온다. `GROUPING(칸)` 이 1 이면 "이 줄은 그 칸으로 묶지 않은 합계 줄" 이라는 뜻이라, 이것으로 '소계'·'총계' 글자를 넣는다.
- `ORDER BY GROUPING(…)` 을 앞에 두어 소계는 그 부서 맨 아래, 총계는 맨 끝에 오게 했다.
- 결과 칸 이름을 원래 칸과 다르게(`JOB_NM`) 지었다. 같은 이름(`AS JOB`)으로 지으면 `ORDER BY`·`GROUPING` 안의 JOB 이 원래 칸인지 결과 칸인지 헷갈려 오류가 날 수 있다.
- 총계만 필요하면 `GROUP BY ROLLUP(DEPT_NO)`, 원하는 조합만 고르려면 `GROUPING SETS((DEPT_NO, JOB), (DEPT_NO), ())`.

## 연습 실행
```sql
WITH EMP AS (
  SELECT '김철수' AS EMP_NAME, 10 AS DEPT_NO, '개발' AS JOB, 300 AS SAL FROM DUAL UNION ALL
  SELECT '이영희', 10, '기획', 200 FROM DUAL UNION ALL
  SELECT '박민수', 20, '개발', 400 FROM DUAL UNION ALL
  SELECT '최지은', 20, '개발', 350 FROM DUAL UNION ALL
  SELECT '정우성', 20, '영업', 250 FROM DUAL
)
SELECT CASE WHEN GROUPING(DEPT_NO) = 1 THEN '총계' ELSE TO_CHAR(DEPT_NO) END AS DEPT,
       CASE WHEN GROUPING(DEPT_NO) = 1 THEN NULL
            WHEN GROUPING(JOB) = 1 THEN '소계'
            ELSE JOB END AS JOB_NM,
       COUNT(*) AS CNT,
       SUM(SAL) AS SAL_SUM
  FROM EMP
 GROUP BY ROLLUP(DEPT_NO, JOB)
 ORDER BY GROUPING(DEPT_NO), DEPT_NO, GROUPING(JOB), JOB
```
