---
title: 연속된 날짜 구간 묶기 (연속 접속일, 연속 가동일)
category: 날짜·기간
db: oracle
tags: 연속, 연속 일수, 구간, gaps and islands, ROW_NUMBER, 스트릭, 가동
---
## 상황
사용자 접속 기록에서 **며칠 연속으로 접속했는지** 구간별로 보고 싶다 (11-01 ~ 11-03 3일 연속, 11-05 ~ 11-06 2일 연속). 설비 연속 가동일, 연속 불량일 같은 것도 같은 방법이다.

## 예제 테이블
LOGINS (접속 기록 — 하루에 여러 번일 수 있다)

| USER_ID | LOGIN_DT |
|---|---|
| U1 | 2026-11-01 09:00 |
| U1 | 2026-11-01 18:00 |
| U1 | 2026-11-02 09:00 |
| U1 | 2026-11-03 09:00 |
| U1 | 2026-11-05 09:00 |
| U1 | 2026-11-06 09:00 |
| U2 | 2026-11-02 10:00 |

## 원하는 결과
| USER_ID | FROM_DAY | TO_DAY | DAYS |
|---|---|---|---:|
| U1 | 2026-11-01 | 2026-11-03 | 3 |
| U1 | 2026-11-05 | 2026-11-06 | 2 |
| U2 | 2026-11-02 | 2026-11-02 | 1 |

## 쿼리
```sql
SELECT ${묶는칸:USER_ID}, MIN(DAY) AS FROM_DAY, MAX(DAY) AS TO_DAY, COUNT(*) AS DAYS
  FROM (SELECT ${묶는칸}, DAY,
               DAY - ROW_NUMBER() OVER (PARTITION BY ${묶는칸} ORDER BY DAY) AS GRP
          FROM (SELECT DISTINCT ${묶는칸}, TRUNC(${일시칸:LOGIN_DT}) AS DAY
                  FROM ${테이블:LOGINS}))
 GROUP BY ${묶는칸}, GRP
 ORDER BY ${묶는칸}, FROM_DAY
```

## 풀이
- 하루에 여러 번이어도 하루로 세려고 먼저 `DISTINCT TRUNC(일시)`.
- 핵심: **날짜 − 순번**. 날짜가 하루씩 이어지면 순번도 하나씩 늘어서 빼면 같은 값이 된다 (11-01−1, 11-02−2, 11-03−3 → 모두 10-31). 하루라도 끊기면 값이 달라진다 (11-05−4 = 11-01).
- 그 값(`GRP`)으로 묶으면 연속 구간마다 한 줄 → 시작일·끝일·일수.
- 가장 긴 연속 기록만 보려면 바깥에서 `MAX(DAYS)` 또는 DAYS 로 정렬.
- 날짜가 아니라 번호(1, 2, 3, 5, 6)가 연속인지 볼 때도 `번호 − ROW_NUMBER()` 로 같다.

## 연습 실행
```sql
WITH LOGINS AS (
  SELECT 'U1' AS USER_ID, TO_DATE('2026-11-01 09:00', 'YYYY-MM-DD HH24:MI') AS LOGIN_DT FROM DUAL UNION ALL
  SELECT 'U1', TO_DATE('2026-11-01 18:00', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT 'U1', TO_DATE('2026-11-02 09:00', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT 'U1', TO_DATE('2026-11-03 09:00', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT 'U1', TO_DATE('2026-11-05 09:00', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT 'U1', TO_DATE('2026-11-06 09:00', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT 'U2', TO_DATE('2026-11-02 10:00', 'YYYY-MM-DD HH24:MI') FROM DUAL
)
SELECT USER_ID, MIN(DAY) AS FROM_DAY, MAX(DAY) AS TO_DAY, COUNT(*) AS DAYS
  FROM (SELECT USER_ID, DAY,
               DAY - ROW_NUMBER() OVER (PARTITION BY USER_ID ORDER BY DAY) AS GRP
          FROM (SELECT DISTINCT USER_ID, TRUNC(LOGIN_DT) AS DAY FROM LOGINS))
 GROUP BY USER_ID, GRP
 ORDER BY USER_ID, FROM_DAY
```
