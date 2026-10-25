# DevBoost

개발할 때 자주 쓰는 편의 기능을 모은 VS Code 플러그인입니다. 기능마다 켜고 끌 수 있습니다.

## 기능

| 기능 | 단축키 | 켜기/끄기 설정 |
|---|---|---|
| **Search Everywhere** — 클래스·파일·심볼·텍스트 통합 검색 | `Shift` 두 번 / `Ctrl+Alt+Shift+F` | `devBoost.searchEverywhere.enabled` |
| **MyBatis SQL 실행** — mapper XML 쿼리를 값으로 풀어 Oracle 워크시트에서 실행 | `Ctrl+Alt+Enter` / 쿼리 위 `▶ SQL 실행` | `devBoost.mybatisRunner.enabled` |
| **Source Atlas** — 열린 Vue 파일의 컴포넌트·API·서버 흐름 화면 | Vue 파일 우클릭 → `Atlas 화면 열기` | `devBoost.sourceAtlas.enabled` |
| **DB 스키마** — 스키마 가져오기, 테이블 정의서(CSV) | 명령 `DB 스키마: 스키마 가져오기 · 테이블 정의서` | `devBoost.dbSchema.enabled` |

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
- 에디터에서 단어를 선택한 채로 열면 그 단어로 바로 검색
- 텍스트 검색은 VS Code 내장 ripgrep 사용 (`.gitignore` 반영)
- 클래스·심볼 탭은 언어 플러그인이 필요합니다 (Java라면 *Extension Pack for Java*)

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
3. **본 쿼리** `▶ 워크시트에서 실행` → 결과 그리드 전체를 헤더와 함께 복사 → `클립보드에서 가져오기`
4. **기본값 쿼리**도 같은 방법 (Oracle 이 기본값을 LONG 으로 저장해 따로 받음. 나중에 해도 됨)
5. **저장** → `.devboost/schema/<스키마>@<환경>.json`
6. **가져온 데이터**에서 테이블을 고르고 `테이블 정의서로 추출 (CSV)` → 목차 CSV + 정의서 CSV

- 결과가 많아 그리드가 일부 행만 복사하면 저장하지 않고 알려 줍니다 (끝까지 내려 다시 복사하거나 CSV 로 내보내 `파일에서 가져오기`)
- 규격과 수집 쿼리: [docs/SPEC-db-schema-v7-2026-10-26.md](docs/SPEC-db-schema-v7-2026-10-26.md)

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
