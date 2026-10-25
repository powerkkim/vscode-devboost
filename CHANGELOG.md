# Changelog

## 다음 버전 (작업 중)
- **DB 스키마** (명령 `DB 스키마: 스키마 가져오기 · 테이블 정의서`): DB 에 직접 접속하지 않고 테이블·컬럼·PK/UK/FK·인덱스·기본값 정보를 가져와 `.devboost/schema/<스키마>@<환경>.json` 에 저장
  - 화면에서 ① 테이블 접두어(`TB_` 등, 여러 개·전체 가능) → ② 본 쿼리 → ③ 기본값 쿼리 → ④ 저장 순서로 진행. 쿼리는 Oracle 워크시트로 보내 실행하거나 복사해 다른 도구에서 실행
  - 결과 그리드를 복사하고 `클립보드에서 가져오기` 한 번. 헤더 없이·행 번호 칸이 붙어 복사돼도 읽고, 그리드가 일부 행만 복사된 경우는 행 수 검증으로 막음
  - 접두어로 받으면 그 접두어 테이블만 교체 → 업무별로 나눠 받아 한 파일에 쌓을 수 있음
  - 회사에서 쓰던 컬럼 명세 쿼리 결과(CSV)도 별칭만 맞추면 가져옴
- **테이블 정의서 CSV**: 가져온 데이터에서 테이블을 골라 `테이블 정의서로 추출` → 목차 CSV + 정의서 CSV (Excel 에서 바로 열림). 컬럼 명세(No, 컬럼명, 설명, 타입, NULL, 기본값, PK, UK, FK 참조, 인덱스)와 테이블별 인덱스 목록
- **MyBatis SQL 실행·DB 스키마 공통**: Windows(CRLF)에서 워크시트에 넣은 SQL 의 선택 범위가 어긋나 일부만 실행되거나 다른 문장이 실행되던 문제 수정. 프로젝트의 `.sql` 파일에는 SQL 을 보내지 않음 (접속에서 연 워크시트·제목 없는 문서만)
- **DB 스키마** 가져오기 보완: 첫 행(SUMMARY) 없이 복사하면 저장하지 않음, 'REC' 라는 컬럼이 있는 테이블, 따옴표로 시작하는 코멘트·기본값, 본 쿼리+기본값을 한 번에 붙여 넣기, 전체로 받아 통째로 바꿀 때 확인, CP949 CSV, 정의서 CSV 의 `-`·`=` 로 시작하는 코멘트가 Excel 수식으로 열리던 문제
- **Source Atlas**: 백엔드 색인이 쓰는 메모리를 줄임 (Java 소스 22MB 프로젝트 기준 약 80MB → 25MB). 분석 결과는 같음
- **Source Atlas**: Atlas 화면을 닫으면 색인도 메모리에서 비움
- **Source Atlas**: 첫 분석(색인 만들기) 속도 개선 (같은 프로젝트 기준 약 3.3초 → 2.4초)

## 0.9.0 - 2026-10-25
- **MyBatis SQL 실행**: mapper XML 쿼리 위의 `▶ SQL 실행`(또는 `Ctrl+Alt+Enter`, 우클릭)으로 실행 화면을 열고, 파라미터 값을 넣으면 실행 가능한 SQL 이 바로 만들어짐
  - `<if>`·`<choose>`·`<where>`·`<set>`·`<trim>`·`<foreach>`·`<bind>`·`<include>`(다른 mapper 의 `<sql>` 조각, `<property>` 포함) 처리
  - 조건식은 값으로 자동 판단. 판단할 수 없는 식(정적 상수 등)은 꺼 두고 `?` 로 표시 → 켜기/끄기로 직접 지정. `모두 켜기`로 가장 긴 SQL 확인
  - 값 넣기(`'홍길동'`, `TO_DATE(...)`) / 바인드 변수 두 방식. 바인드 변수는 `VARIABLE`·`EXEC` 로 값을 넣는 스크립트를 만들어 워크시트에서 F5 로 실행 (값 다시 입력할 필요 없음, 날짜는 `TO_DATE(:이름, …)`)
  - `실행 계획` 버튼: 바인드 변수 형태의 SQL 로 실행 계획(F10) — 운영에서 MyBatis 가 실행하는 방식과 같은 조건
  - 입력값은 쿼리별로 기억, 같은 이름의 파라미터는 다른 쿼리에도 채워 줌
  - Oracle SQL Developer 워크시트로 보내기·실행 (마지막으로 쓴 워크시트, INSERT/UPDATE/DELETE 는 확인 후 실행)
  - 화면이 열려 있는 동안 꺼진 조건을 XML 에서 흐리게 표시
  - `'Y'` 처럼 한 글자 작은따옴표 비교(OGNL char), 빈 목록 foreach, `${}` 빈 값 등 실제 실행에서 문제 되는 부분을 경고
- `SQL 복사` CodeLens: 화면 없이 마지막 입력값으로 SQL 을 바로 복사
- **Source Atlas** (Vue 파일에서 우클릭 → `Atlas 화면 열기`): 열린 `.vue` 하나를 기준으로 연결 관계를 한 화면에 그림
  - 아래: 자식 컴포넌트, props·emits·slots, composable, Pinia store, axios·fetch API 호출
  - 서버까지: API URL → `@RestController` → Service(구현체) → MyBatis SQL → 읽기·쓰기 테이블 (워크스페이스에 Spring 컨트롤러가 있을 때)
  - 위: 이 컴포넌트를 쓰는 부모 컴포넌트와 라우트 (기본 3단계, `maxUpDepth`)
  - 노드를 클릭하면 오른쪽에 상세(사용하는 것·사용되는 곳), 더블클릭하면 해당 파일이 열림
  - vite.config / tsconfig 의 import alias 자동 인식 (`aliases` 로 직접 지정 가능)
  - 확실한 연결과 추정 연결(경로 일부 일치, 구현체 여러 개 등)을 구분해 표시

## 0.8.0 - 2026-10-24
저장소를 `editor-plugins`(모노레포) → **`vscode-devboost`**(VS Code 플러그인 전용)로 정리. 기능 변화는 없음.
- 저장소 최상위가 곧 플러그인: `src/core`, `src/features/searchEverywhere/{search,ui}`, `media/searchEverywhere`
- QuickPick 화면 코드를 `ui/quickPick.ts`로 분리
- 단위 테스트를 `test/`로 정식화 (`npm test`): 범위·파일 타입·포함/제외 경로·ripgrep 옵션 조합
- 릴리스 태그 `vscode-v*` → `v*`. 릴리스 전에 테스트를 먼저 돌림
- 개발 가이드 `docs/DEVELOPMENT.md`

## 0.7.1 - 2026-10-24
- 필터 단축키 `Alt+F` → `Alt+P`: Windows에서 `Alt+F`가 VS Code 파일 메뉴와 겹쳐 메뉴가 같이 열리던 문제

## 0.7.0 - 2026-10-24
- **포함/제외 경로 필터** (`필터` 버튼 / `Alt+F`, 0.7.1에서 `Alt+P`로 변경): 특정 폴더 아래만 검색하거나 일부 경로를 빼고 검색. 형식은 Ctrl+Shift+F의 files to include / exclude와 같음
  - `src/main/java/com/demo/module/order` → 그 폴더 아래 전부 · `./src` → 워크스페이스 바로 아래 src만 · `**/dto/**, *Test.java` → 패턴 · 쉼표로 여러 개
  - **현재 폴더** 버튼: 지금 보고 있는 파일의 폴더를 포함에 넣음 · **지우기** 버튼
  - 텍스트 검색은 포함 폴더에서만 ripgrep을 돌려 다른 폴더는 읽지 않음 (빠름). 파일·클래스·심볼 탭은 결과를 경로로 거름
  - 필터가 걸려 있으면 버튼에 점 표시. 결과를 열 때 쓴 포함 경로는 드롭다운에 최근 10개까지 기억
  - 범위 드롭다운과 함께 적용 (범위 → 포함/제외 순)
- 파일 타입 패턴을 **대소문자 무시**로 변경: `*mapper*.xml`이 `OrderMapper.xml`에도 맞음
- 파일 타입 드롭다운 기본 목록에 조합 추가: `*.java, *mapper*.xml, *.properties, *.yml` (Spring), `*.vue, *.ts, *.js` (Vue)
- 수정: 텍스트 탭에서 파일 타입과 "테스트 파일" 범위를 같이 고르면 두 조건이 OR로 묶여 결과가 넓게 나오던 문제 → AND로 적용

## 0.6.2 - 2026-10-24
- 설정 설명·플러그인 소개 문구 정리

## 0.6.1 - 2026-10-24
- **기본 UI를 `popup`(에디터 탭)으로** 변경. `panel`(Activity Bar 사이드바)은 설정으로 선택
- `ui` 설정을 바꾸면 왼쪽 Activity Bar 아이콘이 **즉시** 나타나거나 사라짐 (panel 선택 ↔ 해제)
- **제외 설정 정리**: `excludeGlob` + `libraryGlobs` → `exclude`(검색에서 완전히 뺌) + `library`(라이브러리 범위에서만 보임) 두 배열로 통합. 예전 키는 계속 인정
  - `exclude` 기본값 확대: node_modules, .git, target, build, out, dist, bin, .gradle, .mvn, .idea, .vscode, .settings, logs, coverage, *.log 등
  - **클래스·심볼 검색에도 `exclude` 적용** (target/generated-sources 등의 심볼이 섞이던 문제)

## 0.6.0 - 2026-10-24
- **범위 드롭다운** (IntelliJ 오른쪽 드롭다운): 프로젝트 파일 / 프로젝트 및 라이브러리 / 프로덕션(테스트 제외) / 테스트 / 최근에 본 파일 / 최근 변경된 파일(Git)
  - 클래스·파일·심볼·텍스트·모두 탭 모두에 적용. `Alt+N`: 프로젝트 ↔ 라이브러리 포함 전환
  - "비 프로젝트 항목 포함" 체크박스는 드롭다운으로 대체. 설정 `includeNonProject` → `defaultScope`
- **텍스트 탭**: 파일 타입(`*.java, *.xml`… 직접 입력 가능, 설정 `fileMasks`) + **Cc**(대소문자, `Alt+C`) **W**(단어 단위, `Alt+W`) **.\***(정규식, `Alt+X`)
- 최근에 본 파일은 에디터 전환 기록으로, 최근 변경된 파일은 VS Code 내장 Git의 작업 트리 변경 목록으로 판단

## 0.5.2 - 2026-10-24
- 왼쪽 Activity Bar의 DevBoost 아이콘은 `ui` 설정이 `panel`일 때만 표시 (popup/window/quickPick으로 바꾸면 사라짐)
- 뷰 ID 변경: 이전 버전에서 기억된 뷰 위치 때문에 탐색기 안에 붙던 문제 예방

## 0.5.1 - 2026-10-24
- 검색 화면 자리를 하단 패널 → **왼쪽 Activity Bar의 DevBoost 사이드바**로 변경 (Ctrl+Shift+F 검색처럼 독립 패널, 다른 패널과 섞이지 않음)
  - Shift 두 번 → 사이드바 열림 + 검색창 커서 · Enter/Esc → 사이드바 닫힘, 커서가 코드로 (Ctrl+B와 같음)
  - 필요하면 끌어서 오른쪽 사이드바나 하단으로 옮길 수 있음 (옮긴 경우 Esc로 닫히지는 않음)

## 0.5.0 - 2026-10-24
- **패널 방식을 기본으로**: Search Everywhere가 하단 패널(Problems/Output 옆)에 열림. 코드 창을 가리지 않고, 탭을 열었다 닫는 느낌이 없음. 탭 제목을 끌어서 왼쪽/오른쪽 사이드바로 옮길 수 있음
  - Shift 두 번 → 패널 열림 + 검색창에 커서 · Enter → 코드 자리에 파일 열림, 패널 접힘 · Esc → 패널 접힘, 커서가 코드로
  - 설정 `panelKeepOpen`: 패널을 접지 않고 유지
  - 접었다 펴도 화면을 다시 만들지 않아 창 열기 시간이 거의 0
- 탭/떠 있는 창/QuickPick 방식은 설정 `ui`로 선택 가능 (떠 있는 창은 VS Code 창 껍데기를 뗄 수 없어 실험으로만 남김)
- 내부: 탭·패널이 같은 화면 코드를 쓰도록 `webviewSession.ts`로 공통화

## 0.4.1 - 2026-10-24
- **(실험) 떠 있는 창 모드**: 설정 `devBoost.searchEverywhere.ui` = `window` → 검색 창을 별도 창으로 띄움
- **속도 측정 (개발용)**: 검색 창 하단에 단계별 소요 시간(언어서버 / 파일 / 텍스트 / 전체)과 창 열기 시간 표시, 출력 패널 "DevBoost"에 기록. 설정 `showTiming`으로 끄기
- 결과 목록을 드래그해도 글자가 블록 선택되지 않게 수정

## 0.4.0 - 2026-10-24
- **속도 개선**
  - 텍스트 검색을 VS Code 내장 **ripgrep**으로 변경 (VS Code 기본 검색과 같은 엔진, `.gitignore` 자동 반영). rg를 못 찾으면 기존 방식으로 자동 대체
  - '모두' 탭에서 언어 서버에 심볼을 두 번 요청하던 문제 수정 → 한 번 요청해 클래스/심볼로 나눔
  - 같은 검색어의 심볼 결과를 5초간 재사용 (탭 전환 시 재요청 없음)
- **심볼 검색 정리**
  - 새 설정 `libraryGlobs`: vendor, *.min.js 등은 라이브러리로 취급 → '비 프로젝트 항목 포함'을 끄면 제외 (bootstrap 함수, fontawesome CSS 클래스가 섞이던 문제)
  - 검색어 일치도 순으로 정렬, 프로젝트 항목 우선
  - 심볼 탭에 클래스도 포함 (IntelliJ와 동일), 종류별 배지 C / I / E / m / f / v
- **액션 탭 변경**: VS Code 명령 ID 목록 대신 "명령 팔레트 / 설정 / 단축키 설정"을 검색어가 채워진 상태로 열어줌. '모두' 탭에서는 액션 제외

## 0.3.0 - 2026-10-24
- Search Everywhere: **IntelliJ 모양 검색 창**(Webview) 추가, 기본값으로 사용
  - 상단 탭 바(모두/클래스/파일/심볼/액션/텍스트), `Tab`/`Shift+Tab`으로 탭 전환
  - "비 프로젝트 항목 포함(N)" 체크박스 (`Alt+N`)
  - 검색어 하이라이트, 오른쪽 `파일명 줄번호`, 하단 전체 경로 표시
  - 에디터에서 선택한 텍스트를 검색어로 미리 채움
  - `Esc` 또는 다른 곳 클릭 시 닫힘
- 설정 `devBoost.searchEverywhere.ui`로 기존 QuickPick 방식 선택 가능

## 0.2.1 - 2026-10-24
- Search Everywhere: **Shift 두 번**으로 열기 추가 (IntelliJ와 동일). 설정 `devBoost.searchEverywhere.doubleShift`로 끌 수 있음

## 0.2.0 - 2026-10-24
- 플러그인 이름을 `search-everywhere` → **DevBoost**로 변경, Search Everywhere는 첫 번째 기능으로 포함
- 기능별 켜기/끄기 설정 추가 (`devBoost.searchEverywhere.enabled`) — 끄면 명령·단축키가 사라지고 즉시 반영
- 설정 키 변경: `searchEverywhere.*` → `devBoost.searchEverywhere.*`

## 0.1.2 - 2026-10-24
- Search Everywhere '모두' 탭에 텍스트 매치 추가 (열린 파일 → src 우선 스캔)
- 라이브러리 클래스 중복(jar / sources jar) 제거
- QuickPick 자체 필터로 결과가 숨겨지던 문제 수정 (`t/` 접두어 등)

## 0.1.1 - 2026-10-24
- 클래스/심볼 검색에서 프로젝트 밖 항목(~/.m2, JDK) 기본 제외, "비 프로젝트 항목 포함" 토글 추가

## 0.1.0 - 2026-10-24
- 최초 버전: Search Everywhere (모두/클래스/파일/심볼/액션/텍스트)
