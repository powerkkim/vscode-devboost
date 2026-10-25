# DB 스키마 규격 (devboost-schema) — v7 (2026-10-26)

> v7 변경 (v6 대비) — 코드 검토 반영
> - SUMMARY 의 스키마는 `USER`(로그인 계정): `USER_*` 뷰가 읽는 것과 같은 계정. `ALTER SESSION SET CURRENT_SCHEMA` 를 해도 틀리지 않음
> - FK 참조 테이블·컬럼은 소유자(`r_owner`)까지 맞춰 찾음 (다른 스키마의 같은 이름 제약과 섞이지 않게)
> - 가져오기: SUMMARY 행이 없거나 테이블·컬럼 행이 없으면 **오류** (기존 파일을 덮지 않게). 탭 구분(그리드 복사)은 따옴표를 글자 그대로 읽음
> - 본 쿼리와 기본값 결과를 이어 붙여 한 번에 가져와도 기본값 반영
> - 전체(접두어 없이)로 받아 기존 파일을 통째로 바꿀 때는 확인을 받음
> - 정의서 CSV: `=`, `+`, `-`, `@` 로 시작하는 글(코멘트 등)은 앞에 공백을 붙여 Excel 이 수식으로 읽지 않게. CP949 CSV 도 읽음

> v6 변경 (v5 대비) — DevBoost 구현에 맞춤
> - 저장 파일 이름: `<스키마>@<환경>.json` (같은 스키마의 개발·운영을 따로 두기 위해. 환경을 비우면 `<스키마>.json`)
> - 수집 SQL 은 DevBoost 화면에서 접두어를 넣어 만든다 (6장 SQL 은 그 결과의 예시)
> - 테이블 정의서 CSV 형식 추가 (11장)
> - 가져올 때 `(null)`·`[NULL]` 은 빈 값, 행 번호 칸이 붙어 복사된 경우도 처리 (7장)

> v5 변경 (v4 대비)
> - 접두어 예시를 `TB_REQ` → `TB_` 로 변경 (여러 개 예시는 `TC_`)

> v4 변경 (v3 대비)
> - **테이블 접두어로 범위 지정**: 맨 위 `p` 한 곳에 `TB_` 처럼 쓰면 그 접두어로 시작하는 테이블만. 여러 개 가능, NULL 이면 전체
> - 접두어는 LIKE 가 아니라 앞부분 비교(`SUBSTR`)라 `_` 가 와일드카드로 잘못 먹지 않음
> - 접두어로 받은 결과를 가져오면 기존 파일에서 **그 접두어 테이블만 교체** (다른 테이블은 유지)
> - Oracle 11g R2 이상 (SUMMARY 에 접두어 목록을 넣느라 LISTAGG 사용)

> v3 변경 (v2 대비)
> - **컬럼 기본값(DEFAULT) 추가**: 저장 규격 `columns.default`, 수집 SQL 에 기본값 쿼리(6.1) 추가
> - 기본값은 Oracle 에서 LONG 타입이라 본 쿼리와 합칠 수 없어 **별도 쿼리**로 받고, 가져올 때 합친다
> - SUMMARY 에 기본값 행 수(`DEFAULT=`) 추가 → 기본값 결과를 빠뜨리면 알림

> v2 변경 (v1 대비)
> - **수집 SQL 을 단순한 SELECT 로 바꿈**: JSON 함수·행마다 도는 하위 쿼리 제거, 결과는 수 MB CLOB 한 칸이 아니라 일반 행
> - 타입 정규화·묶기·JSON 변환은 **DevBoost 가 가져올 때** 처리 (SQL 은 데이터 사전 값을 그대로 내보내기만)
> - `USER_*` 뷰 기본 (빠름, 권한 검사 없음), 범위 한 줄로 줄이기, Oracle 버전 제한 없음 (10g 이상)
> - 그리드가 일부 행만 복사한 경우를 잡도록 **SUMMARY 행(행 수 검증)** 추가
> - DevBoost 가 저장하는 `schema.json` 모양(3·4장)은 v1 과 같음

DevBoost 의 DB 관련 기능(테이블 정의서, 컬럼 호버·자동완성, 컬럼 검증, 영향도 분석, 코드 생성)이 공통으로 읽는 스키마 규격.
DevBoost 는 DB 에 직접 접속하지 않는다.

```
① DevBoost 명령 "스키마 수집 SQL 열기" → 워크시트에 수집 SQL (범위·스키마 선택 반영)
② 아무 DB 도구에서 실행 (Oracle 확장 워크시트, DBeaver, SQL Developer …)
③ 결과 그리드 전체 복사 (또는 CSV 내보내기)
④ DevBoost 명령 "스키마 가져오기" → 행 수 검증 → 정규화 → .devboost/schema/<스키마>.json 저장
```

## 1. 원칙

| 원칙 | 내용 |
|---|---|
| SQL 은 단순하게 | 데이터 사전 값을 **가공 없이** 평범한 행으로. 회사 테이블 정의서 쿼리 수준. 무거운 처리는 DevBoost 가 |
| 가벼운 실행 | 기본 `USER_*` 뷰, 테이블 범위 지정 가능, 행마다 도는 하위 쿼리 없음. 읽기만 하므로 잠금 없음 |
| 받는 쪽이 버티게 | 결과가 큰 셀 하나가 아니라 일반 행 → 그리드·CSV 로 다룰 수 있음 |
| 잘린 복사 감지 | 첫 행(SUMMARY)에 종류별 행 수를 넣고, 가져올 때 실제 받은 행 수와 비교 |
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

## 5. 수집 결과 형식 (SQL 이 내보내는 행)

수집 SQL 은 **한 번 실행에 결과 하나**를 낸다. 모든 행이 같은 컬럼을 갖고, `REC` 로 종류를 구분한다.
DevBoost 는 **첫 줄의 컬럼 이름(헤더)으로** 값을 찾으므로 컬럼 순서는 바뀌어도 된다. 헤더가 없으면 아래 순서로 읽는다.

| # | 컬럼 | SUMMARY | TABLE | COLUMN | CONS | INDEX |
|---|---|---|---|---|---|---|
| 1 | `REC` | SUMMARY | TABLE | COLUMN | CONS | INDEX |
| 2 | `TABLE_NAME` | | O | O | O | O |
| 3 | `NAME` | `devboost-schema/1` | | 컬럼명 | 제약명 | 인덱스명 |
| 4 | `SEQ` | | | 컬럼 순서 | 제약 안 순서 | 인덱스 안 순서 |
| 5 | `COLUMN_NAME` | | | | 제약 컬럼 | 인덱스 컬럼 |
| 6 | `KIND` | | TABLE/VIEW | | P/U/R | 인덱스 종류 |
| 7 | `DATA_TYPE` | | | O | | |
| 8 | `CHAR_LENGTH` | | | O | | |
| 9 | `CHAR_USED` | | | B/C | | |
| 10 | `DATA_LENGTH` | | | O | | |
| 11 | `DATA_PRECISION` | | | O | | |
| 12 | `DATA_SCALE` | | | O | | |
| 13 | `NULLABLE` | | | Y/N | | |
| 14 | `UNIQUENESS` | | | | | UNIQUE/NONUNIQUE |
| 15 | `DESCEND` | | | | | ASC/DESC |
| 16 | `REF_TABLE` | | | | 참조 테이블 | |
| 17 | `REF_COLUMN` | | | | 참조 컬럼 | |
| 18 | `DELETE_RULE` | | | | CASCADE/… | |
| 19 | `STATUS` | | | | ENABLED/… | |
| 20 | `COMMENTS` | 수집 정보 | 테이블 코멘트 | 컬럼 코멘트 | | |

SUMMARY 행의 `COMMENTS` 예: `schema=PLM;db=PLMDB;at=2026-10-26T00:10:00+09:00;prefix=TB_;TABLE=12;COLUMN=184;CONS=31;INDEX=40;DEFAULT=9`
(`prefix` 가 비어 있으면 전체)

기본값은 별도 쿼리(6.1)의 결과로 받는다. 그 결과의 행은 `REC`=`DEFAULT`, `TABLE_NAME`, `NAME`(컬럼명), `COMMENTS`(기본값 원문) 네 컬럼만 쓴다.
→ 가져올 때 REC 별로 받은 행 수와 비교해서 다르면 **"일부 행만 복사되었습니다 (COLUMN 1840 중 500)"** 로 알리고 저장하지 않는다.

코멘트 안의 줄바꿈·탭은 SQL 에서 공백으로 바꿔 내보낸다 (복사한 표가 깨지지 않게).

## 6. Oracle 수집 SQL

- Oracle 11g R2 이상
- 접속한 계정의 스키마 기준 (`USER_*` 뷰). 다른 스키마는 6.3
- **가져올 테이블은 맨 위 `p` 에서만 정한다**: 접두어를 쓰면 그것으로 시작하는 테이블만, `NULL` 이면 전체, 여러 접두어는 줄 추가
- DevBoost "스키마 수집 SQL 열기" 는 접두어를 물어 6장·6.1 쿼리 모두에 넣어 준다

```sql
WITH p AS (                                   -- ★ 가져올 테이블 접두어 (여기만 바꿈)
  SELECT UPPER('TB_') AS prefix FROM dual  --   전체를 받으려면 'TB_' 대신 NULL
  -- UNION ALL SELECT UPPER('TC_') FROM dual  -- 접두어가 여러 개면 줄 추가
),
t AS (                                        -- 대상 테이블·뷰
  SELECT table_name, table_type, comments
    FROM user_tab_comments
   WHERE table_type IN ('TABLE', 'VIEW')
     AND table_name NOT LIKE 'BIN$%'          -- 휴지통 제외
     AND EXISTS (SELECT 1 FROM p              -- 접두어로 시작 (LIKE 가 아니라 '_' 도 글자 그대로 비교)
                  WHERE p.prefix IS NULL
                     OR SUBSTR(table_name, 1, LENGTH(p.prefix)) = p.prefix)
),
c AS (                                        -- 컬럼
  SELECT tc.table_name, tc.column_name, tc.column_id, tc.data_type, tc.char_length, tc.char_used,
         tc.data_length, tc.data_precision, tc.data_scale, tc.nullable, cc.comments
    FROM user_tab_columns tc
    JOIN t ON t.table_name = tc.table_name
    LEFT JOIN user_col_comments cc
      ON cc.table_name = tc.table_name AND cc.column_name = tc.column_name
),
k AS (                                        -- PK / UK / FK (제약 컬럼마다 한 행)
  SELECT con.table_name, con.constraint_name, con.constraint_type, con.status, con.delete_rule,
         col.position, col.column_name,
         rcon.table_name AS ref_table, rcol.column_name AS ref_column
    FROM user_constraints con
    JOIN t ON t.table_name = con.table_name
    JOIN user_cons_columns col ON col.constraint_name = con.constraint_name
    LEFT JOIN user_constraints rcon
      ON rcon.owner = con.r_owner AND rcon.constraint_name = con.r_constraint_name
    LEFT JOIN user_cons_columns rcol
      ON rcol.owner = con.r_owner AND rcol.constraint_name = con.r_constraint_name AND rcol.position = col.position
   WHERE con.constraint_type IN ('P', 'U', 'R')
),
x AS (                                        -- 인덱스 (인덱스 컬럼마다 한 행)
  SELECT ix.table_name, ix.index_name, ix.index_type, ix.uniqueness,
         ic.column_position, ic.column_name, ic.descend
    FROM user_indexes ix
    JOIN t ON t.table_name = ix.table_name
    JOIN user_ind_columns ic ON ic.index_name = ix.index_name
)
SELECT * FROM (
  SELECT 'SUMMARY' rec, CAST(NULL AS VARCHAR2(128)) table_name, 'devboost-schema/1' name,
         TO_NUMBER(NULL) seq, CAST(NULL AS VARCHAR2(128)) column_name, CAST(NULL AS VARCHAR2(30)) kind,
         CAST(NULL AS VARCHAR2(128)) data_type, TO_NUMBER(NULL) char_length, CAST(NULL AS VARCHAR2(1)) char_used,
         TO_NUMBER(NULL) data_length, TO_NUMBER(NULL) data_precision, TO_NUMBER(NULL) data_scale,
         CAST(NULL AS VARCHAR2(1)) nullable, CAST(NULL AS VARCHAR2(9)) uniqueness, CAST(NULL AS VARCHAR2(4)) descend,
         CAST(NULL AS VARCHAR2(128)) ref_table, CAST(NULL AS VARCHAR2(128)) ref_column,
         CAST(NULL AS VARCHAR2(9)) delete_rule, CAST(NULL AS VARCHAR2(8)) status,
         'schema=' || USER
           || ';db=' || SYS_CONTEXT('USERENV', 'DB_NAME')
           || ';at=' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM')
           || ';prefix=' || (SELECT LISTAGG(prefix, ',') WITHIN GROUP (ORDER BY prefix) FROM p)
           || ';TABLE=' || (SELECT COUNT(*) FROM t)
           || ';COLUMN=' || (SELECT COUNT(*) FROM c)
           || ';CONS=' || (SELECT COUNT(*) FROM k)
           || ';INDEX=' || (SELECT COUNT(*) FROM x)
           || ';DEFAULT=' || (SELECT COUNT(*) FROM user_tab_columns d JOIN t ON t.table_name = d.table_name
                               WHERE d.data_default IS NOT NULL) AS comments
    FROM dual
  UNION ALL
  SELECT 'TABLE', table_name, NULL, NULL, NULL, table_type,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         REPLACE(REPLACE(REPLACE(comments, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ')
    FROM t
  UNION ALL
  SELECT 'COLUMN', table_name, column_name, column_id, NULL, NULL,
         data_type, char_length, char_used, data_length, data_precision, data_scale, nullable,
         NULL, NULL, NULL, NULL, NULL, NULL,
         REPLACE(REPLACE(REPLACE(comments, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ')
    FROM c
  UNION ALL
  SELECT 'CONS', table_name, constraint_name, position, column_name, constraint_type,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         ref_table, ref_column, delete_rule, status, NULL
    FROM k
  UNION ALL
  SELECT 'INDEX', table_name, index_name, column_position, column_name, index_type,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, uniqueness, descend,
         NULL, NULL, NULL, NULL, NULL
    FROM x
)
ORDER BY DECODE(rec, 'SUMMARY', 0, 'TABLE', 1, 'COLUMN', 2, 'CONS', 3, 4), table_name, name, seq;
```

### 6.1 기본값 쿼리 (6장 쿼리 다음에 실행)

`DATA_DEFAULT` 는 LONG 타입이라 `UNION ALL`·함수·`REPLACE` 를 쓸 수 없다. 단독 SELECT 로는 그대로 조회된다.
**접두어는 6장 쿼리의 `p` 와 똑같이** 맞춘다. (LONG 컬럼을 조회하는 쿼리라 WITH 대신 조건 안에 직접 쓴다)

```sql
SELECT 'DEFAULT' AS rec, tc.table_name, tc.column_name AS name, tc.data_default AS comments
  FROM user_tab_columns tc
  JOIN user_tab_comments t ON t.table_name = tc.table_name
 WHERE t.table_type IN ('TABLE', 'VIEW')
   AND t.table_name NOT LIKE 'BIN$%'
   AND EXISTS (SELECT 1
                 FROM (SELECT UPPER('TB_') AS prefix FROM dual   -- ★ 6장과 같은 접두어 (전체면 NULL)
                       -- UNION ALL SELECT UPPER('TC_') FROM dual
                      ) p
                WHERE p.prefix IS NULL
                   OR SUBSTR(tc.table_name, 1, LENGTH(p.prefix)) = p.prefix)
   AND tc.data_default IS NOT NULL               -- LONG 은 WHERE 에서 IS (NOT) NULL 만 가능
 ORDER BY tc.table_name, tc.column_id;
```

- 기본값이 있는 컬럼만 나오므로 행 수가 적다 (보통 컬럼의 5~10%)
- 기본값 원문에 줄바꿈이 섞인 경우(`DEFAULT` 를 여러 줄로 쓴 테이블)가 있다. SQL 에서 고칠 수 없으므로 DevBoost 가 처리 (7장 2번)
- 가져오기: 6장 결과를 붙여 넣은 뒤 이어서 붙여 넣거나, 나중에 "스키마 가져오기"로 이 결과만 넣어도 기존 파일에 합쳐진다

### 6.2 실행 부담

| 항목 | 내용 |
|---|---|
| 읽는 것 | 데이터 사전 뷰 7개 (`USER_TAB_COMMENTS`, `USER_TAB_COLUMNS`, `USER_COL_COMMENTS`, `USER_CONSTRAINTS`, `USER_CONS_COLUMNS`, `USER_INDEXES`/`USER_IND_COLUMNS`). 업무 테이블은 읽지 않음, 잠금 없음 |
| 결과 행 수 | 대략 테이블 수 + 컬럼 수 + 제약 컬럼 수 + 인덱스 컬럼 수 (테이블 500개면 보통 1만 행 안팎) |
| 시간 | `USER_*` 기준 보통 수 초. 수천 테이블이면 접두어로 나눠 받기 (예: `TB_`, `TC_` …) |

### 6.3 다른 스키마 받기

6장·6.1 쿼리 모두 `USER_*` → `ALL_*` 로 바꾸고 모든 조인·조건에 `owner` 를 넣는다 (예: `ALL_TAB_COMMENTS ... WHERE owner = 'PLM'`, 조인은 `owner` + 이름).
DevBoost 의 "스키마 수집 SQL 열기" 가 스키마 이름을 물어 이 버전을 만들어 준다. 그 스키마 객체를 조회할 권한이 있어야 한다.

### 6.4 결과 받기

| 방법 | 언제 | 주의 |
|---|---|---|
| 그리드 전체 복사 → DevBoost "스키마 가져오기(클립보드)" | 보통 | **그리드는 처음 일부 행만 가져와 보여 주는 경우가 많다** → 끝까지 스크롤하거나 "모두 가져오기" 후 복사. 덜 복사되면 SUMMARY 검증에서 걸림. 헤더 포함 복사 권장 (DBeaver: 고급 복사) |
| CSV 내보내기 → DevBoost "스키마 가져오기(파일)" | 행이 많을 때 | 헤더 포함, 구분자는 쉼표·탭 모두 가능 |

### 6.5 공통코드 (선택)

공통코드 테이블 구조는 프로젝트마다 다르므로 **별칭(AS 뒤)만 맞춰서** 고쳐 쓴다. 별도로 실행해 같은 방법으로 가져온다.

```sql
SELECT 'CODE' AS rec,
       c.GROUP_CD   AS code_group,
       g.GROUP_NM   AS group_name,
       c.CODE       AS code,
       c.CODE_NM    AS code_name,
       c.SORT_ORDER AS sort_order,
       c.USE_YN     AS use_yn
  FROM TB_CODE c
  LEFT JOIN TB_CODE_GROUP g ON g.GROUP_CD = c.GROUP_CD
 ORDER BY c.GROUP_CD, c.SORT_ORDER;
```

### 6.6 기존 테이블 정의서 쿼리 쓰기

회사에서 쓰던 컬럼 명세 쿼리가 있으면 별칭을 5장 이름(`TABLE_NAME`, `NAME`(컬럼명), `SEQ`, `DATA_TYPE`, `CHAR_LENGTH`, `DATA_PRECISION`, `DATA_SCALE`, `NULLABLE`, `COMMENTS`)으로 맞추면 된다. 기본값 컬럼이 있으면 별칭 `DATA_DEFAULT` 로 두면 읽는다.
`REC` 컬럼이 없으면 모든 행을 COLUMN 으로 읽는다 (SUMMARY 가 없으면 행 수 검증은 건너뜀). PK 표시 컬럼(`PK` = Y)이 있으면 PK 로 읽는다.

## 7. DevBoost 가 가져올 때 하는 일

1. 텍스트 판별: 탭 구분(그리드 복사) / CSV / JSON(이미 저장 규격이면 그대로)
2. 헤더로 컬럼 위치 찾기 (대소문자 무시). 헤더가 없으면 5장 순서. 그리드가 맨 앞에 행 번호 칸을 붙여 복사해도 REC 위치로 맞춤. `(null)`·`[NULL]` 은 빈 값 (기본값의 `NULL` 글자는 값으로 둠). 여러 결과를 이어 붙였으면 헤더가 다시 나오는 곳에서 나눠 읽음.
   알려진 `REC` 값(SUMMARY/TABLE/COLUMN/CONS/INDEX/DEFAULT/CODE)으로 시작하지 않는 줄은 앞 행의 마지막 칸(COMMENTS)이 줄바꿈으로 나뉜 것으로 보고 이어 붙임
   탭 구분(그리드 복사)은 따옴표를 글자 그대로 읽는다 (그리드는 칸을 따옴표로 감싸지 않으므로). CSV(쉼표)만 `"…"` 를 한 칸으로 읽는다.
   `REC` 는 맨 앞 칸(또는 행 번호 다음 칸)에서만 헤더로 본다 ('REC' 라는 컬럼이 있어도 헤더로 오인하지 않게)
3. SUMMARY 행이 없거나(첫 행부터 복사하지 않음), 테이블·컬럼 행이 하나도 없으면 **오류** — 저장하지 않음
4. SUMMARY 행 수와 실제 행 수 비교
   - TABLE·COLUMN·CONS·INDEX 가 다르면 **중단**하고 알림 (일부만 복사됨)
   - DEFAULT 행이 없거나 수가 다르면 **저장은 하되** "기본값 95개 중 0개 — 6.1 쿼리 결과를 이어서 가져오세요" 로 알림
5. DEFAULT 행: `TABLE_NAME`+`NAME` 으로 컬럼을 찾아 `default` 에 넣음 (앞뒤 공백·줄바꿈 제거). 본 쿼리 결과와 이어 붙여 가져와도 되고, DEFAULT 행만 가져오면 지금 보고 있는 파일에 합침
6. 묶기: CONS·INDEX 행을 이름별로 모아 `columns` 배열 (SEQ 순)
7. 타입 정규화 (아래 표)
8. `.devboost/schema/<스키마>@<환경>.json` 에 저장
   - SUMMARY 에 접두어가 있으면 기존 파일에서 **그 접두어로 시작하는 테이블만 교체** (그 사이 DB 에서 지워진 테이블은 빠짐), 다른 테이블은 그대로. 업무별로 나눠 받아 하나의 파일로 쌓을 수 있다
   - 접두어가 없으면(전체) 파일 전체를 교체. 기존 파일이 있으면 "기존 테이블 N개 → 이번 M개" 확인을 받음
   - REC 없는 컬럼 명세(6.6)는 스키마 이름을 물어봄 (같은 스키마면 덮어쓰기 전 확인), 결과 요약 표시 (테이블 120 · 컬럼 1840 · PK 118 …)

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
| CHECK 조건 | 정의서에 잘 쓰지 않고, LONG 타입이라 별도 쿼리가 필요. 필요해지면 기본값과 같은 방식으로 추가 |
| 다른 스키마를 참조하는 FK 의 참조 컬럼 | `USER_*` 로는 안 보임 → `refTable`·`refColumns` 비어 있음 (6.3 으로 받으면 채워짐) |
| 행 수·통계 | 정의서에 꼭 필요하지 않고 통계 기준이라 부정확 |

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

## 11. 테이블 정의서 CSV

가져온 데이터 화면에서 테이블을 골라 `테이블 정의서로 추출 (CSV)` → 폴더를 고르면 두 파일을 만든다. UTF-8 BOM + CRLF 라 Excel 에서 한글이 깨지지 않는다.

| 파일 | 내용 |
|---|---|
| `테이블정의서_목차_<스키마>_<환경>_<날짜>.csv` | 머리(스키마·환경·수집일·작성일) + No, 테이블명, 테이블 설명, 구분, 컬럼 수, PK, FK 수, 인덱스 수 |
| `테이블정의서_<스키마>_<환경>_<날짜>.csv` | 테이블마다: 제목 줄 → 테이블명·설명·구분 → PK·PK 이름 → 컬럼 명세 → 인덱스 목록, 테이블 사이 빈 줄 두 개 |

컬럼 명세 칸: `No, 컬럼명, 컬럼 설명, 데이터 타입, NULL(Y/N), 기본값, PK(Y, 복합키는 Y(1)·Y(2)), UK(제약 이름), FK 참조(참조테이블.컬럼), 인덱스(인덱스명(순서), PK 인덱스 제외)`
뷰는 기본으로 빠지고, 화면의 `뷰 포함`을 켜면 목록에 나와 고를 수 있다.
`=`, `+`, `-`, `@` 로 시작하는 글(예: `- 삭제예정`)은 Excel 이 수식으로 읽어 `#NAME?` 이 되므로 앞에 공백 하나를 붙인다 (숫자 `-1` 은 그대로).

## 12. 확인 필요 (실제 DB 에서)

- 6장·6.1 SQL 이 오류 없이 도는지, 실행 시간
- 6.1 결과의 기본값(LONG) 이 그리드에 제대로 보이고 복사되는지
- Oracle 확장 워크시트 그리드에서 전체 복사 시 **헤더가 같이 복사되는지**, 모든 행이 복사되는지
- 회사 공통코드 테이블 구조 (6.5 별칭 맞추기)
