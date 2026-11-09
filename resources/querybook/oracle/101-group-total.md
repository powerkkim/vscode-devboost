---
title: 부서별 사원 월급과 그 부서의 월급 합계
category: 집계·분석
db: oracle
tags: 분석함수, SUM OVER, PARTITION BY, 그룹 합계, 비율, 부서합계
---
## 상황
사원 목록은 한 줄씩 그대로 보면서, 각 사원 옆에 **그 사원이 속한 부서의 월급 합계**와 부서 안에서 차지하는 비율도 보고 싶다.
`GROUP BY` 로 합계를 내면 부서마다 한 줄로 줄어 사원 행이 사라진다. 사원 행은 두고 옆에 합계만 붙이는 방법이 필요하다.

## 예제 테이블
EMP (사원)

| EMP_NO | EMP_NAME | DEPT_NO | SAL |
|---:|---|---:|---:|
| 1 | 김철수 | 10 | 300 |
| 2 | 이영희 | 10 | 200 |
| 3 | 박민수 | 20 | 400 |
| 4 | 최지은 | 20 | 350 |
| 5 | 정우성 | 20 | 250 |

## 원하는 결과
| DEPT_NO | EMP_NAME | SAL | GROUP_SUM | GROUP_PCT |
|---:|---|---:|---:|---:|
| 10 | 김철수 | 300 | 500 | 60 |
| 10 | 이영희 | 200 | 500 | 40 |
| 20 | 박민수 | 400 | 1000 | 40 |
| 20 | 최지은 | 350 | 1000 | 35 |
| 20 | 정우성 | 250 | 1000 | 25 |

## 쿼리
```sql
SELECT ${묶는칸:DEPT_NO}, ${이름칸:EMP_NAME}, ${값칸:SAL},
       SUM(${값칸}) OVER (PARTITION BY ${묶는칸}) AS GROUP_SUM,
       ROUND(${값칸} / NULLIF(SUM(${값칸}) OVER (PARTITION BY ${묶는칸}), 0) * 100, 1) AS GROUP_PCT
  FROM ${테이블:EMP}
 ORDER BY ${묶는칸}, ${값칸} DESC
```

## 풀이
- `SUM(SAL) OVER (...)` 는 **행을 줄이지 않고** 계산한 값만 각 행 옆에 붙인다. 이것이 `GROUP BY` 와 다른 점이다.
- `PARTITION BY DEPT_NO` = 같은 부서끼리 묶어서 계산하라는 뜻. 빼면(`OVER ()`) 전체 합계가 붙는다.
- 비율 = 내 값 ÷ 부서 합계 × 100. 합계가 0 이면 나누기 오류가 나므로 `NULLIF(…, 0)` 로 막았다.
- `SUM` 대신 `AVG`·`COUNT`·`MAX` 를 쓰면 부서 평균·인원 수·최고값이 붙는다.

## 바꿔 쓸 곳
- 응용: 품목별 소요량 옆에 상위 품목 합계, 월별 매출 옆에 연간 합계, 주문 줄 옆에 주문 전체 금액

## 연습 실행
```sql
WITH EMP AS (
  SELECT 1 AS EMP_NO, '김철수' AS EMP_NAME, 10 AS DEPT_NO, 300 AS SAL FROM DUAL UNION ALL
  SELECT 2, '이영희', 10, 200 FROM DUAL UNION ALL
  SELECT 3, '박민수', 20, 400 FROM DUAL UNION ALL
  SELECT 4, '최지은', 20, 350 FROM DUAL UNION ALL
  SELECT 5, '정우성', 20, 250 FROM DUAL
)
SELECT DEPT_NO, EMP_NAME, SAL,
       SUM(SAL) OVER (PARTITION BY DEPT_NO) AS GROUP_SUM,
       ROUND(SAL / NULLIF(SUM(SAL) OVER (PARTITION BY DEPT_NO), 0) * 100, 1) AS GROUP_PCT
  FROM EMP
 ORDER BY DEPT_NO, SAL DESC
```
