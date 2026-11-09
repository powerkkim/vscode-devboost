---
title: 전체 대비 비율 (구성비, 점유율)
category: 집계·분석
db: oracle
tags: RATIO_TO_REPORT, 비율, 구성비, 점유율, 퍼센트, 파이 차트
---
## 상황
분류별 매출 합계와 함께 **전체 매출에서 각 분류가 차지하는 비율(%)** 을 보고 싶다. 대시보드의 파이 차트·구성비 표에 쓰는 숫자다.

## 예제 테이블
SALES (판매)

| CATEGORY | AMT |
|---|---:|
| 볼트 | 300 |
| 볼트 | 200 |
| 너트 | 300 |
| 와셔 | 200 |

## 원하는 결과
| CATEGORY | AMT | PCT |
|---|---:|---:|
| 볼트 | 500 | 50 |
| 너트 | 300 | 30 |
| 와셔 | 200 | 20 |

## 쿼리
```sql
SELECT ${분류칸:CATEGORY},
       SUM(${값칸:AMT}) AS AMT,
       ROUND(RATIO_TO_REPORT(SUM(${값칸})) OVER () * 100, 1) AS PCT
  FROM ${테이블:SALES}
 GROUP BY ${분류칸}
 ORDER BY AMT DESC
```

## 풀이
- `RATIO_TO_REPORT(값) OVER ()` = 내 값 ÷ 전체 합. 0.5 처럼 나오므로 100 을 곱해 %.
- `GROUP BY` 로 분류별 합계를 먼저 내고, 그 합계들끼리 비율을 낸다 (집계 위에 분석함수를 쓸 수 있다).
- 그룹 안에서의 비율(예: 연도별 안에서 분류 비율)은 `OVER (PARTITION BY 연도)`.
- 같은 결과를 `SUM(AMT) / SUM(SUM(AMT)) OVER ()` 로도 쓸 수 있다 (다른 DB 로 옮길 때).
- 반올림 때문에 비율 합이 99.9·100.1 이 될 수 있다.

## 연습 실행
```sql
WITH SALES AS (
  SELECT '볼트' AS CATEGORY, 300 AS AMT FROM DUAL UNION ALL
  SELECT '볼트', 200 FROM DUAL UNION ALL
  SELECT '너트', 300 FROM DUAL UNION ALL
  SELECT '와셔', 200 FROM DUAL
)
SELECT CATEGORY,
       SUM(AMT) AS AMT,
       ROUND(RATIO_TO_REPORT(SUM(AMT)) OVER () * 100, 1) AS PCT
  FROM SALES
 GROUP BY CATEGORY
 ORDER BY AMT DESC
```
