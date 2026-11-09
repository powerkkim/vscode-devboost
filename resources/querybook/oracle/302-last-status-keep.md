---
title: 그룹별 마지막 값 한 줄로 (최종 상태, KEEP DENSE_RANK LAST)
category: 순위·최신값
db: oracle
tags: KEEP, DENSE_RANK LAST, FIRST, 최종 상태, 최신 값, 마지막 이력, 결재
---
## 상황
문서마다 상태 변경 이력이 여러 줄 쌓여 있다. **문서별로 "가장 마지막 상태" 와 그 일시, 변경 횟수**를 한 줄로 보고 싶다. 결재 현황판, 품목별 최종 단가 등.

## 예제 테이블
DOC_HIST (문서 상태 이력)

| DOC_NO | STATUS | CHG_DT |
|---|---|---|
| D1 | 작성 | 2026-11-01 |
| D1 | 검토 | 2026-11-03 |
| D1 | 승인 | 2026-11-05 |
| D2 | 작성 | 2026-11-02 |
| D2 | 반려 | 2026-11-04 |

## 원하는 결과
| DOC_NO | LAST_STATUS | LAST_DT | FIRST_STATUS | CHG_CNT |
|---|---|---|---|---:|
| D1 | 승인 | 2026-11-05 | 작성 | 3 |
| D2 | 반려 | 2026-11-04 | 작성 | 2 |

## 쿼리
```sql
SELECT ${묶는칸:DOC_NO},
       MAX(${값칸:STATUS}) KEEP (DENSE_RANK LAST ORDER BY ${순서칸:CHG_DT}) AS LAST_STATUS,
       MAX(${순서칸}) AS LAST_DT,
       MAX(${값칸}) KEEP (DENSE_RANK FIRST ORDER BY ${순서칸}) AS FIRST_STATUS,
       COUNT(*) AS CHG_CNT
  FROM ${테이블:DOC_HIST}
 GROUP BY ${묶는칸}
 ORDER BY ${묶는칸}
```

## 풀이
- `MAX(값) KEEP (DENSE_RANK LAST ORDER BY 일시)` = 일시 순으로 세웠을 때 **마지막 줄의 값**. `FIRST` 면 첫 줄의 값.
- GROUP BY 와 함께 쓰는 집계라서, 다른 집계(건수·최종일시)를 같은 줄에 바로 붙일 수 있다. 「그룹별 상위 N건」(ROW_NUMBER) 은 감싸는 쿼리가 하나 더 필요하다.
- 같은 일시에 두 줄이 있으면 그중 MAX 값이 나온다. 정확히 하나를 고르려면 `ORDER BY 일시, 이력번호` 처럼 순서를 더 준다.
- 여러 칸을 함께 가져오려면 칸마다 `KEEP` 을 반복한다. 칸이 많으면 ROW_NUMBER 방식이 깔끔하다.

## 연습 실행
```sql
WITH DOC_HIST AS (
  SELECT 'D1' AS DOC_NO, '작성' AS STATUS, DATE '2026-11-01' AS CHG_DT FROM DUAL UNION ALL
  SELECT 'D1', '검토', DATE '2026-11-03' FROM DUAL UNION ALL
  SELECT 'D1', '승인', DATE '2026-11-05' FROM DUAL UNION ALL
  SELECT 'D2', '작성', DATE '2026-11-02' FROM DUAL UNION ALL
  SELECT 'D2', '반려', DATE '2026-11-04' FROM DUAL
)
SELECT DOC_NO,
       MAX(STATUS) KEEP (DENSE_RANK LAST ORDER BY CHG_DT) AS LAST_STATUS,
       MAX(CHG_DT) AS LAST_DT,
       MAX(STATUS) KEEP (DENSE_RANK FIRST ORDER BY CHG_DT) AS FIRST_STATUS,
       COUNT(*) AS CHG_CNT
  FROM DOC_HIST
 GROUP BY DOC_NO
 ORDER BY DOC_NO
```
