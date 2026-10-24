# MyBatis SQL 실행 (mybatisRunner) — v2 (2026-10-25)

v2 변경: 바인드 변수 모드를 VARIABLE/EXEC 스크립트(F5 실행)로 바꾸고 `실행 계획` 버튼 추가.

mapper XML 의 쿼리를 파라미터 값으로 풀어 실행 가능한 SQL 을 만들고 Oracle SQL Developer 워크시트로 보낸다.
DB 에 직접 접속하지 않는다 (실행·결과는 Oracle 확장이 맡음).

## 1단계에서 된 것

| 영역 | 내용 |
|---|---|
| 시작 | 쿼리 위 CodeLens `▶ SQL 실행` / `SQL 복사`, 에디터 우클릭, `Ctrl+Alt+Enter` (커서가 있는 쿼리) |
| 태그 | `if` `choose/when/otherwise` `where` `set` `trim` `foreach` `bind` `include`(+`property`, 다른 mapper) `selectKey`(건너뜀) |
| 조건식 | OGNL 부분 구현: and/or/not, 비교(eq/neq/lt…), `size()` `isEmpty()` `equals()` `trim()` 등, `in {…}`, 삼항, `@…StringUtils@isNotEmpty(x)` 류(메서드 이름으로 판단) |
| 판단 불가 | 정적 상수(`@Code@ACTIVE`), 모르는 메서드 → 꺼 두고 `?` 표시, 사용자가 켜기/끄기 |
| 값 | 자동/문자/숫자/날짜/목록/JSON/null/'' — 빈칸은 null. `user.name` 같은 중첩 경로 |
| 출력 | 값 넣기(`'홍'`, `TO_DATE`, `IN (1, 2)`) → Ctrl+Enter 실행 / 바인드 변수 스크립트 → F5 실행 (아래) |
| 실행 계획 | 모드와 관계없이 바인드 변수 형태 SQL 을 넣고 F10 (`sqldeveloper.worksheet.explainPlan`). EXPLAIN PLAN 은 값 없이 계획을 만듦 |
| 기억 | 쿼리별 입력값·조건 지정 (workspaceState), 같은 이름 파라미터는 다른 쿼리에 "공통"으로 채움 |
| Oracle | 마지막으로 쓴 워크시트(언어 `oracle-sql`)에 이어 붙이고 선택 → `sqldeveloper.worksheet.runStatement` 로 실행. DML 은 확인창 |
| 경고 | `'Y'` char 비교, null/빈 목록 foreach, 빈 `${}`, 못 찾은 include, 알 수 없는 태그 |
| 표시 | 화면이 열려 있는 동안 꺼진 조건을 XML 에서 흐리게 |

### 바인드 변수 스크립트

워크시트의 바인드 입력 화면에 값을 다시 넣지 않도록, SQL*Plus 문법으로 값까지 넣은 스크립트를 만든다.

```sql
-- OrderMapper.selectList (바인드 변수)
VARIABLE kw     VARCHAR2(4000)        -- SQL*Plus 명령: 도구가 바인드 변수를 만듦
VARIABLE fromDt VARCHAR2(40)
EXEC :kw     := '%홍%';               -- PL/SQL 한 줄(BEGIN :kw := ...; END;)로 값 넣기
EXEC :fromDt := '2026-10-01';

SELECT ... WHERE c.NAME LIKE :kw
  AND o.ORDER_DT >= TO_DATE(:fromDt, 'YYYY-MM-DD');   -- VARIABLE 은 DATE 타입이 없어 문자열 + TO_DATE
```

- 빈 값도 `EXEC :x := NULL;` 로 넣는다 (같은 세션에 남은 이전 값이 쓰이지 않도록)
- 같은 이름은 한 번만 선언, foreach 는 `:id_0`, `:id_1` …
- 실행은 `sqldeveloper.worksheet.runScript`(F5). 넣은 부분을 선택해 두고 부른다

Oracle 확장 연동은 `oracle.sql-developer-26.3.0` 의 `package.json` 을 읽고 정했다.
접속에서 워크시트를 여는 명령은 트리 항목을 인자로 받아 밖에서 부를 수 없으므로, **사용자가 접속에서 연 워크시트를 기억해 그곳으로 보내는** 방식이다.

## F5 확인 순서

1. SQL Developer 접속에서 `Open SQL Worksheet` 로 워크시트를 하나 연다
2. 실제 프로젝트의 mapper XML 을 열면 쿼리마다 `▶ SQL 실행 | SQL 복사` 가 보이는지
3. `▶ SQL 실행` → 오른쪽 화면: 파라미터 목록, 조건 목록, SQL
4. 값을 바꾸면 SQL·조건 상태·XML 흐림이 바로 바뀌는지
5. `?` 로 나온 조건이 있으면 그 식을 알려 주기 (지원 범위를 넓힐 근거)
6. `▶ 워크시트에서 실행` → 1번 워크시트에 SQL 이 붙고 실행되는지 (실행이 안 되면 Ctrl+Enter 로 되는지)
7. 바인드 변수 모드 `▶ 워크시트에서 실행 (F5)` → 값 입력 없이 실행되는지, **워크시트에 다른 SQL 이 있어도 넣은 부분(선택 영역)만 실행되는지**
8. `실행 계획` → F10 결과가 나오는지, 바인드 값을 묻는 창이 뜨는지

## 다음 후보

1. 실제 mapper 에서 `?` 로 나오는 식 모아 OGNL 규칙 보강 (정적 상수는 설정으로 값 지정: `{"@com.x.Code@ACTIVE": "Y"}`)
2. 컨텍스트 프로필: 로그인 사용자·권한 같은 공통 값을 세트로 저장해 바꿔 가며 비교
3. 시나리오 저장: 입력값 조합에 이름을 붙여 저장·불러오기
4. `<collection select=…>` / `<association select=…>` 연관 쿼리 목록과 이동, 결과 컬럼 ↔ resultMap 비교
5. iBATIS 2 (`<sqlMap>`, `<isNotEmpty>` 등) — 필요하면
6. 정확도가 꼭 필요할 때: 프로젝트 클래스패스의 MyBatis 로 `BoundSql` 을 만드는 Java 헬퍼
