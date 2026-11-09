---
title: 평균 말고 중앙값·상위 90% 값 (MEDIAN, PERCENTILE_CONT)
category: 집계·분석
db: oracle
tags: MEDIAN, 중앙값, PERCENTILE_CONT, 백분위, P90, 평균, 처리시간
---
## 상황
부서별 월급 평균을 냈더니 한 사람의 큰 값 때문에 평균이 크게 올라갔다. **가운데 값(중앙값)과 상위 90% 지점 값**을 함께 보고 싶다.
응답시간·처리기간처럼 몇 건만 튀는 데이터를 대시보드에 보일 때 평균보다 정확하다.

## 예제 테이블
EMP (사원)

| EMP_NAME | DEPT_NO | SAL |
|---|---:|---:|
| 가 | 10 | 100 |
| 나 | 10 | 200 |
| 다 | 10 | 300 |
| 라 | 10 | 1000 |
| 마 | 20 | 200 |
| 바 | 20 | 300 |
| 사 | 20 | 400 |

## 원하는 결과
| DEPT_NO | CNT | AVG_SAL | MEDIAN_SAL | P90_SAL |
|---:|---:|---:|---:|---:|
| 10 | 4 | 400 | 250 | 790 |
| 20 | 3 | 300 | 300 | 380 |

## 쿼리
```sql
SELECT ${묶는칸:DEPT_NO},
       COUNT(*) AS CNT,
       ROUND(AVG(${값칸:SAL}), 1) AS AVG_SAL,
       MEDIAN(${값칸}) AS MEDIAN_SAL,
       PERCENTILE_CONT(${백분위:0.9}) WITHIN GROUP (ORDER BY ${값칸}) AS P90_SAL
  FROM ${테이블:EMP}
 GROUP BY ${묶는칸}
 ORDER BY ${묶는칸}
```

## 풀이
- 10 번 부서: 평균은 400 이지만 1000 하나 때문이고, 실제 가운데 값(중앙값)은 250 이다.
- `MEDIAN(값)` = 크기순으로 세웠을 때 가운데 값 (짝수 개면 가운데 두 값의 평균).
- `PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY 값)` = 아래에서 90% 지점의 값. 두 값 사이면 비율대로 사이 값을 계산한다 (10번: 300 과 1000 사이의 70% 지점 = 790). 실제 있는 값 중에서 고르려면 `PERCENTILE_DISC`.
- 0.5 를 넣으면 MEDIAN 과 같다. 응답시간 대시보드는 보통 P50·P90·P99 를 함께 본다.

## 연습 실행
```sql
WITH EMP AS (
  SELECT '가' AS EMP_NAME, 10 AS DEPT_NO, 100 AS SAL FROM DUAL UNION ALL
  SELECT '나', 10, 200 FROM DUAL UNION ALL
  SELECT '다', 10, 300 FROM DUAL UNION ALL
  SELECT '라', 10, 1000 FROM DUAL UNION ALL
  SELECT '마', 20, 200 FROM DUAL UNION ALL
  SELECT '바', 20, 300 FROM DUAL UNION ALL
  SELECT '사', 20, 400 FROM DUAL
)
SELECT DEPT_NO,
       COUNT(*) AS CNT,
       ROUND(AVG(SAL), 1) AS AVG_SAL,
       MEDIAN(SAL) AS MEDIAN_SAL,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY SAL) AS P90_SAL
  FROM EMP
 GROUP BY DEPT_NO
 ORDER BY DEPT_NO
```
