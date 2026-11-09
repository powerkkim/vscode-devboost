---
title: 상태별 건수를 칸으로 펼치기 (조건부 집계, PIVOT)
category: 집계·분석
db: oracle
tags: 조건부 집계, SUM CASE, COUNT CASE, PIVOT, 행을 열로, 상태별, 현황표
---
## 상황
팀별 요청 건수를 **접수·진행·완료 상태별로 한 줄에** 보고 싶다. 대시보드의 현황표(행 = 팀, 칸 = 상태)다.
GROUP BY 팀, 상태 로 하면 팀마다 여러 줄로 나와 한눈에 보기 어렵다.

## 예제 테이블
REQ (요청)

| REQ_NO | TEAM | STATUS |
|---:|---|---|
| 1 | 설계팀 | 접수 |
| 2 | 설계팀 | 진행 |
| 3 | 설계팀 | 완료 |
| 4 | 설계팀 | 완료 |
| 5 | 생산팀 | 접수 |
| 6 | 생산팀 | 완료 |

## 원하는 결과
| TEAM | TOTAL | RECEIVED | IN_PROGRESS | DONE | DONE_PCT |
|---|---:|---:|---:|---:|---:|
| 설계팀 | 4 | 1 | 1 | 2 | 50 |
| 생산팀 | 2 | 1 | 0 | 1 | 50 |

## 쿼리
```sql
SELECT ${묶는칸:TEAM},
       COUNT(*) AS TOTAL,
       COUNT(CASE WHEN ${상태칸:STATUS} = '${상태1:접수}' THEN 1 END) AS RECEIVED,
       COUNT(CASE WHEN ${상태칸} = '${상태2:진행}' THEN 1 END) AS IN_PROGRESS,
       COUNT(CASE WHEN ${상태칸} = '${상태3:완료}' THEN 1 END) AS DONE,
       ROUND(COUNT(CASE WHEN ${상태칸} = '${상태3}' THEN 1 END) / COUNT(*) * 100, 1) AS DONE_PCT
  FROM ${테이블:REQ}
 GROUP BY ${묶는칸}
 ORDER BY TOTAL DESC
```

## 풀이
- `COUNT(CASE WHEN 조건 THEN 1 END)` = 조건에 맞는 행만 센다 (맞지 않으면 NULL 이 되어 COUNT 에서 빠진다).
- 금액 합계는 `SUM(CASE WHEN 상태 = '완료' THEN AMT ELSE 0 END)`.
- 상태가 늘어나면 칸을 한 줄씩 더한다. 이 방법은 어느 DB 에서나 되고, 칸마다 다른 조건(기간·금액 등)도 섞을 수 있다.
- Oracle 의 `PIVOT` 으로도 같은 결과를 낼 수 있다:

```sql
SELECT *
  FROM (SELECT TEAM, STATUS FROM REQ)
 PIVOT (COUNT(*) FOR STATUS IN ('접수' AS RECEIVED, '진행' AS IN_PROGRESS, '완료' AS DONE))
```
- PIVOT 은 IN 목록에 값을 미리 적어야 한다 (상태가 바뀌면 쿼리도 바꿔야 함).

## 연습 실행
```sql
WITH REQ AS (
  SELECT 1 AS REQ_NO, '설계팀' AS TEAM, '접수' AS STATUS FROM DUAL UNION ALL
  SELECT 2, '설계팀', '진행' FROM DUAL UNION ALL
  SELECT 3, '설계팀', '완료' FROM DUAL UNION ALL
  SELECT 4, '설계팀', '완료' FROM DUAL UNION ALL
  SELECT 5, '생산팀', '접수' FROM DUAL UNION ALL
  SELECT 6, '생산팀', '완료' FROM DUAL
)
SELECT TEAM,
       COUNT(*) AS TOTAL,
       COUNT(CASE WHEN STATUS = '접수' THEN 1 END) AS RECEIVED,
       COUNT(CASE WHEN STATUS = '진행' THEN 1 END) AS IN_PROGRESS,
       COUNT(CASE WHEN STATUS = '완료' THEN 1 END) AS DONE,
       ROUND(COUNT(CASE WHEN STATUS = '완료' THEN 1 END) / COUNT(*) * 100, 1) AS DONE_PCT
  FROM REQ
 GROUP BY TEAM
 ORDER BY TOTAL DESC
```
