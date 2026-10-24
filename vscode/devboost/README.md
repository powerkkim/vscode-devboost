# DevBoost (VS Code)

IntelliJ의 편리한 기능들을 VS Code에서 쓸 수 있게 모은 플러그인입니다. 기능마다 켜고 끌 수 있습니다.

## 기능

| 기능 | 단축키 | 설정 (켜기/끄기) |
|---|---|---|
| Search Everywhere — 모두/클래스/파일/심볼/액션/텍스트 통합 검색 | `Shift` 두 번 / `Ctrl+Alt+Shift+F` | `devBoost.searchEverywhere.enabled` |

기능을 끄려면: 설정(`Ctrl+,`) → `DevBoost` 검색 → 체크 해제. 즉시 반영됩니다.

### Search Everywhere 사용법
- `Tab` / `Shift+Tab`: 탭 전환 · `↑↓` `PageUp/Down`: 이동 · `Enter`: 열기 · `Esc`: 닫기
- `Alt+N`: "비 프로젝트 항목 포함" 토글 — 프로젝트 밖(~/.m2, JDK)과 `libraryGlobs` 경로(vendor, *.min.js 등)
- 액션 탭: 명령 팔레트 / 설정 / 단축키 설정을 검색어가 채워진 상태로 엽니다
- 텍스트 검색은 VS Code 내장 ripgrep 사용 (`.gitignore` 반영)
- 에디터에서 단어를 선택하고 열면 그 단어로 바로 검색
- 화면 방식: 설정 `devBoost.searchEverywhere.ui` — `popup`(IntelliJ 모양, 기본) / `quickPick`(VS Code 기본 목록. 접두어 `c/` `f/` `s/` `a/` `t/` 지원)
- 클래스·심볼 탭은 언어 플러그인(Java라면 *Extension Pack for Java*)이 필요합니다.

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
