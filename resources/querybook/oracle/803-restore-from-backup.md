---
title: 백업 테이블 값으로 되돌리기 (+ 과거 시점 조회 FLASHBACK)
category: 데이터 바꾸기
db: oracle
tags: 복구, 되돌리기, 원복, 롤백, MERGE, FLASHBACK, AS OF, 실수
---
## 상황
일괄 수정을 했는데 잘못됐다. 이미 커밋해서 롤백도 안 된다. 미리 떠 둔 **백업 테이블의 값으로 원래대로 되돌리고** 싶다.
백업이 없어도 얼마 지나지 않았으면 Oracle 이 보관한 과거 시점 데이터(FLASHBACK)로 확인·복구할 수 있다.

## 예제 테이블
TB_PART (잘못 고쳐진 지금)

| PART_NO | PART_NM |
|---|---|
| P001 | 수정됨 |
| P002 | 수정됨 |

TB_PART_BK (백업, 같은 품목이 여러 번 백업돼 있을 수 있다)

| PART_NO | PART_NM | BK_DT |
|---|---|---|
| P001 | 볼트 | 2026-11-09 14:30:00 |
| P002 | 너트 | 2026-11-09 14:30:00 |

## 원하는 결과
TB_PART

| PART_NO | PART_NM |
|---|---|
| P001 | 볼트 |
| P002 | 너트 |

## 쿼리
```sql
MERGE INTO ${테이블:TB_PART} t
USING (SELECT *
         FROM (SELECT b.*, ROW_NUMBER() OVER (PARTITION BY b.${키칸:PART_NO} ORDER BY b.BK_DT DESC) AS RN
                 FROM ${백업테이블:TB_PART_BK} b)
        WHERE RN = 1) b
   ON (t.${키칸} = b.${키칸})
 WHEN MATCHED THEN
      UPDATE SET t.${되돌릴칸:PART_NM} = b.${되돌릴칸}
```

## 풀이
- 백업에 같은 품목이 여러 번 있으면 MERGE 가 ORA-30926 오류를 낸다. 그래서 `ROW_NUMBER … ORDER BY BK_DT DESC` 로 **품목마다 가장 최근 백업 1건**만 골랐다.
- `WHEN MATCHED THEN UPDATE` 만 썼으므로 지금 테이블에 있는 행만 되돌린다. 지워진 행까지 살리려면 `WHEN NOT MATCHED THEN INSERT (…) VALUES (…)` 를 더한다.
- 되돌릴 칸이 여러 개면 `UPDATE SET t.A = b.A, t.B = b.B`. 키가 여러 칸이면 ON 에 `AND` 로 잇는다.
- 실행 전에 같은 USING 으로 SELECT 해서 되돌릴 값을 눈으로 확인하고, 실행 뒤 확인하고 커밋한다.
- **백업이 없을 때 — 과거 시점 조회**: 보관 기간(보통 몇십 분~몇 시간, UNDO 설정에 따름) 안이면 이렇게 볼 수 있다.

```sql
SELECT * FROM TB_PART AS OF TIMESTAMP (SYSTIMESTAMP - INTERVAL '30' MINUTE)
 WHERE PART_NO IN ('P001', 'P002')
```
- 위 결과가 맞으면 USING 자리에 그 SELECT 를 넣어 같은 MERGE 로 되돌린다. 오래 지나 ORA-01555(스냅샷이 너무 오래됨)가 나면 DBA 에게 요청한다.
- 데이터를 바꾸는 문장이라 연습 실행은 없다.
