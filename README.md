# DevBoost

개발할 때 자주 쓰는 편의 기능을 모은 VS Code 플러그인입니다. 기능마다 켜고 끌 수 있습니다.

## 기능

| 기능 | 단축키 | 켜기/끄기 설정 |
|---|---|---|
| **Search Everywhere** — 클래스·파일·심볼·텍스트 통합 검색 | `Shift` 두 번 / `Ctrl+Alt+Shift+F` | `devBoost.searchEverywhere.enabled` |
| **MyBatis SQL 실행** — mapper XML 쿼리를 값으로 풀어 Oracle 워크시트에서 실행 | `Ctrl+Alt+Enter` / 쿼리 위 `▶ SQL 실행` | `devBoost.mybatisRunner.enabled` |
| **Source Atlas** — 열린 Vue 파일의 컴포넌트·API·서버 흐름 화면 | Vue 파일 우클릭 → `Atlas 화면 열기` | `devBoost.sourceAtlas.enabled` |
| **DB 스키마** — 스키마 가져오기, 테이블 정의서(Excel) | 명령 `DB 스키마: 스키마 가져오기 · 테이블 정의서` | `devBoost.dbSchema.enabled` |
| **케이스 변환** — camel·snake·kebab 변환, SQL → Java 필드, Java → TypeScript·MyBatis SQL | 명령 팔레트 `케이스 변환:` / 선택 영역 우클릭 | `devBoost.caseConverter.enabled` |

기능을 끄려면 설정(`Ctrl+,`) → `DevBoost` 검색 → 체크 해제. 바로 반영됩니다.

### Search Everywhere

| 조작 | 키 |
|---|---|
| 탭 전환 (모두 / 클래스 / 파일 / 심볼 / 액션 / 텍스트) | `Tab` / `Shift+Tab` |
| 이동 · 열기 · 닫기 | `↑↓` `PageUp/Down` · `Enter` · `Esc` |
| 범위: 프로젝트 ↔ 라이브러리 포함 | `Alt+N` (오른쪽 위 드롭다운) |
| 포함/제외 경로 필터 | `Alt+P` |
| 텍스트 탭: 대소문자 · 단어 단위 · 정규식 | `Alt+C` · `Alt+W` · `Alt+X` |

- **범위 드롭다운**: 프로젝트 파일 / 프로젝트 및 라이브러리 / 프로덕션 / 테스트 / 최근에 본 파일 / 최근 변경된 파일(Git)
- **파일 타입**(텍스트 탭): 쉼표로 여러 패턴, 대소문자 무시. 예) `*.java, *mapper*.xml, *.vue, *.ts`
- **필터**: Ctrl+Shift+F 의 files to include / exclude 와 같은 형식
  - `src/main/java/com/demo/module/order` → 그 폴더 아래만 · `./src` → 워크스페이스 바로 아래 · `**/dto/**, *Test.java` → 패턴
  - `현재 폴더` 버튼: 지금 보는 파일의 폴더를 포함에 넣기
- **액션 탭**: 명령 팔레트 / 설정 / 단축키 설정을 검색어가 채워진 상태로 엽니다
- **결과 개수와 더 보기**: 탭마다 `maxResults`(기본 50)개씩 보여 주고, 더 있으면 끝에 `더 보기 — 123개 중 50개 표시`. 모두 탭은 종류별 머리글에 개수가 나오고 `더 보기`는 그 탭으로 이동
- 텍스트 검색은 최대 2,000건까지 모은 뒤 열린 파일 → `src` → 기타 → 라이브러리 순으로 정렬해 보여 줍니다. 2,000건을 넘으면 알려 주니 포함 경로·파일 타입으로 좁혀 보세요
- 에디터에서 단어를 선택한 채로 열면 그 단어로 바로 검색
- 텍스트 검색은 VS Code 내장 ripgrep 사용 (`.gitignore` 반영)
- 클래스·심볼: 프로젝트의 클래스(Java·Kotlin·TS/JS 등)와 Java 메서드·필드는 자체 색인으로 바로 찾습니다. 언어 서버가 없거나 준비 중이어도 나옵니다
- 언어 서버만 아는 것 — jar·JDK 안의 클래스(범위 *프로젝트 및 라이브러리*), TS·JS·Vue 메서드 — 은 기다리지 않고, 도착하면 목록에 이어서 붙습니다. 언어 서버에는 입력 중 1초에 한 번만 묻습니다

### 케이스 변환

| 명령 | 하는 일 |
|---|---|
| `케이스 변환 (camel · snake · kebab …)` | 선택한 이름(없으면 커서 아래 이름)을 camelCase · PascalCase · snake_case · SCREAMING_SNAKE_CASE · kebab-case · dot.case 로 바꿈. 여러 곳을 선택하면 한 번에 변환 |
| `SQL·컬럼 이름 → Java 필드` | mapper XML 쿼리의 SELECT 목록 · INSERT 컬럼 · `CREATE TABLE` · 컬럼 이름 목록 · 테이블 이름을 `private 타입 이름;` 으로 바꿈 |
| `Java 필드 → TypeScript 인터페이스` | 클래스·record·필드 몇 줄을 `export interface` 로 바꿈 (`List<X>` → `X[]`, 날짜 → `string` 등) |
| `Java 필드 → MyBatis SQL` | SELECT 컬럼 · INSERT · UPDATE · resultMap 생성 |

- 입력: 선택 영역 → (mapper XML 이면) 커서 위치 쿼리 → (`.sql`·`.java` 이면) 현재 파일 → 클립보드 순서. 같은 파일의 `<include refid>` 는 풀어서 반영
- 타입: `DB 스키마`로 스키마를 가져와 두었다면 실제 컬럼 타입·설명을 쓰고(`SELECT *`·테이블 이름만 넣어도 컬럼을 펼침), 없으면 컬럼 이름으로 추정
- 결과는 새 문서로 열림. 클립보드·선택 영역 아래 삽입으로 바꾸려면 설정 `devBoost.caseConverter.output`

### 설정

| 설정 | 설명 |
|---|---|
| `devBoost.searchEverywhere.ui` | 화면 방식: `popup`(에디터 탭, 기본) / `panel`(Activity Bar 사이드바) / `window`(별도 창) / `quickPick`(VS Code 기본 목록) |
| `devBoost.searchEverywhere.exclude` | 검색에서 **완전히 뺄** 경로 (모든 탭). 기본: `target`, `node_modules`, `build`, `.git`, 로그 등 |
| `devBoost.searchEverywhere.library` | **라이브러리로 취급**할 경로 → *프로젝트 및 라이브러리* 범위에서만 보임. 기본: `vendor`, `*.min.js` |
| `devBoost.searchEverywhere.defaultScope` | 창을 열 때 기본 범위 |
| `devBoost.searchEverywhere.fileMasks` | 파일 타입 드롭다운 목록 |
| `devBoost.searchEverywhere.doubleShift` | `Shift` 두 번으로 열기 |
| `devBoost.searchEverywhere.showTiming` | 검색 창 하단에 단계별 소요 시간 표시 (출력 패널 "DevBoost"에도 기록) |

### DB 스키마 · 테이블 정의서

DB 에 직접 접속하지 않습니다. 화면이 알려 주는 쿼리를 실행하고 결과를 복사해 오면 됩니다.

1. 명령 팔레트(`Ctrl+Shift+P`) → `DB 스키마: 스키마 가져오기 · 테이블 정의서`
2. **범위**: 테이블 접두어 (`TB_`, 여러 개는 쉼표, 비우면 전체)와 환경(개발/운영 …)
3. **수집 쿼리** `▶ 워크시트에서 실행` → 결과 그리드 전체를 헤더와 함께 복사 → `클립보드에서 가져오기` (쿼리 하나에 기본값·PK·FK·인덱스까지 다 나옴)
4. **저장** → `.devboost/schema/<스키마>@<환경>.json`
5. **가져온 데이터**에서 테이블을 고르고 `테이블 정의서로 추출 (Excel)` → 저장 창에 파일 이름 입력 → 목차 시트 + 테이블마다 시트 (목차의 테이블명을 누르면 그 시트로)

- 결과가 많아 그리드가 일부 행만 복사하면 저장하지 않고 알려 줍니다 (끝까지 내려 다시 복사하거나 CSV 로 내보내 `파일에서 가져오기`)
- 회사·인터넷에서 쓰던 컬럼 명세 쿼리 결과(한글 별칭: 테이블명, 컬럼명, 데이터유형, 기본값 …)도 가져올 수 있습니다
- 규격과 수집 쿼리: [docs/SPEC-db-schema-v8-2026-10-26.md](docs/SPEC-db-schema-v8-2026-10-26.md)

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
