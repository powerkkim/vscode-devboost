---
title: 여러 행을 한 줄로 합치기 (부서마다 사원 이름을 쉼표로)
category: 집계·분석
db: oracle
tags: LISTAGG, 문자열 합치기, 쉼표, 한 줄로, 행을 열로
---
## 상황
부서마다 사원이 여러 줄로 나오는데, **부서 한 줄에 사원 이름을 "김철수, 이영희" 처럼 이어 붙여** 보고 싶다.
품목의 자품목 목록, 사용자의 권한 목록을 한 칸에 보여 줄 때도 같다.

## 예제 테이블
EMP (사원)

| EMP_NAME | DEPT_NO |
|---|---:|
| 이영희 | 10 |
| 김철수 | 10 |
| 최지은 | 20 |
| 박민수 | 20 |
| 정우성 | 20 |

## 원하는 결과
| DEPT_NO | NAMES | CNT |
|---:|---|---:|
| 10 | 김철수, 이영희 | 2 |
| 20 | 박민수, 정우성, 최지은 | 3 |

## 쿼리
```sql
SELECT ${묶는칸:DEPT_NO},
       LISTAGG(${합칠칸:EMP_NAME}, ', ') WITHIN GROUP (ORDER BY ${합칠칸}) AS NAMES,
       COUNT(*) AS CNT
  FROM ${테이블:EMP}
 GROUP BY ${묶는칸}
 ORDER BY ${묶는칸}
```

## 풀이
- `LISTAGG(칸, 구분자)` 가 묶은 행들의 값을 이어 붙인다. `WITHIN GROUP (ORDER BY …)` 는 붙이는 순서.
- 결과가 4000바이트(설정에 따라 32767)를 넘으면 오류가 난다. 12.2 이상이면 `LISTAGG(칸, ', ' ON OVERFLOW TRUNCATE '…')` 로 잘라서 끝에 … 를 붙일 수 있다.
- 같은 값이 여러 번 나오면 그대로 반복된다. 19c 이상이면 `LISTAGG(DISTINCT 칸, ', ')` 로 한 번씩만.
- 11g R2 미만 버전에는 `LISTAGG` 가 없다.

## 연습 실행
```sql
WITH EMP AS (
  SELECT '이영희' AS EMP_NAME, 10 AS DEPT_NO FROM DUAL UNION ALL
  SELECT '김철수', 10 FROM DUAL UNION ALL
  SELECT '최지은', 20 FROM DUAL UNION ALL
  SELECT '박민수', 20 FROM DUAL UNION ALL
  SELECT '정우성', 20 FROM DUAL
)
SELECT DEPT_NO,
       LISTAGG(EMP_NAME, ', ') WITHIN GROUP (ORDER BY EMP_NAME) AS NAMES,
       COUNT(*) AS CNT
  FROM EMP
 GROUP BY DEPT_NO
 ORDER BY DEPT_NO
```
