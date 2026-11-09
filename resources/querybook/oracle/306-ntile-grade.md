---
title: N등분 등급과 상위 몇 % (NTILE, PERCENT_RANK)
category: 순위·최신값
db: oracle
tags: NTILE, PERCENT_RANK, 등급, 상위 퍼센트, 분위, 사분위, 고객 등급
---
## 상황
고객을 구매액 순으로 **4등급(상위 25%씩)** 으로 나누고, 각 고객이 **상위 몇 %** 인지도 보고 싶다. VIP 선정, 사분위 분석에 쓴다.

## 예제 테이블
CUST_SALES (고객별 구매액)

| CUST | AMT |
|---|---:|
| C1 | 800 |
| C2 | 700 |
| C3 | 600 |
| C4 | 500 |
| C5 | 400 |
| C6 | 300 |
| C7 | 200 |
| C8 | 100 |

## 원하는 결과
| CUST | AMT | GRADE | TOP_PCT |
|---|---:|---:|---:|
| C1 | 800 | 1 | 0 |
| C2 | 700 | 1 | 14.3 |
| C3 | 600 | 2 | 28.6 |
| C4 | 500 | 2 | 42.9 |
| C5 | 400 | 3 | 57.1 |
| C6 | 300 | 3 | 71.4 |
| C7 | 200 | 4 | 85.7 |
| C8 | 100 | 4 | 100 |

## 쿼리
```sql
SELECT ${이름칸:CUST}, ${값칸:AMT},
       NTILE(${몇등분:4}) OVER (ORDER BY ${값칸} DESC) AS GRADE,
       ROUND(PERCENT_RANK() OVER (ORDER BY ${값칸} DESC) * 100, 1) AS TOP_PCT
  FROM ${테이블:CUST_SALES}
 ORDER BY ${값칸} DESC
```

## 풀이
- `NTILE(4)` = 순서대로 세운 뒤 줄 수를 4 묶음으로 똑같이 나눠 1~4 번호를 준다. 나누어떨어지지 않으면 앞 묶음이 한 줄씩 더 많다. **금액 경계가 아니라 줄 수 기준**이라, 동점이 다른 등급으로 갈릴 수 있다.
- `PERCENT_RANK()` = (내 순위 − 1) ÷ (전체 줄 수 − 1). 1등은 0%, 꼴찌는 100%. "상위 10% 안" 은 `TOP_PCT <= 10`.
- 금액 구간으로 등급을 나누려면 「누적 비율로 A·B·C 등급」 이나 CASE 를 쓴다.

## 연습 실행
```sql
WITH CUST_SALES AS (
  SELECT 'C1' AS CUST, 800 AS AMT FROM DUAL UNION ALL
  SELECT 'C2', 700 FROM DUAL UNION ALL
  SELECT 'C3', 600 FROM DUAL UNION ALL
  SELECT 'C4', 500 FROM DUAL UNION ALL
  SELECT 'C5', 400 FROM DUAL UNION ALL
  SELECT 'C6', 300 FROM DUAL UNION ALL
  SELECT 'C7', 200 FROM DUAL UNION ALL
  SELECT 'C8', 100 FROM DUAL
)
SELECT CUST, AMT,
       NTILE(4) OVER (ORDER BY AMT DESC) AS GRADE,
       ROUND(PERCENT_RANK() OVER (ORDER BY AMT DESC) * 100, 1) AS TOP_PCT
  FROM CUST_SALES
 ORDER BY AMT DESC
```
