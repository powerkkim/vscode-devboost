---
title: 요일별·시간대별 건수 (언제 몰리나, 히트맵)
category: 대시보드 통계
db: oracle
tags: 요일, 시간대, 히트맵, TO_CHAR, HH24, 피크 시간, 접속 통계
---
## 상황
요청이 **무슨 요일 몇 시에 몰리는지** 보고 싶다. 대시보드의 요일 × 시간 히트맵, 배치 실행 시간 정하기에 쓴다.

## 예제 테이블
REQ (요청, 2026-11-02 은 월요일)

| REG_DT |
|---|
| 2026-11-02 09:10 |
| 2026-11-02 09:40 |
| 2026-11-02 14:00 |
| 2026-11-03 09:05 |

## 원하는 결과
| DOW_NO | DOW | HH | CNT |
|---:|---|---|---:|
| 1 | 월 | 09 | 2 |
| 1 | 월 | 14 | 1 |
| 2 | 화 | 09 | 1 |

## 쿼리
```sql
SELECT TRUNC(${일시칸:REG_DT}) - TRUNC(${일시칸}, 'IW') + 1 AS DOW_NO,
       TO_CHAR(${일시칸}, 'DY', 'NLS_DATE_LANGUAGE=KOREAN') AS DOW,
       TO_CHAR(${일시칸}, 'HH24') AS HH,
       COUNT(*) AS CNT
  FROM ${테이블:REQ}
 WHERE ${일시칸} >= TRUNC(SYSDATE) - ${며칠:28}
 GROUP BY TRUNC(${일시칸}) - TRUNC(${일시칸}, 'IW') + 1,
          TO_CHAR(${일시칸}, 'DY', 'NLS_DATE_LANGUAGE=KOREAN'),
          TO_CHAR(${일시칸}, 'HH24')
 ORDER BY DOW_NO, HH
```

## 풀이
- `TRUNC(일시, 'IW')` = 그 주의 월요일. 날짜에서 빼고 1 을 더하면 월=1 … 일=7 (DB 언어 설정과 관계없이 일정하다). `TO_CHAR(일시, 'D')` 는 설정(NLS_TERRITORY)에 따라 일요일이 1 이기도 해서 쓰지 않았다.
- `'DY', 'NLS_DATE_LANGUAGE=KOREAN'` = 요일 이름을 한글 한 글자로 (영문은 `AMERICAN` → MON).
- `HH24` = 0~23 시. 히트맵은 요일을 행, 시간을 칸으로 펼치면 된다 (「상태별 건수를 칸으로 펼치기」).
- 기간을 4주처럼 요일이 고르게 들어가게 잡는다.

## 연습 실행
```sql
WITH REQ AS (
  SELECT TO_DATE('2026-11-02 09:10', 'YYYY-MM-DD HH24:MI') AS REG_DT FROM DUAL UNION ALL
  SELECT TO_DATE('2026-11-02 09:40', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT TO_DATE('2026-11-02 14:00', 'YYYY-MM-DD HH24:MI') FROM DUAL UNION ALL
  SELECT TO_DATE('2026-11-03 09:05', 'YYYY-MM-DD HH24:MI') FROM DUAL
)
SELECT TRUNC(REG_DT) - TRUNC(REG_DT, 'IW') + 1 AS DOW_NO,
       TO_CHAR(REG_DT, 'DY', 'NLS_DATE_LANGUAGE=KOREAN') AS DOW,
       TO_CHAR(REG_DT, 'HH24') AS HH,
       COUNT(*) AS CNT
  FROM REQ
 GROUP BY TRUNC(REG_DT) - TRUNC(REG_DT, 'IW') + 1,
          TO_CHAR(REG_DT, 'DY', 'NLS_DATE_LANGUAGE=KOREAN'),
          TO_CHAR(REG_DT, 'HH24')
 ORDER BY DOW_NO, HH
```
