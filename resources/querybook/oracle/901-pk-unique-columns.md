---
title: 이 테이블의 PK·유니크 키 칸 조합 (정의 확인)
category: 딕셔너리
db: oracle
tags: PK, 기본키, 유니크, UK, 제약, 인덱스, ALL_CONSTRAINTS, 키 조합
---
## 상황
이 테이블에서 **어떤 칸 조합이 키로 정의돼 있는지** 알고 싶다. 기본 키(PK), 유니크 제약(UK), 그리고 제약 없이 유니크 인덱스로만 걸린 것까지.
JOIN 조건을 짤 때, 데이터를 넣다 ORA-00001(유일 제약 위반)이 났을 때 어느 칸 때문인지 볼 때 쓴다.
(데이터가 실제로 유일한지는 「이 칸 조합이 데이터상 유일한지 검사」 항목)

## 예제 테이블
딕셔너리 뷰를 읽는다 (내 DB 에서 바로 실행).
- `ALL_CONSTRAINTS` — 제약 목록 (P = PK, U = UK)
- `ALL_CONS_COLUMNS` — 제약에 들어간 칸과 순서
- `ALL_INDEXES`·`ALL_IND_COLUMNS` — 인덱스와 칸

## 원하는 결과
TB_BOM 의 예

| KEY_NAME | KIND | COLS | STATUS |
|---|---|---|---|
| PK_TB_BOM | PK | PARENT_NO, CHILD_NO | ENABLED |
| UK_TB_BOM_SEQ | UK | PARENT_NO, SEQ | ENABLED |
| IX_TB_BOM_ERP | UNIQUE INDEX | ERP_KEY | VALID |

## 쿼리
```sql
SELECT c.CONSTRAINT_NAME AS KEY_NAME,
       DECODE(c.CONSTRAINT_TYPE, 'P', 'PK', 'U', 'UK') AS KIND,
       LISTAGG(cc.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY cc.POSITION) AS COLS,
       c.STATUS
  FROM ALL_CONSTRAINTS c
  JOIN ALL_CONS_COLUMNS cc
    ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
 WHERE c.OWNER = NVL(UPPER(NULLIF('${소유자:-}', '-')), USER)
   AND c.TABLE_NAME = UPPER('${테이블명:TB_BOM}')
   AND c.CONSTRAINT_TYPE IN ('P', 'U')
 GROUP BY c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, c.STATUS
UNION ALL
SELECT i.INDEX_NAME, 'UNIQUE INDEX',
       LISTAGG(ic.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION),
       i.STATUS
  FROM ALL_INDEXES i
  JOIN ALL_IND_COLUMNS ic
    ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
 WHERE i.TABLE_OWNER = NVL(UPPER(NULLIF('${소유자}', '-')), USER)
   AND i.TABLE_NAME = UPPER('${테이블명}')
   AND i.UNIQUENESS = 'UNIQUE'
   AND NOT EXISTS (SELECT 1 FROM ALL_CONSTRAINTS c
                    WHERE c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
                      AND c.CONSTRAINT_TYPE IN ('P', 'U'))
 GROUP BY i.INDEX_NAME, i.STATUS
 ORDER BY 2, 1
```

## 풀이
- 위쪽: PK·UK 제약과 그 칸들을 `LISTAGG` 로 한 줄에 (`POSITION` = 키 안에서의 칸 순서).
- 아래쪽: 제약은 없고 유니크 인덱스로만 유일성을 지키는 경우 (PK·UK 가 쓰는 인덱스는 위와 겹치므로 `NOT EXISTS` 로 뺐다).
- `STATUS` 가 DISABLED·UNUSABLE 이면 정의만 있고 지금은 지켜지지 않는다.
- 소유자가 `-` 이면 접속한 스키마(USER). 다른 스키마 테이블이면 그 스키마 이름을 넣는다.
- 왼쪽 DB 연결 트리에서 테이블을 오른쪽 클릭 → 「사전에서 쿼리…」 로 고르면 테이블·소유자가 채워진다. 같은 내용은 「테이블 정보」 화면에서도 볼 수 있다.
