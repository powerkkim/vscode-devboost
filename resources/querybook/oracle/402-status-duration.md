---
title: 상태마다 머문 기간 (다음 상태까지 며칠, LEAD)
category: 날짜·기간
db: oracle
tags: LEAD, 머문 기간, 처리 기간, 리드타임, 소요일, 상태 이력, 병목
---
## 상황
문서 상태 이력에서 **각 상태에 며칠 머물렀는지**(다음 상태로 넘어가기까지 걸린 날)를 보고 싶다. 어느 단계에서 오래 걸리는지(병목) 찾을 때 쓴다.

## 예제 테이블
DOC_HIST (문서 상태 이력)

| DOC_NO | STATUS | CHG_DT |
|---|---|---|
| D1 | 작성 | 2026-11-01 |
| D1 | 검토 | 2026-11-03 |
| D1 | 승인 | 2026-11-06 |
| D2 | 작성 | 2026-11-02 |

## 원하는 결과
| DOC_NO | STATUS | CHG_DT | NEXT_STATUS | NEXT_DT | DAYS |
|---|---|---|---|---|---:|
| D1 | 작성 | 2026-11-01 | 검토 | 2026-11-03 | 2 |
| D1 | 검토 | 2026-11-03 | 승인 | 2026-11-06 | 3 |
| D1 | 승인 | 2026-11-06 |  |  |  |
| D2 | 작성 | 2026-11-02 |  |  |  |

## 쿼리
```sql
SELECT ${묶는칸:DOC_NO}, ${값칸:STATUS}, ${순서칸:CHG_DT},
       LEAD(${값칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}) AS NEXT_STATUS,
       LEAD(${순서칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}) AS NEXT_DT,
       ROUND(LEAD(${순서칸}) OVER (PARTITION BY ${묶는칸} ORDER BY ${순서칸}) - ${순서칸}, 1) AS DAYS
  FROM ${테이블:DOC_HIST}
 ORDER BY ${묶는칸}, ${순서칸}
```

## 풀이
- `LEAD(일시) OVER (PARTITION BY 문서 ORDER BY 일시)` = 같은 문서의 **다음 줄 일시** = 이 상태가 끝난 때.
- DATE 끼리 빼면 일 수 (시각이 있으면 2.5 처럼 소수). 시간으로 보려면 `* 24`.
- 마지막 상태는 다음 줄이 없어 NULL. "지금까지 머문 기간" 을 보려면 `NVL(LEAD(일시) OVER (…), SYSDATE) - 일시`.
- 단계별 평균 소요일은 이 결과를 감싸서 `SELECT STATUS, ROUND(AVG(DAYS), 1) … GROUP BY STATUS`.
- 일시 칸이 TIMESTAMP 면 빼기 결과가 INTERVAL 이므로 `CAST(일시 AS DATE)` 로 바꿔 뺀다.

## 연습 실행
```sql
WITH DOC_HIST AS (
  SELECT 'D1' AS DOC_NO, '작성' AS STATUS, DATE '2026-11-01' AS CHG_DT FROM DUAL UNION ALL
  SELECT 'D1', '검토', DATE '2026-11-03' FROM DUAL UNION ALL
  SELECT 'D1', '승인', DATE '2026-11-06' FROM DUAL UNION ALL
  SELECT 'D2', '작성', DATE '2026-11-02' FROM DUAL
)
SELECT DOC_NO, STATUS, CHG_DT,
       LEAD(STATUS) OVER (PARTITION BY DOC_NO ORDER BY CHG_DT) AS NEXT_STATUS,
       LEAD(CHG_DT) OVER (PARTITION BY DOC_NO ORDER BY CHG_DT) AS NEXT_DT,
       ROUND(LEAD(CHG_DT) OVER (PARTITION BY DOC_NO ORDER BY CHG_DT) - CHG_DT, 1) AS DAYS
  FROM DOC_HIST
 ORDER BY DOC_NO, CHG_DT
```
