# DevBoost (VS Code)

개발할 때 자주 쓰는 편의 기능을 모은 VS Code 플러그인입니다. 기능마다 켜고 끌 수 있습니다.

## 기능

| 기능 | 단축키 | 설정 (켜기/끄기) |
|---|---|---|
| Search Everywhere — 모두/클래스/파일/심볼/액션/텍스트 통합 검색 | `Shift` 두 번 / `Ctrl+Alt+Shift+F` | `devBoost.searchEverywhere.enabled` |

기능을 끄려면: 설정(`Ctrl+,`) → `DevBoost` 검색 → 체크 해제. 즉시 반영됩니다.

### Search Everywhere 사용법
- `Tab` / `Shift+Tab`: 탭 전환 · `↑↓` `PageUp/Down`: 이동 · `Enter`: 열기 · `Esc`: 닫기
- 범위 드롭다운(오른쪽 위): 프로젝트 파일 / 프로젝트 및 라이브러리 / 프로덕션 / 테스트 / 최근에 본 파일 / 최근 변경된 파일. `Alt+N`으로 프로젝트 ↔ 라이브러리 포함 전환
- 텍스트 탭: 파일 타입 + `Cc`(Alt+C) `W`(Alt+W) `.*`(Alt+X)
  - 쉼표로 여러 패턴: `*.java, *mapper*.xml, *.vue, *.ts` (하나라도 맞으면 검색, 대소문자 무시)
- `필터`(Alt+P): 포함/제외 경로. Ctrl+Shift+F의 files to include / exclude와 같은 형식
  - `src/main/java/com/demo/module/order` 그 폴더 아래만 · `./src` 워크스페이스 바로 아래 · `**/dto/**, *Test.java` 패턴 제외
  - `현재 폴더` 버튼으로 지금 보는 파일의 폴더를 바로 넣기
- 액션 탭: 명령 팔레트 / 설정 / 단축키 설정을 검색어가 채워진 상태로 엽니다
- 텍스트 검색은 VS Code 내장 ripgrep 사용 (`.gitignore` 반영)
- 에디터에서 단어를 선택하고 열면 그 단어로 바로 검색
- 화면 방식: 설정 `devBoost.searchEverywhere.ui` — `popup`(에디터 탭, 기본) / `panel`(왼쪽 Activity Bar의 DevBoost 사이드바, 끌어서 오른쪽/하단으로 이동 가능) / `window`(별도 창) / `quickPick`(VS Code 기본 목록, 코드 위 팝업. 접두어 `c/` `f/` `s/` `a/` `t/` 지원)
- 속도 확인: 검색 창 하단 오른쪽 숫자, 또는 보기 → 출력 → "DevBoost" (설정 `showTiming`)
- 클래스·심볼 탭은 언어 플러그인(Java라면 *Extension Pack for Java*)이 필요합니다.

### 제외 설정 (설정 → `DevBoost` 검색)
| 설정 | 뜻 | 예 |
|---|---|---|
| `devBoost.searchEverywhere.exclude` | 검색에서 **완전히 뺌** (모든 탭) | `target`, `node_modules`, `build`, 로그 |
| `devBoost.searchEverywhere.library` | 라이브러리로 취급 → *프로젝트 및 라이브러리* 범위에서만 보임 | `vendor`, `*.min.js` |

## 개발

```bash
npm install
npm run compile     # 또는 npm run watch
# VS Code에서 이 폴더를 열고 F5 → Extension Development Host 창에서 테스트
npm run package     # → devboost-<version>.vsix
```

### 새 기능 추가 순서
1. `src/features/<기능>/index.ts` 에 `Feature` 구현 (`start()`가 Disposable 목록 반환)
2. `src/extension.ts` 의 `FEATURES` 배열에 추가
3. `package.json` 에 `devBoost.<기능>.enabled` 설정, 커맨드, `when` 조건 추가
4. `CHANGELOG.md` 기록

## 릴리스
`package.json` version 올림 → `CHANGELOG.md` 기록 → 커밋 → `git tag vscode-v<version> && git push origin vscode-v<version>`
