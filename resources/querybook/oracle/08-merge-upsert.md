---
title: 있으면 UPDATE, 없으면 INSERT (MERGE)
category: 데이터 바꾸기
db: oracle
tags: MERGE, UPSERT, 있으면 수정, 없으면 등록, 동기화
---
## 상황
화면에서 저장 버튼을 누르면, 그 품목이 **이미 있으면 이름을 고치고, 없으면 새로 등록**해야 한다.
SELECT 로 있는지 확인한 뒤 UPDATE 또는 INSERT 를 고르는 대신 문장 하나로 처리하고 싶다. 다른 테이블의 데이터로 이 테이블을 맞출(동기화) 때도 쓴다.

## 예제 테이블
TB_PART (실행 전)

| PART_NO | PART_NM |
|---|---|
| P001 | 볼트 |

파라미터: `:part_no` = P001, `:part_nm` = 육각 볼트 → 있으므로 이름이 바뀜
파라미터: `:part_no` = P009, `:part_nm` = 와셔 → 없으므로 새로 들어감

## 원하는 결과
TB_PART (두 번 실행한 뒤)

| PART_NO | PART_NM |
|---|---|
| P001 | 육각 볼트 |
| P009 | 와셔 |

## 쿼리
```sql
MERGE INTO ${테이블:TB_PART} t
USING (SELECT :part_no AS PART_NO, :part_nm AS PART_NM FROM DUAL) s
   ON (t.${키칸:PART_NO} = s.${키칸})
 WHEN MATCHED THEN
      UPDATE SET t.PART_NM = s.PART_NM
 WHEN NOT MATCHED THEN
      INSERT (${키칸}, PART_NM) VALUES (s.${키칸}, s.PART_NM)
```

## 풀이
- `USING (…) s` = 넣을 값 (여기서는 파라미터 한 줄. 다른 테이블을 쓰면 여러 줄을 한꺼번에 맞춘다).
- `ON (…)` = 같은 행이라고 볼 조건 (보통 키). 맞는 행이 있으면 `WHEN MATCHED`, 없으면 `WHEN NOT MATCHED`.
- `ON` 에 쓴 칸은 `UPDATE SET` 에 쓸 수 없다 (ORA-38104).
- `USING` 쪽에 같은 키가 두 줄 이상이면 오류가 난다 (ORA-30926). 다른 테이블로 맞출 때는 키가 유일한지 먼저 확인.
- 데이터를 바꾸는 문장이라 연습 실행은 없다. 실행 뒤 결과를 확인하고 커밋한다.
- MyBatis 에서는 `:part_no` 자리를 `#{partNo}` 로 바꿔 쓴다.

## 바꿔 쓸 곳
- 실제 칸이 더 있으면 USING 의 SELECT, UPDATE SET, INSERT 칸 목록에 함께 늘린다
