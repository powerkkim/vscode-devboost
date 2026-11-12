# DevBoost

개발할 때 자주 쓰는 편의 기능을 모은 VS Code 플러그인입니다. 기능마다 켜고 끌 수 있습니다.

## 기능

| 기능 | 단축키 | 켜기/끄기 설정 |
|---|---|---|
| **Search Everywhere** — 클래스·파일·심볼·텍스트 통합 검색 | `Shift` 두 번 / `Ctrl+Alt+Shift+F` | `devBoost.searchEverywhere.enabled` |
| **MyBatis SQL 실행** — mapper XML 쿼리를 DB 콘솔에서 실행, 콘솔 왼쪽 칸에서 파라미터 값을 바꾸면 if·foreach 까지 다시 풀림 | `Ctrl+Alt+Enter`·우클릭 `DB 콘솔에서 실행` / 쿼리 위 `▶ 콘솔에서 실행`·`SQL 복사` | `devBoost.mybatisRunner.enabled` |
| **Source Atlas** — 열린 Vue 파일의 컴포넌트·API·서버 흐름 화면 | Vue 파일 우클릭 → `Atlas 화면 열기` | `devBoost.sourceAtlas.enabled` |
| **DB 스키마** — 스키마 가져오기, 테이블 정의서(Excel) | 명령 `DB 스키마: 스키마 가져오기 · 테이블 정의서` | `devBoost.dbSchema.enabled` |
| **DB 콘솔** — Oracle(12.1 이상)·PostgreSQL·MySQL/MariaDB 에 직접 접속해 쿼리 실행, 결과는 실행한 문장 아래와 하단 패널 `DB 결과` | 사이드바 DevBoost → `DB 연결` / 콘솔에서 `Ctrl+Enter` | `devBoost.dbConsole.enabled` |
| **케이스 변환** — camel·snake·kebab 변환, SQL → Java 필드, Java → TypeScript·MyBatis SQL | 명령 팔레트 `케이스 변환:` / 선택 영역 우클릭 | `devBoost.caseConverter.enabled` |
| **SQL 로그** — 터미널에서 실행한 서버의 SQL 로그(MyBatis·log4jdbc)에서 쿼리를 골라 DB 콘솔로 | 상태바 `SQL n` / `Ctrl+Alt+L` | `devBoost.sqlLog.enabled` |
| **import 따라가기** — `@/…` 별칭으로 가져온 이름을 누르면 import 줄이 아니라 실제 선언으로, 올리면 선언 내용 | `Ctrl+클릭` / `Ctrl+Alt+F12` | `devBoost.importJump.enabled` |
| **API 콘솔** — API 요청을 모음으로 저장해 두고 보내 보기 (환경 변수 · 기록 · cURL · Postman 모음 가져오기) | `Ctrl+Alt+A` | `devBoost.apiConsole.enabled` |

기능을 끄려면 설정(`Ctrl+,`) → `DevBoost` 검색 → 체크 해제. 바로 반영됩니다.

### Search Everywhere

| 조작 | 키 |
|---|---|
| 탭 전환 (모두 / 클래스 / 파일 / 심볼 / Mapper / Spring / 텍스트) | `Tab` / `Shift+Tab` |
| 이동 · 열기 · 닫기 | `↑↓` `PageUp/Down` · `Enter` · `Esc` |
| 범위: 테스트 제외 ↔ 라이브러리 포함 | `Alt+N` (오른쪽 위 드롭다운) |
| 포함/제외 경로 필터 | `Alt+P` |
| 창 고정 (열어도 닫지 않고 이어서 열기) | `Alt+L` (오른쪽 위 `고정`) |
| 텍스트 탭: 대소문자 · 단어 단위 · 정규식 | `Alt+C` · `Alt+W` · `Alt+X` |

- **범위 드롭다운**: 프로젝트 (테스트 제외, 기본) / 프로젝트 (테스트 포함) / 테스트만 / 프로젝트 + 라이브러리 / 최근에 연 파일 / 커밋 안 한 파일 (Git)
- **파일 타입**(텍스트 탭): 쉼표로 여러 패턴, 대소문자 무시. 예) `*.java, *mapper*.xml, *.vue, *.ts`
- **필터**: Ctrl+Shift+F 의 files to include / exclude 와 같은 형식
  - `src/main/java/com/demo/module/order` → 그 폴더 아래만 · `./src` → 워크스페이스 바로 아래 · `**/dto/**, *Test.java` → 패턴
  - `현재 폴더` 버튼: 지금 보는 파일의 폴더를 포함에 넣기
- **Mapper 탭**: MyBatis mapper XML(파일과 SQL id)과 Java mapper 인터페이스·메서드만. `<mapper namespace>` 가 있는 XML 만 골라 pom.xml·설정 XML 은 나오지 않습니다. SQL id 를 고르면 그 줄로 이동. 검색어가 2글자 이상이면 mapper XML 본문(테이블·컬럼 이름 등)에서 찾은 줄도 함께 나오고, 어느 SQL id 안인지 옆에 표시합니다 (대소문자 무시)
- **Spring 탭**: 빈 클래스(`@Service` 등)·`@Bean` 메서드·URL 매핑(`@GetMapping("/search")` 적힌 그대로). URL 일부(`/search`)나 클래스·메서드 이름으로 찾음
- **결과 개수와 더 보기**: 탭마다 `maxResults`(기본 50)개씩 보여 주고, 더 있으면 끝에 `더 보기 — 123개 중 50개 표시`. 모두 탭은 종류별 머리글에 개수가 나오고 `더 보기`는 그 탭으로 이동
- 텍스트 검색은 최대 2,000건까지 모은 뒤 열린 파일 → `src` → 기타 → 라이브러리 순으로 정렬해 보여 줍니다. 2,000건을 넘으면 알려 주니 포함 경로·파일 타입으로 좁혀 보세요
- 에디터에서 단어를 선택한 채로 열면 그 단어로 바로 검색
- 텍스트 검색은 VS Code 내장 ripgrep 사용 (`.gitignore` 반영)
- 클래스·심볼: 프로젝트의 클래스(Java·Kotlin·TS/JS 등)와 메서드(Java·Kotlin·TS·JS·Vue)·Java 필드·JS 최상위 변수는 자체 색인으로 바로 찾습니다 (이름 중간 글자로도 찾음)
- 언어 서버(Java·TS 등)는 쓰지 않습니다. 모든 탭이 ripgrep 으로 만든 색인·파일 목록·텍스트로 찾습니다 (색인은 메모리에만, 프로젝트 크기만큼). jar 안의 클래스는 검색되지 않고, jar 파일 이름은 파일 탭에서 찾을 수 있습니다
- 동작 기록: 보기 → 출력 → 오른쪽 드롭다운 **DevBoost**. 검색별 시간, 쓰는 ripgrep, 색인 만들기·갱신, 창을 닫아 멈춘 것이 찍힙니다

### 케이스 변환

| 명령 | 하는 일 |
|---|---|
| `케이스 변환 (camel · snake · kebab …)` | 선택한 이름(없으면 커서 아래 이름)을 camelCase · PascalCase · snake_case · SCREAMING_SNAKE_CASE · kebab-case · dot.case 로 바꿈. 여러 곳을 선택하면 한 번에 변환 |
| `SQL·컬럼 이름 → Java 필드` | mapper XML 쿼리의 SELECT 목록 · INSERT 컬럼 · `CREATE TABLE` · 컬럼 이름 목록 · 테이블 이름을 `private 타입 이름;` 으로 바꿈 |
| `Java 필드 → TypeScript 인터페이스` | 클래스·record·필드 몇 줄을 `export interface` 로 바꿈 (`List<X>` → `X[]`, 날짜 → `string` 등) |
| `Java 필드 → MyBatis SQL` | SELECT 컬럼 · INSERT · UPDATE · resultMap 생성 |

- **단축키 롤업**: 이름 위에 커서를 두고 `Alt+Shift+U` 를 누를 때마다 camel → Pascal → snake → SCREAMING_SNAKE → kebab 순으로 바뀜 (`Ctrl+Alt+Shift+U` 는 반대 방향, 우클릭 메뉴에도 있음)
- 입력: 선택 영역 → (mapper XML 이면) 커서 위치 쿼리 → (`.sql`·`.java` 이면) 현재 파일 → 클립보드 순서. 같은 파일의 `<include refid>` 는 풀어서 반영
- 타입: `DB 스키마`로 스키마를 가져와 두었다면 실제 컬럼 타입·설명을 쓰고(`SELECT *`·테이블 이름만 넣어도 컬럼을 펼침), 없으면 컬럼 이름으로 추정
- 결과는 새 문서로 열림. 클립보드·선택 영역 아래 삽입으로 바꾸려면 설정 `devBoost.caseConverter.output`

### 설정

| 설정 | 설명 |
|---|---|
| `devBoost.searchEverywhere.ui` | 화면 방식: `popup`(에디터 탭, 기본) / `panel`(Activity Bar 사이드바) / `window`(별도 창) / `quickPick`(VS Code 기본 목록) |
| `devBoost.searchEverywhere.exclude` | 검색에서 **완전히 뺄** 경로 (모든 탭). 기본: `target`, `node_modules`, `build`, `.git`, 로그 등 |
| `devBoost.searchEverywhere.indexFolders` | **이 폴더 아래만** 색인·검색 (예: `example-back/src/main`). 비우면 워크스페이스 전체 |
| `devBoost.searchEverywhere.ripgrepPath` | ripgrep(`rg`) 경로. 비우면 VS Code 안의 rg, 없으면 PATH 의 rg |
| `devBoost.searchEverywhere.library` | **라이브러리로 취급**할 경로 → *프로젝트 + 라이브러리* 범위에서만 보임. 기본: `vendor`, `*.min.js` |
| `devBoost.searchEverywhere.defaultScope` | 창을 열 때 기본 범위 |
| `devBoost.searchEverywhere.fileMasks` | 파일 타입 드롭다운 목록 |
| `devBoost.searchEverywhere.doubleShift` | `Shift` 두 번으로 열기 |
| `devBoost.searchEverywhere.showTiming` | 검색 창 하단에 단계별 소요 시간 표시 (출력 패널 "DevBoost"에도 기록) |

### DB 콘솔

1. 사이드바 DevBoost → `DB 연결` → `+` 로 연결 추가. 처음에 DB 종류(Oracle · PostgreSQL · MySQL/MariaDB)를 고름. JDBC URL 을 붙여 넣으면 DB 종류와 칸이 함께 채워짐
2. 연결을 펼치면 테이블·뷰·시노님·칸. 연결 줄의 필터 버튼으로 이름 필터(`TB_PLM`, `*_HIST`, `!*_BAK`), 오른쪽 클릭 `스키마 바꾸기`
3. 테이블을 `Ctrl`·`Shift` 로 여러 개 골라 오른쪽 클릭 → `SELECT 만들기/실행`, `행 수 세기`, `JOIN 만들기/실행` (참조 제약, 없으면 기본 키 칸 이름으로 이음)
4. 콘솔에서 `Ctrl+Enter` 실행(커서 문장 또는 선택 영역 — 도구 줄에 `실행 대상` 표시), 줄 옆 `▶` 로 그 문장 실행, `Ctrl+E` 실행계획, `Shift+Alt+→` 문장 고르기. 결과·실행계획은 문장 바로 아래에 나옵니다. 하단 패널 `DB 결과`에도 쌓이니(메시지 기록 포함) 크게 보고 싶을 때 열어 보세요
5. 결과 옆 `⋯` → 헤더 포함 복사 · INSERT 문으로 복사 · CSV 내보내기 · 패널에서 보기 (화면에 있는 결과 그대로, 정렬 순서 포함). 아직 받지 않은 행이 있으면 CSV 는 `전체 결과`(쿼리를 다시 실행해 끝까지 파일로)도 고를 수 있음
6. 편집: 테이블 이름·별칭은 청록색(이름은 굵게), JOIN 결과는 테이블별 색으로 구분. `별칭.` 뒤에서 칸 이름 자동 완성, `Shift+Alt+F` SQL 정렬, 도구 줄 `기록`(연결별 실행 기록, 다시 실행), 테이블 오른쪽 클릭 `테이블 정보`(칸·제약·인덱스·참조하는 테이블·DDL)
7. 쿼리 사전: 도구 줄 `사전` (또는 `Ctrl+Alt+Q`) — 상황별 쿼리를 설명·예제와 함께 찾아 넣고, `연습 실행` 으로 예제 데이터에서 먼저 결과를 본다. 내가 만든 쿼리는 오른쪽 클릭 `사전에 추가` 로 `.devboost/querybook/` 에 `.md` 로 쌓아 팀과 나눈다
8. 콘솔 여러 개: 도구 줄 `+ 콘솔` (또는 연결 오른쪽 클릭 `새 콘솔`). 콘솔마다 따로 접속해 긴 쿼리를 돌리는 동안 다른 콘솔을 쓰고, 커밋·롤백도 콘솔마다 따로. 콘솔 2부터는 처음 실행할 때 접속하고 콘솔을 닫으면 접속도 닫음 (커밋하지 않은 변경이 있으면 먼저 물음). 연결 목록에 서버에 열어 둔 접속 수가 보임
9. MyBatis mapper 의 쿼리 위 `▶ 콘솔에서 실행` (또는 우클릭 `DB 콘솔에서 실행`, `Ctrl+Alt+Enter`) — `-- 네임스페이스.쿼리id` 머리 주석과 함께 콘솔 끝에 들어가고, 커서가 그 문장에 있으면 **왼쪽에 MyBatis 파라미터 칸**이 열림
   - 한 줄에 하나씩 `이름 · 값 · 종류(자동·글자·숫자·날짜·목록·null·'')`. `<if>`·`<foreach>` 에 쓰이는 값은 아래 "조건" 묶음에 `if 켜짐 / if 꺼짐 / foreach 3개` 상태와 함께
   - 값을 바꾸면 mapper 를 다시 풀어 문장이 바뀜 (조건이 붙거나 빠지고 foreach 는 개수만큼 펼침). `#{}` 는 `:이름` 으로 들어가고 값은 그대로 실행에 쓰임. 목록은 `10,20,30`
   - `실행 전 값 확인`이 켜져 있으면 실행 전에 왼쪽 첫 칸으로 가고, Enter 로 실행. 값은 쿼리별로 기억
   - 일반 SQL 로 커서를 옮기면 패널이 닫히고 위쪽 파라미터 줄로 돌아감. 머리 주석을 지우면 그 문장은 일반 SQL

DB 마다 다른 것(접속·실행·딕셔너리·오류 안내·SQL 글 규칙)은 따로 처리합니다. Oracle 의 `DBMS_OUTPUT`·`/` 구분·`q'[...]'` 는 Oracle 에서만, PostgreSQL 의 `$$` 본문·`RAISE NOTICE` 는 PostgreSQL 에서만, MySQL 의 백틱·`#` 주석·`DELIMITER` 는 MySQL 에서만 씁니다. PostgreSQL·MySQL 드라이버는 그 DB 에 처음 접속할 때 불러옵니다.

| 설정 | 설명 |
|---|---|
| `devBoost.dbConsole.pageSize` | 한 번에 가져오는 행 수 (기본 500). 콘솔 도구 줄에서도 바꿈 |
| `devBoost.dbConsole.maxRows` | 한 결과에 가져오는 최대 행 수 (기본 10,000, 200,000까지). `끝까지`도 여기까지 |
| `devBoost.dbConsole.checkConnectionSeconds` | 접속이 살아 있는지 서버에 다녀와 확인하는 간격(초, 기본 300, `0` 이면 끔) |
| `devBoost.dbConsole.sessionPerConsole` | 콘솔마다 따로 접속 (기본 켬). 끄면 모든 콘솔이 접속 하나를 같이 씀 |
| `devBoost.dbConsole.idleCloseMinutes` | 콘솔 2부터의 접속을 이 시간(분) 동안 안 쓰면 닫음 (기본 30, `0` 이면 닫지 않음). 커밋하지 않은 변경이 있으면 두고 |

### DB 스키마 · 테이블 정의서

두 가지로 가져옵니다.

- **DB 연결에서 바로 가져오기** — DB 콘솔에 등록한 연결을 골라 접두어만 넣으면 칸·제약·인덱스·주석을 바로 읽어 옴 (Oracle · PostgreSQL · MySQL)
- **쿼리 결과 붙여 넣기** — DB 에 접속할 수 없는 환경이면 화면이 알려 주는 쿼리를 다른 도구에서 실행하고 결과를 복사해 옴 (아래 순서)

1. 명령 팔레트(`Ctrl+Shift+P`) → `DB 스키마: 스키마 가져오기 · 테이블 정의서`
2. **범위**: 테이블 접두어 (`TB_`, 여러 개는 쉼표, 비우면 전체)와 환경(개발/운영 …)
3. **수집 쿼리** `▶ 워크시트에서 실행` → 결과 그리드 전체를 헤더와 함께 복사 → `클립보드에서 가져오기` (쿼리 하나에 기본값·PK·FK·인덱스까지 다 나옴)
4. **저장** → `.devboost/schema/<스키마>@<환경>.json`
5. **가져온 데이터**에서 테이블을 고르고 `테이블 정의서로 추출 (Excel)` → 저장 창에 파일 이름 입력 → 목차 시트 + 테이블마다 시트 (목차의 테이블명을 누르면 그 시트로)

- 결과가 많아 그리드가 일부 행만 복사하면 저장하지 않고 알려 줍니다 (끝까지 내려 다시 복사하거나 CSV 로 내보내 `파일에서 가져오기`)
- 회사·인터넷에서 쓰던 컬럼 명세 쿼리 결과(한글 별칭: 테이블명, 컬럼명, 데이터유형, 기본값 …)도 가져올 수 있습니다
- 규격과 수집 쿼리: [docs/SPEC-db-schema-v8-2026-10-26.md](docs/SPEC-db-schema-v8-2026-10-26.md)

### SQL 로그

VS Code 터미널에서 서버를 실행하면(`gradlew bootRun`, `mvn spring-boot:run`) 로그의 쿼리를 읽어 기억해 둡니다.

- **MyBatis 로그** (`==> Preparing` / `==> Parameters`): `?` 자리에 값을 채웁니다
- **log4jdbc 로그** (`jdbc.sqltiming`, `jdbc.sqlonly`): 값이 들어간 여러 줄 SQL 을 `{executed in N msec}` 까지 그대로 가져오고 실행 시간을 표시합니다
- **그 밖의 로그**: 로그 내용이 `SELECT`·`INSERT`·`UPDATE`·`DELETE`·`MERGE`·`WITH` 로 시작하면 다음 로그 줄 전까지를 쿼리로 읽습니다 (Hibernate, 사내 공통 로거 등). 값이 `?` 로 찍힌 것은 `? 값 없음` 으로 표시합니다
- 같은 실행을 여러 로그가 찍으면 한 건으로 합칩니다

```
==>  Preparing: SELECT * FROM TB_USER WHERE DEPT_CD = ? AND REG_DT >= ?
==> Parameters: D001(String), 2026-11-01 00:00:00.0(Timestamp)
→ SELECT * FROM TB_USER WHERE DEPT_CD = 'D001' AND REG_DT >= TIMESTAMP '2026-11-01 00:00:00.0'
```

- `Ctrl+Alt+L` 또는 상태바 `SQL n` 을 누르면 **고르는 창**이 열립니다 (명령 `SQL 로그: 최근 쿼리를 DB 콘솔로`)
  - 왼쪽 목록: 종류, 이름, 테이블, 건수·실행 시간, 넘어간 값이 보이는 조건 하나 / 오른쪽: 고른 쿼리의 전체 SQL
  - 찾기 칸에 테이블·칼럼·값을 적으면 SQL 전체에서 찾습니다. `↑` `↓` 로 옮기고 `Enter` 로 **새 DB 콘솔**에 옮깁니다. `Ctrl+C` 는 복사
  - 창을 연 순간의 목록(기본 10개, 새 것부터)을 그대로 보여 줍니다. 그 뒤 들어온 쿼리는 닫고 다시 열면 보입니다
- 상태바 `SQL n` 에 마우스를 올리면 최근 쿼리를 한 줄씩 보고 바로 옮길 수도 있습니다
- 옮기기만 하고 실행하지 않습니다. 콘솔에서 확인한 뒤 `Ctrl+Enter` 로 직접 실행
- 숫자는 그대로, 글자는 따옴표, 날짜는 `DATE '…'`·`TIMESTAMP '…'`, `null` 은 `NULL`
- 여러 요청이 섞여 찍혀도 같은 요청의 쿼리와 값끼리 맞춥니다

조건
- 쿼리가 로그에 찍혀야 합니다: MyBatis 는 mapper 로그 수준 DEBUG (예: `logging.level.com.example.mapper=debug`), log4jdbc 는 `jdbc.sqltiming` 또는 `jdbc.sqlonly` 로거
- 터미널의 셸 통합이 켜져 있어야 합니다 (VS Code 1.93 이상, PowerShell·Git Bash·bash·zsh. 명령 프롬프트(cmd)는 읽지 못함)
- 이 기능이 켜진 뒤에 시작한 명령부터 읽습니다. 쿼리는 메모리에만 두고 VS Code 를 닫으면 사라집니다
- 개수: `devBoost.sqlLog.maxQueries`

안 잡히는 로그가 있을 때
- `devBoost.sqlLog.loggers` 에 그 로그 줄에 항상 들어 있는 낱말(로거 이름 등)을 적습니다. 예: `["SQL_LOG"]` → 그 낱말 뒤부터 다음 로그 줄 전까지를 쿼리로 읽습니다
- SQL 이 아닌 로그가 섞여 잡히면 `devBoost.sqlLog.autoDetect` 를 끕니다

### import 따라가기

`import { UserType } from '@/types/user'` 로 가져온 `UserType` 을 `Ctrl+클릭`했을 때 같은 파일의 import 줄로만 가고, 다시 누르면 쓰던 곳으로 돌아오는 경우가 있습니다. 프로젝트의 tsconfig 에 경로 별칭(`paths`)이 없어 편집기가 `@/…` 를 풀지 못할 때입니다. 이 기능은 설정 파일을 건드리지 않고 별칭을 직접 풀어 실제 선언을 찾습니다.

- `Ctrl+클릭` — 실제 선언(type·interface·함수·상수·컴포넌트)으로 이동. import 줄의 이름이나 경로 글을 눌러도 됩니다
- 마우스를 올리면 선언 내용을 미리 봅니다
- `Ctrl+Alt+F12` — 실제 선언으로 바로 이동. `Ctrl+클릭`에서 import 줄과 실제 선언이 함께 목록으로 뜨면 이 키를 쓰세요
- `index.ts` 가 다시 내보낸 것(`export * from './user'`)은 따라가서 실제 선언까지 갑니다
- 템플릿의 컴포넌트 태그(`<UserCard>`, `<user-card>`)도 됩니다

별칭은 `vite.config` 의 `resolve.alias` → `tsconfig`/`jsconfig` 의 `paths` → 관례(`@`·`~` → `src`) 순으로 찾습니다. 맞지 않으면 개인 설정에 적습니다.

```json
"devBoost.importJump.aliases": { "@": "src", "@comp": "src/components" }
```

- 편집기가 이미 다른 파일의 선언을 찾아 주는 프로젝트에서는 아무것도 보태지 않습니다
- 미리 만드는 색인이 없습니다. 이름을 누르거나 올렸을 때 그 파일의 import 와 대상 파일만 읽습니다
- 끄면(`devBoost.importJump.enabled`) 편집기 원래 동작 그대로입니다

### API 콘솔

`Ctrl+Alt+A` (명령 `API 콘솔: 열기`) 로 엽니다. 자주 쓰는 API 를 모음으로 저장해 두고, 값만 바꿔 가며 보내 봅니다.

- **목록** — 모음 → 폴더 → 요청으로 정리합니다 (예: `결재 처리`, `메일 발송`). 두 번 누르면 이름 바꾸기, 끌어서 옮기기, `⋯` 에서 복제 · 내보내기 · 삭제
- **요청** — 메서드, 주소, 파라미터, 헤더, 본문(JSON · 글 · form · 파일 첨부), 인증(Bearer · Basic), 메모. `Ctrl+Enter` 로 보냅니다
- **응답** — 상태 · 시간 · 크기, JSON 접어 보기, 응답에서 찾기(`Enter` 다음), 헤더, 실제로 보낸 요청. `예시로 저장` 하면 요청과 함께 남습니다
- **환경** — `{{baseUrl}}`, `{{token}}` 같은 변수 묶음. 로컬 · 개발 · 운영을 만들어 바꿔 씁니다. 운영처럼 되돌릴 수 없는 곳은 "보내기 전에 확인"을 켜 두세요
- **쿠키** — 로그인 응답이 준 쿠키(세션)는 화면을 닫을 때까지 이어 보냅니다. `⋯ → 쿠키 비우기`
- **cURL** — 브라우저 개발자 도구에서 `Copy as cURL` 한 것을 주소 칸에 붙여넣으면 요청이 채워집니다. 반대로 `⋯ → cURL 로 복사`
- **가져오기 · 내보내기** — Postman 모음(v2) · 환경 파일을 가져옵니다. 내보내기 파일에는 환경 변수의 이름만 들어가고 값은 들어가지 않습니다

저장한 모음 · 환경 · 기록은 이 컴퓨터의 VS Code 저장 폴더에만 두고, 프로젝트 폴더에는 아무것도 만들지 않습니다. 환경 변수의 값(토큰 등)도 그 파일에 글 그대로 저장됩니다.

- 응답 대기 시간 `devBoost.apiConsole.timeoutSeconds`, 사설 인증서 서버 `devBoost.apiConsole.insecureTls`, 큰 응답 `devBoost.apiConsole.maxResponseMb`

## 설치

[Releases](https://github.com/powerkkim/vscode-devboost/releases)에서 `devboost-x.y.z.vsix`를 받아
확장 탭 `...` → **VSIX에서 설치** (또는 `code --install-extension devboost-x.y.z.vsix`).
새 버전도 같은 방법으로 설치하면 덮어써집니다.

## 개발

```bash
npm install
npm test            # 컴파일 + 단위 테스트
# 이 폴더를 VS Code로 열고 F5 → 새 창(Extension Development Host)에서 확인
npm run package     # → devboost-<version>.vsix
```

구조, 새 기능 추가 방법, 브랜치·릴리스 규칙은 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)를 보세요.

## 라이선스

[MIT](LICENSE)

함께 묶어 배포하는 오픈 소스 라이브러리(Vue, Babel, node-oracledb 등)의 저작권·라이선스 고지는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다. 빌드할 때 실제로 묶인 라이브러리에서 자동으로 만들어집니다.
