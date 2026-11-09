---
title: 이동 평균 (최근 N일 평균으로 추이 부드럽게)
category: 대시보드 통계
db: oracle
tags: 이동 평균, AVG OVER, ROWS BETWEEN, 추세, 평활, 7일 평균
---
## 상황
일별 실적이 들쭉날쭉해서 추세가 안 보인다. **각 날짜에 "최근 3일 평균"** 을 붙여 부드러운 선으로 보고 싶다 (보통 7일 이동 평균).

## 예제 테이블
DAILY (일별 실적 — 날짜마다 한 줄)

| DAY | AMT |
|---|---:|
| 2026-11-01 | 100 |
| 2026-11-02 | 200 |
| 2026-11-03 | 300 |
| 2026-11-04 | 400 |

## 원하는 결과
| DAY | AMT | MA3 |
|---|---:|---:|
| 2026-11-01 | 100 | 100 |
| 2026-11-02 | 200 | 150 |
| 2026-11-03 | 300 | 200 |
| 2026-11-04 | 400 | 300 |

## 쿼리
```sql
SELECT ${날짜칸:DAY}, ${값칸:AMT},
       ROUND(AVG(${값칸}) OVER (ORDER BY ${날짜칸} ROWS BETWEEN ${앞줄수:2} PRECEDING AND CURRENT ROW), 1) AS MA3
  FROM ${테이블:DAILY}
 ORDER BY ${날짜칸}
```

## 풀이
- `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW` = 앞의 2줄 + 나 = 3줄의 평균. 7일 이동 평균은 6.
- 처음 며칠은 앞 줄이 모자라 있는 줄만으로 평균을 낸다 (11-01 은 자기 하나).
- **줄 기준**이라 날짜가 빠져 있으면 "최근 3줄" 이 3일보다 길어진다. 날짜 기준으로 하려면 `RANGE BETWEEN 2 PRECEDING AND CURRENT ROW` (날짜 칸이 DATE 일 때 2 = 2일) 또는 「빠진 날짜 채우기」 로 먼저 날짜를 채운다.
- 원본이 주문 단위면 먼저 일별로 합친 뒤(`TRUNC(일시)` GROUP BY) 이동 평균을 낸다.

## 연습 실행
```sql
WITH DAILY AS (
  SELECT DATE '2026-11-01' AS DAY, 100 AS AMT FROM DUAL UNION ALL
  SELECT DATE '2026-11-02', 200 FROM DUAL UNION ALL
  SELECT DATE '2026-11-03', 300 FROM DUAL UNION ALL
  SELECT DATE '2026-11-04', 400 FROM DUAL
)
SELECT DAY, AMT,
       ROUND(AVG(AMT) OVER (ORDER BY DAY ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 1) AS MA3
  FROM DAILY
 ORDER BY DAY
```
