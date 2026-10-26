# DB 스키마 규격 (devboost-schema) — v8 (2026-10-26)

> v8 변경 (v7 대비)
> - **수집 쿼리 하나로**: 기본값 쿼리를 따로 돌리지 않는다. UNION 으로 행 종류를 나누던 방식을 버리고 **컬럼마다 한 행**에 테이블·PK·UK·FK·인덱스·기본값을 모두 붙인다 (기본값이 LONG 이라 UNION 과 함께 쓸 수 없었던 문제를 구조로 해결)
> - 행 수 검증은 SUMMARY 행 대신 모든 행의 META 칸 (`rows=`)
> - 회사·인터넷에서 쓰는 컬럼 명세 쿼리 결과도 가져옴: 한글 별칭(테이블명, 컬럼명, 데이터유형, 데이터길이, NULL여부, 기본값, PK1 …)
> - 테이블 정의서는 **Excel(.xlsx)**: 목차 시트 + 테이블마다 시트, 목차 ↔ 테이블 시트 링크. 저장할 때 파일 이름을 입력하는 저장 창 (CSV 도 고를 수 있음)
> - v7 이전 이력은 v7 문서 참고

DevBoost 의 DB 관련 기능(테이블 정의서, 컬럼 호버·자동완성, 컬럼 검증, 영향도 분석, 코드 생성)이 공통으로 읽는 스키마 규격.
DevBoost 는 DB 에 직접 접속하지 않는다.

```
① DevBoost 화면에 테이블 접두어 입력 (TB_ …, 비우면 전체)
② 수집 쿼리를 워크시트에서 실행 (또는 복사해 DBeaver 등에서 실행)
③ 결과 그리드 전체를 헤더와 함께 복사 → [클립보드에서 가져오기] (행이 많으면 CSV 로 내보내 [파일에서 가져오기])
④ 저장 → .devboost/schema/<스키마>@<환경>.json
⑤ 가져온 데이터에서 테이블 선택 → [테이블 정의서로 추출 (Excel)]
```

## 1. 원칙

| 원칙 | 내용 |
|---|---|
| 한 번에 | 쿼리 1번 실행, 결과 1번 복사로 끝. 컬럼마다 한 행에 필요한 정보를 모두 붙임 |
| SQL 은 단순하게 | 데이터 사전 값을 **가공 없이** 내보냄. 타입 정리·묶기는 DevBoost 가 |
| 가벼운 실행 | 기본 `USER_*` 뷰, 테이블 범위 지정 가능, 행마다 도는 하위 쿼리 없음. 읽기만 하므로 잠금 없음 |
| 받는 쪽이 버티게 | 결과가 큰 셀 하나가 아니라 일반 행 → 그리드·CSV 로 다룰 수 있음 |
| 잘린 복사 감지 | 모든 행의 META 칸에 전체 행 수를 넣고, 가져올 때 실제 받은 행 수와 비교 |
| DB 중립 저장 | 저장 파일(`schema.json`)은 DBMS 에 묶이지 않게. DBMS 고유 값은 `raw*` 필드에 원문 |
| 정의서 완전성 | 저장 파일만으로 테이블 목록, 컬럼 명세, PK/FK/UK, 인덱스 정의서를 만들 수 있어야 함 |

## 2. 파일 위치

- 기본: 워크스페이스의 `.devboost/schema/<스키마>@<환경>.json` (환경을 비우면 `<스키마>.json`). 스키마·환경별로 여러 파일
- 같은 테이블이 여러 파일에 있으면 `source.collectedAt` 이 최신인 것 우선
- 팀 공유하려면 커밋, 개인용이면 `.gitignore`

## 3. 저장 구조 (`schema.json`)

```jsonc
{
  "format": "devboost-schema",
  "version": 1,                      // 저장 규격 버전 (v2 문서에서도 1 그대로: 저장 모양은 안 바뀜)
  "source": {
    "dbms": "oracle",
    "database": "PLMDB",             // 선택
    "schema": "PLM",
    "collectedAt": "2026-10-26T00:10:00+09:00",
    "label": "개발",                 // 선택: 가져올 때 입력 (개발 / 검증 / 운영)
    "prefixes": ["TB_"]           // 선택: 접두어로 받았으면 그 목록 (없으면 전체)
  },
  "tables":      [],   // 4.1
  "columns":     [],   // 4.2
  "constraints": [],   // 4.3
  "indexes":     [],   // 4.4
  "codes":       []    // 4.5 선택
}
```

## 4. 항목

### 4.1 tables

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `schema` | string | O | 소유 스키마 |
| `name` | string | O | 테이블·뷰 이름 (DB 에 저장된 대로, Oracle 은 대문자) |
| `kind` | `table` \| `view` | O | |
| `comment` | string | | 테이블 코멘트 (정의서의 "테이블 한글명/설명") |

### 4.2 columns

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `schema`, `table` | string | O | 소속 테이블 |
| `name` | string | O | 컬럼 이름 |
| `position` | number | O | 컬럼 순서 (1부터) |
| `type` | string | O | 정규화 타입: `string` \| `number` \| `date` \| `timestamp` \| `lob` \| `binary` \| `other` |
| `rawType` | string | O | DB 원래 타입: `VARCHAR2`, `NUMBER`, `DATE` … |
| `typeText` | string | O | 정의서 표시용: `VARCHAR2(100 CHAR)`, `NUMBER(10,2)`, `DATE` |
| `length` | number | | 문자 길이 (문자 타입) |
| `precision`, `scale` | number | | 숫자 자릿수 |
| `nullable` | boolean | O | |
| `default` | string | | 기본값 식 원문 (앞뒤 공백 제거). 예: `'Y'`, `0`, `SYSDATE`. 없으면 생략 |
| `comment` | string | | 컬럼 코멘트 (정의서의 "컬럼 한글명/설명") |

### 4.3 constraints

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `schema`, `table` | string | O | |
| `name` | string | O | 제약 이름 |
| `kind` | `primary` \| `unique` \| `foreign` | O | |
| `columns` | string[] | O | 순서대로 |
| `refTable`, `refColumns` | | foreign 만 | 참조 대상 (같은 스키마 안일 때만 채워짐) |
| `onDelete` | `cascade` \| `set null` \| `no action` | | foreign 만 |
| `enabled` | boolean | | |

### 4.4 indexes

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `schema`, `table` | string | O | |
| `name` | string | O | |
| `unique` | boolean | O | |
| `kind` | string | | `normal` \| `bitmap` \| `function-based normal` … (원문 소문자) |
| `columns` | `{ name, desc, expr? }[]` | O | 순서대로. 함수 기반 인덱스의 내부 컬럼(`SYS_NC…`)은 `expr: true` |

### 4.5 codes (선택: 공통코드)

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string | O | 코드 그룹 (예: `ORDER_STATUS`) |
| `groupName` | string | | 그룹 이름 |
| `code` | string | O | 코드값 (예: `A`) |
| `name` | string | O | 코드명 (예: `접수`) |
| `order` | number | | 정렬 순서 |
| `use` | boolean | | 사용 여부 |

## 5. 수집 결과 형식

컬럼마다 한 행. DevBoost 는 **헤더 이름**으로 칸을 찾으므로 순서가 바뀌어도 된다. 헤더 없이 복사했으면 아래 순서로 읽는다 (META 칸 위치로 확인, 행 번호 칸이 앞에 붙어도 됨).

| # | 칸 | 내용 |
|---|---|---|
| 1 | `TABLE_NAME` | 테이블·뷰 이름 |
| 2 | `TABLE_TYPE` | TABLE / VIEW |
| 3 | `TABLE_COMMENT` | 테이블 코멘트 (줄바꿈·탭은 공백으로) |
| 4 | `COLUMN_ID` | 컬럼 순서 |
| 5 | `COLUMN_NAME` | 컬럼 이름 |
| 6 | `COLUMN_COMMENT` | 컬럼 코멘트 (줄바꿈·탭은 공백으로) |
| 7 | `DATA_TYPE` | VARCHAR2, NUMBER, DATE … |
| 8 | `CHAR_LENGTH` | 문자 길이 (VARCHAR2(100 CHAR) 의 100. DATA_LENGTH 는 바이트라 정의서에 쓰면 틀림) |
| 9 | `CHAR_USED` | B(바이트) / C(문자) |
| 10 | `DATA_LENGTH` | 바이트 길이 (RAW 등) |
| 11 | `DATA_PRECISION` | 숫자 전체 자릿수 |
| 12 | `DATA_SCALE` | 소수 자릿수 |
| 13 | `NULLABLE` | Y / N |
| 14 | `PK_POS` | PK 안 순서 (PK 가 아니면 빈 값) |
| 15 | `PK_NAME` | PK 이름 |
| 16 | `UKS` | `UK이름(순서), …` |
| 17 | `FKS` | `FK이름(순서)=참조테이블.참조컬럼[ 삭제규칙], …` (참조 대상을 못 찾으면 `?`) |
| 18 | `IDXS` | `인덱스이름(순서[ DESC][ U]), …` (U = 유니크 인덱스) |
| 19 | `META` | `schema=PLM;db=PLMDB;at=2026-10-26T23:50:00+09:00;prefix=TB_;rows=184` (모든 행 같음) |
| 20 | `DATA_DEFAULT` | 기본값 원문 (LONG). **맨 끝 칸**: 줄바꿈이 섞여 복사가 쪼개지면 DevBoost 가 앞 행에 이어 붙임 |

UK·FK·인덱스는 컬럼 행마다 그 컬럼이 들어간 것만 적혀 있고, DevBoost 가 이름별로 모아 전체 모양(컬럼 순서 포함)을 다시 만든다.

## 6. Oracle 수집 SQL

- Oracle 11g R2 이상 (LISTAGG). 접속한 계정의 스키마 (`USER_*` 뷰)
- 아래는 접두어 `TB_` 의 예. DevBoost 화면이 입력한 접두어로 만들어 준다 (여러 개면 `UNION ALL SELECT 'TC_' FROM dual` 줄이 늘어남, 전체면 `NULL`)

### 6.1 기본값(LONG)을 한 쿼리에 넣으려고 지킨 것

`DATA_DEFAULT` 는 LONG 타입이라 `UNION`, 함수(`REPLACE` 등), `WITH` 안, `GROUP BY`·`ORDER BY` 에 쓸 수 없다. 단순 SELECT 에서 그대로 조회하는 것만 된다.

- UNION 을 쓰지 않는다 (컬럼마다 한 행)
- `WITH` 대신 `FROM` 안의 인라인 뷰
- 바깥 조인은 Oracle `(+)` 문법 (ANSI `LEFT JOIN` 은 내부적으로 뷰로 바뀌어 LONG 오류가 나는 버전이 있음)
- UK·FK·인덱스는 인라인 뷰에서 `LISTAGG` 로 미리 묶음 (그 안에는 LONG 이 없음)
- 행 수(META)는 따로 센 값을 붙임 (분석 함수를 LONG 과 함께 쓰지 않음)

```sql
-- DevBoost 스키마 수집 (접두어 TB_) — 실행(Ctrl+Enter) 후 결과 그리드 전체를 헤더와 함께 복사 → DevBoost [클립보드에서 가져오기]
-- 컬럼마다 한 행. 기본값(DATA_DEFAULT, LONG)까지 한 번에 나오도록 UNION·WITH 없이 씀
SELECT tc.table_name,
       t.table_type,
       t.table_comment,
       tc.column_id,
       tc.column_name,
       REPLACE(REPLACE(REPLACE(cc.comments, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ') AS column_comment,
       tc.data_type,
       tc.char_length,
       tc.char_used,
       tc.data_length,
       tc.data_precision,
       tc.data_scale,
       tc.nullable,
       pk.pk_pos,
       pk.pk_name,
       uk.uks,
       fk.fks,
       ix.idxs,
       m.meta,
       tc.data_default
  FROM user_tab_columns tc,
       -- 대상 테이블·뷰 (접두어, 휴지통 제외)
       (SELECT table_name, table_type, REPLACE(REPLACE(REPLACE(comments, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ') AS table_comment
          FROM user_tab_comments
         WHERE table_type IN ('TABLE', 'VIEW')
           AND table_name NOT LIKE 'BIN$%'
           AND EXISTS (SELECT 1 FROM (SELECT 'TB_' AS prefix FROM dual) p
                   WHERE p.prefix IS NULL OR SUBSTR(table_name, 1, LENGTH(p.prefix)) = p.prefix)) t,
       user_col_comments cc,
       -- PK: 컬럼별 순서
       (SELECT cc2.table_name, cc2.column_name, cc2.position AS pk_pos, c.constraint_name AS pk_name
          FROM user_constraints c, user_cons_columns cc2
         WHERE c.constraint_type = 'P' AND cc2.constraint_name = c.constraint_name) pk,
       -- UK: 이름(순서), …
       (SELECT cc2.table_name, cc2.column_name,
               LISTAGG(c.constraint_name || '(' || cc2.position || ')', ', ') WITHIN GROUP (ORDER BY c.constraint_name) AS uks
          FROM user_constraints c, user_cons_columns cc2
         WHERE c.constraint_type = 'U' AND cc2.constraint_name = c.constraint_name
         GROUP BY cc2.table_name, cc2.column_name) uk,
       -- FK: 이름(순서)=참조테이블.참조컬럼 [삭제규칙], …
       (SELECT cc2.table_name, cc2.column_name,
               LISTAGG(c.constraint_name || '(' || cc2.position || ')=' || NVL(rc.table_name, '?') || '.' || NVL(rcc.column_name, '?')
                       || CASE WHEN c.delete_rule <> 'NO ACTION' THEN ' ' || c.delete_rule END, ', ')
                 WITHIN GROUP (ORDER BY c.constraint_name) AS fks
          FROM user_constraints c, user_cons_columns cc2, user_constraints rc, user_cons_columns rcc
         WHERE c.constraint_type = 'R' AND cc2.constraint_name = c.constraint_name
           AND rc.owner(+) = c.r_owner AND rc.constraint_name(+) = c.r_constraint_name
           AND rcc.owner(+) = c.r_owner AND rcc.constraint_name(+) = c.r_constraint_name AND rcc.position(+) = cc2.position
         GROUP BY cc2.table_name, cc2.column_name) fk,
       -- 인덱스: 이름(순서[ DESC][ U]), …   (U = 유니크 인덱스)
       (SELECT ic.table_name, ic.column_name,
               LISTAGG(ic.index_name || '(' || ic.column_position || CASE WHEN ic.descend = 'DESC' THEN ' DESC' END
                       || CASE WHEN i.uniqueness = 'UNIQUE' THEN ' U' END || ')', ', ') WITHIN GROUP (ORDER BY ic.index_name) AS idxs
          FROM user_ind_columns ic, user_indexes i
         WHERE i.index_name = ic.index_name
         GROUP BY ic.table_name, ic.column_name) ix,
       -- 수집 정보 + 전체 행 수 (일부만 복사됐는지 확인용, 모든 행에 같은 값)
       (SELECT 'schema=' || USER
               || ';db=' || SYS_CONTEXT('USERENV', 'DB_NAME')
               || ';at=' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM')
               || ';prefix=' || pl.prefixes
               || ';rows=' || n.cnt AS meta
          FROM (SELECT LISTAGG(prefix, ',') WITHIN GROUP (ORDER BY prefix) AS prefixes
                  FROM (SELECT 'TB_' AS prefix FROM dual)) pl,
               (SELECT COUNT(*) AS cnt
                  FROM user_tab_columns x, user_tab_comments y
                 WHERE y.table_name = x.table_name
                   AND y.table_type IN ('TABLE', 'VIEW')
                   AND y.table_name NOT LIKE 'BIN$%'
                   AND EXISTS (SELECT 1 FROM (SELECT 'TB_' AS prefix FROM dual) p
                           WHERE p.prefix IS NULL OR SUBSTR(y.table_name, 1, LENGTH(p.prefix)) = p.prefix)) n) m
 WHERE t.table_name = tc.table_name
   AND cc.table_name(+) = tc.table_name AND cc.column_name(+) = tc.column_name
   AND pk.table_name(+) = tc.table_name AND pk.column_name(+) = tc.column_name
   AND uk.table_name(+) = tc.table_name AND uk.column_name(+) = tc.column_name
   AND fk.table_name(+) = tc.table_name AND fk.column_name(+) = tc.column_name
   AND ix.table_name(+) = tc.table_name AND ix.column_name(+) = tc.column_name
 ORDER BY tc.table_name, tc.column_id;
```

### 6.2 실행 부담

| 항목 | 내용 |
|---|---|
| 읽는 것 | 데이터 사전 뷰 (`USER_TAB_COLUMNS`, `USER_TAB_COMMENTS`, `USER_COL_COMMENTS`, `USER_CONSTRAINTS`, `USER_CONS_COLUMNS`, `USER_INDEXES`, `USER_IND_COLUMNS`). 업무 테이블은 읽지 않음, 잠금 없음 |
| 결과 행 수 | 대상 테이블·뷰의 컬럼 수 |
| 시간 | 보통 수 초. 수천 테이블이면 접두어로 나눠 받기 (접두어로 받으면 그 접두어 테이블만 교체되므로 나눠 받아 쌓을 수 있음) |

### 6.3 공통코드 (선택)

공통코드 테이블 구조는 프로젝트마다 다르므로 **별칭(AS 뒤)만 맞춰서** 고쳐 쓴다. 스키마를 저장한 뒤 같은 방법으로 가져오면 그 스키마 파일에 합쳐진다.

```sql
SELECT c.GROUP_CD   AS code_group,
       g.GROUP_NM   AS group_name,
       c.CODE       AS code,
       c.CODE_NM    AS code_name,
       c.SORT_ORDER AS sort_order,
       c.USE_YN     AS use_yn
  FROM TB_CODE c, TB_CODE_GROUP g
 WHERE g.GROUP_CD(+) = c.GROUP_CD
 ORDER BY c.GROUP_CD, c.SORT_ORDER;
```

### 6.4 다른 정의서 쿼리 결과 쓰기

회사·인터넷에서 쓰는 컬럼 명세 쿼리 결과도 그대로 가져온다. 헤더 이름을 영문·한글 별칭으로 알아본다 (공백·밑줄 무시).

| 규격 | 알아보는 이름 (예) |
|---|---|
| TABLE_NAME | 테이블명, 테이블, 테이블ID |
| TABLE_COMMENT | 테이블설명, 테이블한글명, TAB_CMT |
| COLUMN_NAME | 컬럼명, 컬럼, 칼럼명 |
| COLUMN_COMMENT | 컬럼설명, 컬럼한글명, COMMENTS, COL_CMT, 설명 |
| COLUMN_ID | 컬럼순서, 순서, 순번, SEQ |
| DATA_TYPE | 데이터유형, 데이터타입, 타입 |
| 길이 | 데이터길이, 길이 (`10,2` / `100`) |
| NULLABLE | NULL여부, NULL |
| PK_POS | PK, PK여부 (`PK1`, `Y`) |
| DATA_DEFAULT | 기본값, 디폴트, DEFAULT |

META 가 없으므로 일부 복사 검증은 하지 않고, 스키마 이름은 저장할 때 물어본다. 이런 쿼리는 문자 길이를 `DATA_LENGTH`(바이트)로 내는 경우가 많아 `VARCHAR2(100 CHAR)` 가 `400` 으로 나올 수 있다.

## 7. DevBoost 가 가져올 때 하는 일

1. 텍스트 판별: 탭 구분(그리드 복사) / CSV(쉼표, `"…"` 칸 지원) / JSON(저장 규격)
2. 헤더 찾기 (영문·한글 별칭). 데이터 행에 헤더 같은 값이 있어도 META 칸이 있는 행은 헤더로 보지 않음. 헤더가 없으면 META 위치로 5장 순서
3. 그리드 복사(탭)는 따옴표를 글자 그대로 읽음. `(null)`·`[NULL]` 은 빈 값 (기본값의 `NULL` 글자는 값으로 둠)
4. 칸 수가 모자란 줄(기본값 맨 끝 칸이 줄바꿈으로 쪼개진 것)은 앞 행 기본값에 이어 붙임
5. META 의 `rows` 와 받은 행 수가 다르면 **오류** (일부만 복사됨, 저장 안 함). 행이 하나도 없어도 오류
6. UK·FK·인덱스 글을 풀어 이름별로 모음, 타입 정리 (7.1)
7. `.devboost/schema/<스키마>@<환경>.json` 에 저장
   - 접두어로 받았으면 기존 파일에서 그 접두어 테이블만 교체, 나머지 유지
   - 전체로 받아 기존 파일을 통째로 바꿀 때는 확인
   - 공통코드만 가져오면 지금 보고 있는 스키마 파일에 합침

### 7.1 타입 정규화 (Oracle → 저장 규격)

| DATA_TYPE | type | typeText |
|---|---|---|
| VARCHAR2, CHAR | string | `VARCHAR2(100)`, 문자 단위(`CHAR_USED`=C)면 `VARCHAR2(100 CHAR)` |
| NVARCHAR2, NCHAR | string | `NVARCHAR2(100)` |
| NUMBER | number | `NUMBER(10,2)`, scale 0 이면 `NUMBER(10)`, 자릿수 없으면 `NUMBER` (scale 만 0 이면 `INTEGER`) |
| FLOAT, BINARY_FLOAT, BINARY_DOUBLE | number | 원문 |
| DATE | date | `DATE` |
| TIMESTAMP(6) …, … WITH TIME ZONE | timestamp | 원문 |
| CLOB, NCLOB, BLOB, LONG | lob | 원문 |
| RAW, LONG RAW | binary | `RAW(16)` (`DATA_LENGTH`) |
| 그 밖 (XMLTYPE 등) | other | 원문 |

## 8. 하지 않는 것

| 항목 | 이유 |
|---|---|
| CHECK 조건 | 정의서에 잘 쓰지 않음. LONG 이라 같은 방식으로 넣을 수는 있음 |
| 함수 기반 인덱스의 식 | 식 컬럼(`SYS_NC…`)은 `USER_TAB_COLUMNS` 에 없어 그 인덱스의 그 칸은 빠짐 |
| 다른 스키마를 참조하는 FK 의 참조 컬럼 | `USER_*` 로는 안 보여 `?` |

## 9. 다른 DBMS (나중)

같은 5장 결과 형식으로 `information_schema` 기반 수집 SQL 을 추가한다 (MySQL, PostgreSQL). DevBoost 가져오기·저장 규격은 그대로.

## 10. DevBoost 기능 순서

| 순서 | 기능 | 내용 |
|---|---|---|
| 1 | 수집·가져오기 | "스키마 수집 SQL 열기"(범위·스키마 반영, 워크시트로 보냄), "스키마 가져오기"(클립보드/파일, 7장) |
| 2 | 테이블 정의서 | 테이블 선택 → Markdown / Excel(.xlsx) / HTML. 표지·테이블 목록·컬럼 명세(No, 컬럼명, 코멘트, 타입, NULL, 기본값, PK, FK, 인덱스) |
| 3 | 편집기 연동 | mapper XML·Java 에서 테이블·컬럼 호버, mapper XML 컬럼 자동완성, 없는 테이블·컬럼 경고 |
| 4 | mybatisRunner 연동 | 파라미터 입력칸에 컬럼 코멘트, 공통코드 컬럼이면 코드 목록에서 고르기 |
| 5 | 영향도 | 컬럼 → mapper SQL → Mapper → Service → Controller → Vue (Source Atlas 역방향) |
| 6 | 코드 생성 | 테이블 → VO/DTO, resultMap, CRUD mapper, Vue 폼·그리드 |
| 7 | 스키마 비교 | 두 파일(개발 vs 운영) 차이 → 누락 컬럼·타입 차이 |

## 11. 테이블 정의서

가져온 데이터 화면에서 테이블을 골라 `테이블 정의서로 추출 (Excel)` → 저장 창에서 파일 이름 입력.

**Excel (.xlsx, 기본)** — `테이블정의서_<스키마>_<환경>_<날짜>.xlsx`

| 시트 | 내용 |
|---|---|
| 목차 | 제목, 스키마·환경·수집일·작성일, No·테이블명·설명·구분·컬럼 수·PK·FK 수·인덱스 수 (필터, 머리글 고정). **테이블명을 누르면 그 시트로** |
| 테이블마다 (시트 이름 = 테이블명) | `◀ 목차` 링크, 테이블명·설명·구분·PK·PK 이름·컬럼 수, 컬럼 명세 표, 인덱스 목록. 머리글 고정, A4 가로 한 장 너비로 인쇄 |

컬럼 명세 칸: `No, 컬럼명, 컬럼 설명, 데이터 타입, NULL(Y/N), 기본값, PK(Y, 복합키는 Y(1)·Y(2)), UK(제약 이름), FK 참조(참조테이블.컬럼), 인덱스(인덱스명(순서), PK 인덱스 제외)`
시트 이름은 31자까지라 긴 테이블명은 잘리고, 겹치면 `_2` 를 붙인다. 외부 라이브러리 없이 DevBoost 가 직접 만든다.

**CSV** — 저장 창에서 형식을 CSV 로 고르면 `<이름>.csv`(정의서) + `<이름>_목차.csv`. UTF-8 BOM + CRLF. `=`, `+`, `-`, `@` 로 시작하는 글은 앞에 공백을 붙여 Excel 이 수식으로 읽지 않게 함.

뷰는 기본으로 빠지고, 화면의 `뷰 포함`을 켜면 목록에 나와 고를 수 있다.

## 12. 확인 필요 (실제 DB 에서)

- 6장 수집 쿼리가 오류 없이 도는지 (특히 LONG 과 인라인 뷰·`(+)` 조인 조합), 실행 시간
- 결과 그리드 전체 복사 시 헤더·모든 행이 들어오는지 (META 검증)
- 정의서 xlsx 를 Excel 에서 열었을 때 모양, 목차 링크
