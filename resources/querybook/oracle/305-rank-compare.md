---
title: 순위 매기기 3가지 비교 (ROW_NUMBER, RANK, DENSE_RANK)
category: 순위·최신값
db: oracle
tags: RANK, DENSE_RANK, ROW_NUMBER, 순위, 동점, 등수
---
## 상황
점수 순으로 등수를 매기는데 **동점자 처리**가 헷갈린다. 세 함수가 어떻게 다른지 한 번에 보고 골라 쓰고 싶다.

## 예제 테이블
SCORE (점수)

| NAME | SCORE |
|---|---:|
| 김철수 | 90 |
| 이영희 | 85 |
| 박민수 | 85 |
| 최지은 | 70 |

## 원하는 결과
| NAME | SCORE | ROW_NUM | RANK_NO | DENSE_NO |
|---|---:|---:|---:|---:|
| 김철수 | 90 | 1 | 1 | 1 |
| 박민수 | 85 | 2 | 2 | 2 |
| 이영희 | 85 | 3 | 2 | 2 |
| 최지은 | 70 | 4 | 4 | 3 |

## 쿼리
```sql
SELECT ${이름칸:NAME}, ${값칸:SCORE},
       ROW_NUMBER() OVER (ORDER BY ${값칸} DESC, ${이름칸}) AS ROW_NUM,
       RANK()       OVER (ORDER BY ${값칸} DESC) AS RANK_NO,
       DENSE_RANK() OVER (ORDER BY ${값칸} DESC) AS DENSE_NO
  FROM ${테이블:SCORE}
 ORDER BY ROW_NUM
```

## 풀이
- `ROW_NUMBER` — 동점이어도 1, 2, 3, 4 처럼 **겹치지 않는 번호**. 동점끼리 순서는 정해 주지 않으면 실행할 때마다 바뀔 수 있어 `이름` 을 두 번째 정렬로 줬다. 페이지 나누기·하나만 고르기에.
- `RANK` — 동점은 같은 등수, **다음 등수는 건너뜀** (1, 2, 2, 4). 올림픽 메달 방식.
- `DENSE_RANK` — 동점은 같은 등수, **건너뛰지 않음** (1, 2, 2, 3). "상위 3개 점수대" 같은 질문에.
- 그룹(부서)별 등수는 `OVER (PARTITION BY 부서 ORDER BY …)`.

## 연습 실행
```sql
WITH SCORE AS (
  SELECT '김철수' AS NAME, 90 AS SCORE FROM DUAL UNION ALL
  SELECT '이영희', 85 FROM DUAL UNION ALL
  SELECT '박민수', 85 FROM DUAL UNION ALL
  SELECT '최지은', 70 FROM DUAL
)
SELECT NAME, SCORE,
       ROW_NUMBER() OVER (ORDER BY SCORE DESC, NAME) AS ROW_NUM,
       RANK() OVER (ORDER BY SCORE DESC) AS RANK_NO,
       DENSE_RANK() OVER (ORDER BY SCORE DESC) AS DENSE_NO
  FROM SCORE
 ORDER BY ROW_NUM
```
