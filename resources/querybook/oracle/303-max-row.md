---
title: 그룹에서 최댓값을 가진 행 전체 (동점 모두, MAX OVER)
category: 순위·최신값
db: oracle
tags: MAX, MAX OVER, 최댓값 행, 최고, 최저, 동점, 그룹별 1등
---
## 상황
부서마다 **월급이 가장 많은 사원의 모든 정보**를 보고 싶다. `SELECT DEPT_NO, MAX(SAL)` 로는 금액만 나오고 누구인지가 안 나온다. 같은 최고액이 두 명이면 둘 다.

## 예제 테이블
EMP (사원)

| EMP_NAME | DEPT_NO | SAL |
|---|---:|---:|
| 김철수 | 10 | 300 |
| 이영희 | 10 | 200 |
| 박민수 | 20 | 400 |
| 최지은 | 20 | 400 |
| 정우성 | 20 | 250 |

## 원하는 결과
| EMP_NAME | DEPT_NO | SAL | MAX_SAL |
|---|---:|---:|---:|
| 김철수 | 10 | 300 | 300 |
| 박민수 | 20 | 400 | 400 |
| 최지은 | 20 | 400 | 400 |

## 쿼리
```sql
SELECT *
  FROM (SELECT t.*,
               MAX(${값칸:SAL}) OVER (PARTITION BY ${묶는칸:DEPT_NO}) AS MAX_SAL
          FROM ${테이블:EMP} t)
 WHERE ${값칸} = MAX_SAL
 ORDER BY ${묶는칸}
```

## 풀이
- 안쪽에서 각 행 옆에 그 부서의 최댓값을 붙이고(`MAX … OVER (PARTITION BY …)`), 바깥에서 **내 값 = 최댓값** 인 행만 남긴다.
- 동점이 모두 나온다. 하나만 원하면 「그룹별 상위 N건」 의 ROW_NUMBER 로 (`RN = 1`).
- 최솟값이면 `MIN`. 날짜 칸에 쓰면 그룹별 최신 행 (동점 포함).
- 예전 방식 `WHERE (DEPT_NO, SAL) IN (SELECT DEPT_NO, MAX(SAL) FROM EMP GROUP BY DEPT_NO)` 도 같은 결과지만 테이블을 두 번 읽는다.

## 연습 실행
```sql
WITH EMP AS (
  SELECT '김철수' AS EMP_NAME, 10 AS DEPT_NO, 300 AS SAL FROM DUAL UNION ALL
  SELECT '이영희', 10, 200 FROM DUAL UNION ALL
  SELECT '박민수', 20, 400 FROM DUAL UNION ALL
  SELECT '최지은', 20, 400 FROM DUAL UNION ALL
  SELECT '정우성', 20, 250 FROM DUAL
)
SELECT *
  FROM (SELECT t.*, MAX(SAL) OVER (PARTITION BY DEPT_NO) AS MAX_SAL FROM EMP t)
 WHERE SAL = MAX_SAL
 ORDER BY DEPT_NO, EMP_NAME
```
