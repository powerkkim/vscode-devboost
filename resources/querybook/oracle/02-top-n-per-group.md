---
title: 그룹별 상위 N건 (부서마다 월급 많은 2명)
category: 집계·분석
db: oracle
tags: ROW_NUMBER, RANK, 순위, TOP N, 그룹별 최신, 상위
---
## 상황
부서마다 월급이 가장 많은 사원 2명씩만 보고 싶다. 전체에서 상위 2명이 아니라 **그룹(부서)마다** 상위 2명이다.
같은 방식으로 "품목마다 가장 최근 변경 이력 1건", "고객마다 마지막 주문 1건" 도 뽑는다.

## 예제 테이블
EMP (사원)

| EMP_NAME | DEPT_NO | SAL |
|---|---:|---:|
| 김철수 | 10 | 300 |
| 이영희 | 10 | 200 |
| 한가람 | 10 | 150 |
| 박민수 | 20 | 400 |
| 최지은 | 20 | 350 |
| 정우성 | 20 | 250 |

## 원하는 결과
| DEPT_NO | EMP_NAME | SAL | RN |
|---:|---|---:|---:|
| 10 | 김철수 | 300 | 1 |
| 10 | 이영희 | 200 | 2 |
| 20 | 박민수 | 400 | 1 |
| 20 | 최지은 | 350 | 2 |

## 쿼리
```sql
SELECT *
  FROM (SELECT t.*,
               ROW_NUMBER() OVER (PARTITION BY ${묶는칸:DEPT_NO} ORDER BY ${순서칸:SAL DESC}) AS RN
          FROM ${테이블:EMP} t)
 WHERE RN <= ${몇건:2}
 ORDER BY ${묶는칸}, RN
```

## 풀이
- 안쪽 쿼리에서 부서마다 1, 2, 3… 번호(`RN`)를 매기고, 바깥에서 `RN <= 2` 만 남긴다.
- `PARTITION BY` = 번호를 다시 1부터 시작하는 단위, `ORDER BY` = 번호를 매기는 순서.
- 같은 값이 있을 때: `ROW_NUMBER` 는 무조건 1, 2, 3 (하나만 고름), `RANK` 는 1, 1, 3, `DENSE_RANK` 는 1, 1, 2. 동점을 모두 보고 싶으면 `RANK`.
- 분석함수는 `WHERE` 에 바로 쓸 수 없어서 한 번 감싼다 (안쪽에서 계산 → 바깥에서 거르기).
- "그룹별 최신 1건" 은 `ORDER BY 변경일시 DESC` 로 두고 `RN = 1`.

## 바꿔 쓸 곳
- 순서칸 자리에 `SAL DESC, EMP_NAME` 처럼 여러 칸을 써서 동점일 때 순서를 정할 수 있다

## 연습 실행
```sql
WITH EMP AS (
  SELECT '김철수' AS EMP_NAME, 10 AS DEPT_NO, 300 AS SAL FROM DUAL UNION ALL
  SELECT '이영희', 10, 200 FROM DUAL UNION ALL
  SELECT '한가람', 10, 150 FROM DUAL UNION ALL
  SELECT '박민수', 20, 400 FROM DUAL UNION ALL
  SELECT '최지은', 20, 350 FROM DUAL UNION ALL
  SELECT '정우성', 20, 250 FROM DUAL
)
SELECT DEPT_NO, EMP_NAME, SAL, RN
  FROM (SELECT t.*,
               ROW_NUMBER() OVER (PARTITION BY DEPT_NO ORDER BY SAL DESC) AS RN
          FROM EMP t)
 WHERE RN <= 2
 ORDER BY DEPT_NO, RN
```
