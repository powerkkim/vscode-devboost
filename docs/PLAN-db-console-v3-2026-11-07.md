# DB 콘솔 계획·진행 v3 (2026-11-07)

DevBoost 0.17.0 (`feature/db-drivers` 브랜치, develop 기준)

## 1. 구조: DB별 처리 분리

```
src/features/dbConsole/
  driver/        공통 약속과 연결 지점
    types.ts       DbDriver · DbConnection · SchemaReader · ErrorInfo · ConnectInfo · DriverExtras
    session.ts     DbSession (접속 하나, 일을 차례로 줄 세움)
    registry.ts    DB 종류 → 드라이버 (공통 코드가 drivers/ 를 직접 부르지 않음)
    dialects.ts    DB 종류 → SQL 글 규칙만 (콘솔 화면 번들용)
  drivers/lib.ts   PostgreSQL·MySQL 라이브러리를 처음 접속할 때 불러옴 (dist/drivers/pg.js · mysql.js)
  drivers/postgres/ connect · session(pg + pg-cursor) · schema(pg_catalog) · errors(SQLSTATE) · dialect($$, CALL·DO)
  drivers/mysql/    connect · session(mysql2 흘려 받기) · schema(information_schema) · errors(ER_*) · dialect(백틱·#·\)
  drivers/oracle/  Oracle 에만 있는 것 전부
    connect.ts     연결 문자열·JDBC URL·호스트 칸 해석
    session.ts     node-oracledb 접속 → DbConnection
    execute.ts     실행·페이지·칸 변환·실행계획(DBMS_XPLAN)
    schema.ts      ALL_TABLES·ALL_VIEWS·ALL_SYNONYMS·ALL_TAB_COLUMNS·PK·FK
    errors.ts      ORA-/NJS- 안내, 끊김·인증·취소 판정
    dialect.ts     / 줄, PL/SQL 블록, q'[…]'
    output.ts      DBMS_OUTPUT (extras.output — Oracle 접속에서만 화면에 보임)
  sql/             DB 종류와 관계없는 SQL 글 처리 (규칙은 인자로 받음)
    statements.ts  문장 나누기·종류 판정 (DialectRules)
    binds.ts       :name, #{name}
    nameFilter.ts  트리 이름 필터
    joinBuilder.ts 고른 테이블로 SELECT·COUNT·JOIN
  console.ts · index.ts · sessions.ts · ui/*   공통 (드라이버 약속만 봄)
```

규칙: 한 DB에만 있는 기능은 `DbConnection.extras` 로 내놓고, 화면은 `status.features` 에 그 기능이 있을 때만 보여 준다.

## 2. v3 에서 한 것 (2026-11-07)

| 번호 | 내용 | 확인 |
|---|---|---|
| 1 | 칸 자동 완성 (`별칭.칸`, FROM·JOIN 별칭 읽기, 처음 한 번 DB 에서 읽고 기억) | 화면 테스트 |
| 2 | SQL 정렬 `Shift+Alt+F` (sql-formatter, DB 마다 plsql·postgresql·mysql 문법, PL/SQL 블록은 그대로) | 화면 테스트 |
| 3 | MyBatis `▶ 콘솔에서 실행` (CodeLens·실행 패널 → 값 넣은 SQL 을 콘솔 끝에 넣고 실행) | 단위 테스트 |
| 4 | 실행 기록 (연결마다 500개, 같은 문장은 위로, 고르면 넣기 / `▶` 바로 실행) | 단위 테스트 |
| 5 | 테이블 정보 (칸·PK/FK·제약·인덱스·참조하는 테이블·DDL) — Oracle `DBMS_METADATA`, PostgreSQL 은 카탈로그로 조립, MySQL `SHOW CREATE` | 실제 PG·MariaDB |
| 7 | DB 스키마: `DB 연결에서 바로 가져오기` (SchemaReader.collect → 정의서와 같은 모양) | 실제 PG·MariaDB |
| — | 예약했던 결과 버튼 수정: 화면 데이터로 동작, `⋯` 메뉴 | 화면 테스트 50개 |
| — | INSERT 복사의 날짜·이름 표기를 DB 별로 | 단위 테스트 |
| — | **PostgreSQL** 드라이버 (커서로 나눠 받기, 문장마다 SAVEPOINT, `pg_cancel_backend`, RAISE NOTICE → 서버 출력) | 실제 PostgreSQL 16 34/34 |
| — | **MySQL/MariaDB** 드라이버 (autocommit 끔, 흘려 받다 멈춤, `KILL QUERY`, `EXPLAIN FORMAT=TREE`, BLOB `0x…`) | 실제 MariaDB 10.11 전부 통과 |
| — | 연결 화면 DB 종류 선택 (JDBC URL 로 저절로 바뀜, 기본 포트·접속 방식 맞춤) | 단위·화면 테스트 |

단위 테스트 226개 통과.

### 드라이버 라이브러리를 어떻게 싣는가 (v2 계획에서 바꾼 것)

v2 에서는 처음 접속할 때 내려받으려 했으나, 회사망(프록시·사내 저장소)에서 내려받기가 막히면 쓸 수 없어 **확장 안에 따로 묶고 처음 접속할 때 불러오는** 방식으로 바꿈.

- `dist/drivers/pg.js` 87KB, `dist/drivers/mysql.js` 504KB (압축 154KB) — 확장이 켜질 때는 읽지 않음
- mysql2 의 쓰지 않는 문자 집합 표(CJK 일부)·AWS SSL 프로필은 빌드에서 뺌 (CP949 는 둠)

## 3. 실제 DB 에서 확인할 것

Oracle (v2 와 같음):
1. 서버 출력 켜고 `BEGIN DBMS_OUTPUT.PUT_LINE('x'); END;` → 쿼리 아래와 메시지에 `x`
2. `:param` 이 있는 SELECT 에 Ctrl+E → 실행계획
3. `스키마 바꾸기`, 다른 스키마 테이블의 칸·JOIN, 시노님
4. 테이블 정보의 DDL (`DBMS_METADATA` 권한이 없는 계정이면 안내가 나오는지)
5. DB 스키마 `DB 연결에서 바로 가져오기` — 테이블이 1,000개 넘을 때 (IN 목록 나눠 읽기)

PostgreSQL · MySQL (사내 서버로):
1. JDBC URL 붙여 넣기 → DB 종류·칸이 채워지는지
2. 한글 주석, 큰 조회 `끝까지`, 실행 취소
3. MySQL 8 의 `EXPLAIN FORMAT=TREE`, PostgreSQL `EXPLAIN` 

## 4. 남은 것

- CLOB 을 다 받은 뒤 4,000자로 자르는 문제 → 앞부분만 읽기
- 결과 전체 내보내기 (커서로 끝까지 받아 파일로)
- MySQL `DELIMITER` (프로시저 만들기 스크립트)
- 코드 생성 → [PLAN-codegen-v1-2026-11-07.md](PLAN-codegen-v1-2026-11-07.md)
