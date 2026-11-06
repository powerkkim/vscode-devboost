# DB 콘솔 계획·진행 v2 (2026-11-07)

DevBoost 0.17.0 (`feature/db-drivers` 브랜치, develop 기준)

## 1. 구조: DB별 처리 분리

```
src/features/dbConsole/
  driver/        공통 약속과 연결 지점
    types.ts       DbDriver · DbConnection · SchemaReader · ErrorInfo · ConnectInfo · DriverExtras
    session.ts     DbSession (접속 하나, 일을 차례로 줄 세움)
    registry.ts    DB 종류 → 드라이버 (공통 코드가 drivers/ 를 직접 부르지 않음)
    dialects.ts    DB 종류 → SQL 글 규칙만 (콘솔 화면 번들용)
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

## 2. 이번에 한 것

| 구분 | 내용 | 확인 |
|---|---|---|
| 안전 | 서브쿼리 안에만 WHERE 가 있는 UPDATE·DELETE 도 확인 | 단위 테스트 |
| 성능 | 결과 패널: 탭 추가·메시지·행 추가를 바뀐 것만 보냄 | 화면 테스트(Chrome) |
| 성능 | 트리 읽기: 실행 중이면 오류 대신 끝난 뒤에 (DbSession 줄 세우기) | 단위 테스트 |
| 성능 | 콘솔 SQL 을 globalState → 연결별 파일 (globalStorage/dbConsole) | 코드 |
| 편의 | 쿼리 아래 결과 (설정 `resultsIn`: both / editor / panel) | 화면 테스트 |
| 편의 | 지금 문장 띠, Shift+Alt+→/← 선택 넓히기·좁히기, 오른쪽 클릭 메뉴 | 화면 테스트 |
| 버그 | Ctrl+Z 두 단계 되돌림, 줄 강조가 선택을 가림 | 화면 테스트 |
| 편의 | 트리 이름 필터, 스키마 바꾸기, 시노님 | 단위 테스트(필터) |
| 편의 | 여러 테이블 → SELECT·COUNT·JOIN 만들기/실행 (FK → PK 칸 이름 → CROSS JOIN) | 단위·화면 테스트 |
| Oracle | 서버 출력(DBMS_OUTPUT), 실행계획 바인드 오류 시 값 없이 다시 | **실제 DB 확인 필요** |
| 기타 | 결과 탭 고정·닫기, 콘솔을 닫을 때 커밋 안 한 변경 알림 | 화면 테스트 |

테스트: 단위 211개 통과, 콘솔 화면 33개·결과 패널 8개 항목(헤드리스 Chrome, 가짜 VS Code). VSIX 991KB → 1,004KB.

### 2-1. 2026-11-07 추가로 한 것
| 구분 | 내용 |
|---|---|
| 결과 표 | 칸 너비를 내용에 맞춤, 보이는 행만 그림 (5만 행 48ms), 상자는 내용만큼·버튼은 왼쪽 |
| 편집 | Tab/Shift+Tab 들여쓰기·내어쓰기 |
| 행 수 | 도구 줄 `한 번에 N행`·`최대 N행`(설정 maxRows, 200,000까지), `끝까지` |
| 실행 대상 | 문장마다 ▶, 도구 줄 `실행 대상: N~M번째 줄`, 다른 문장의 파라미터 흐리게, `실행 전 값 확인`은 파라미터가 있을 때만 |
| 결과 위치 | 선택 칸 없앰 — 결과·실행계획은 항상 쿼리 아래, 하단 패널은 저절로 열지 않음(쌓이기만), CSV 버튼을 쿼리 아래로 |


## 3. 실제 Oracle 에서 확인할 것

1. 서버 출력 켜고 `BEGIN DBMS_OUTPUT.PUT_LINE('x'); END;` → 쿼리 아래와 메시지에 `x`
2. `:param` 이 있는 SELECT 에 Ctrl+E → 실행계획이 나오는지
3. `스키마 바꾸기` 목록(ALL_USERS ORACLE_MAINTAINED='N')과 다른 스키마 테이블의 칸·JOIN
4. 시노님 묶음 → 칸이 가리키는 테이블 것으로 나오는지
5. FK 가 있는 테이블 두 개 JOIN, FK 없이 PK 칸 이름이 같은 테이블 JOIN
6. VS Code 오른쪽 클릭 메뉴에 잘라내기·복사·붙여넣기 + 실행·실행계획·지금 문장 고르기
7. Ctrl+Z 한 번에 한 단계만, 선택 영역이 줄 강조에 가리지 않는지

## 4. 예약한 수정 (다음에 할 것)

1. **결과 버튼을 화면 데이터로**: 지금은 실행할 때마다 패널의 앞 결과를 비워서, 앞 쿼리 결과에서는 `INSERT`·`패널`·`CSV` 버튼이 빠진다.
   → 확장에 결과 사본을 두지 않고, 버튼을 누를 때 쿼리 아래 화면의 데이터를 넘겨 처리. 개수 제한 불필요.
   `다음 N행`·`끝까지`는 DB 커서가 필요해 마지막 실행 결과에서만 (서버 OPEN_CURSORS 한도)
2. **쿼리 아래 버튼 정리**: 늘 보이는 것 = `다음 N행`·`끝까지`(더 있을 때), `복사`, `접기`, `×`.
   `⋯` 메뉴 = `헤더 포함 복사`, `INSERT 문으로 복사`, `CSV 내보내기`, `패널에서 보기`

## 5. 남은 것

- CLOB 을 다 받은 뒤 4,000자로 자르는 문제 → 앞부분만 읽기 (node-oracledb Lob 부분 읽기, 실제 DB로 확인하며)
- `INSERT문으로 복사`의 날짜 표기(`TO_DATE`)가 Oracle 식 → 드라이버의 dialect 로 옮기기
- 결과 전체 내보내기 (커서로 끝까지 받아 파일로)
- 실행 기록, 칸 자동 완성(별칭.칸)

## 6. MySQL · PostgreSQL 붙이는 순서

1. `driver/types.ts` 의 `DbKind` 에 추가, `drivers/postgres/`·`drivers/mysql/` 만들기 (connect·session·execute·schema·errors·dialect)
2. dialect: PostgreSQL `$1` 바인드·`$$` 따옴표, MySQL `?` 바인드·백틱·`DELIMITER`
3. 수동 커밋: PostgreSQL 은 `BEGIN` 을 열고, 오류 뒤에는 롤백 전까지 막힘 → 화면 안내. MySQL 은 `autocommit=0`
4. 취소: PostgreSQL `pg_cancel_backend`, MySQL 다른 접속으로 `KILL QUERY`
5. 연결 팝업에 DB 종류 선택, JDBC URL `jdbc:postgresql://`·`jdbc:mysql://`
6. 드라이버 라이브러리(`pg`, `mysql2`)는 묶지 않고 **처음 접속할 때 내려받아** 확장 저장소에 둠 (Oracle 은 지금처럼 포함). 이 PC 의 PostgreSQL 16 으로 실제 테스트 가능
