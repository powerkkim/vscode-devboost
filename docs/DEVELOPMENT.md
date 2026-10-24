# 개발 가이드

## 폴더 구조

```
vscode-devboost/
├─ .github/workflows/
│  └─ release.yml           태그 v* push: 테스트 → .vsix 를 GitHub Release에 첨부
├─ .vscode/                 F5(launch.json), 컴파일 작업(tasks.json)
├─ src/
│  ├─ extension.ts          진입점. 기능 목록(FEATURES)만 관리
│  ├─ core/
│  │  └─ feature.ts         기능 하나의 형태(Feature). 설정 devBoost.<id>.enabled 로 켜고 끔
│  └─ features/
│     └─ searchEverywhere/
│        ├─ index.ts        명령·단축키 등록, 화면 방식(ui 설정)에 따라 열기
│        ├─ search/         검색 로직 — vscode 화면과 무관
│        │  ├─ searchService.ts   탭별 검색, 범위·필터 적용, 속도 측정
│        │  ├─ ripgrep.ts         rg 실행·결과 파싱 (vscode 의존 없음)
│        │  ├─ scope.ts           범위·파일 타입·경로 규칙 (vscode 의존 없음)
│        │  ├─ glob.ts            glob → 정규식 (vscode 의존 없음)
│        │  └─ recent.ts          최근 본 파일, Git 변경 파일
│        └─ ui/             화면
│           ├─ webviewSession.ts  Webview 화면과 확장 사이 메시지 처리, HTML
│           ├─ webviewPanel.ts    에디터 탭 / 별도 창으로 열기 (ui = popup, window)
│           ├─ panelView.ts       Activity Bar 사이드바 (ui = panel)
│           └─ quickPick.ts       VS Code 기본 목록 (ui = quickPick)
├─ media/
│  └─ searchEverywhere/     Webview 안에서 도는 화면 JS·CSS
├─ test/                    단위 테스트 (node --test). out/ 의 컴파일 결과를 불러 검사
│  ├─ helpers.js            임시 샘플 프로젝트 생성, rg 찾기
│  └─ searchEverywhere/
└─ docs/
```

**vscode 의존 없음** 표시가 붙은 파일은 VS Code 없이 Node만으로 테스트할 수 있게 일부러 분리한 것입니다.
검색 규칙을 고칠 때는 이쪽에 넣고 `test/`에 케이스를 추가하세요.

## 개발 흐름

```bash
npm install          # 처음 한 번, package.json 의존성이 바뀌었을 때
npm run watch        # 저장할 때마다 자동 컴파일 (선택)
npm test             # 컴파일 + 단위 테스트
```

- **F5**: 새 VS Code 창(Extension Development Host)이 플러그인을 단 채로 뜬다. 거기서 Java 프로젝트를 열고 확인
- 코드를 고친 뒤에는 디버그 도구 막대의 🔄(다시 시작)
- `package.json`(명령·설정·단축키)을 바꿨으면 테스트 창을 다시 띄워야 반영된다

### ripgrep 테스트

`test/searchEverywhere/ripgrep.test.js`는 실제 rg로 검색해 본다. rg 위치는 이 순서로 찾고, 없으면 건너뛴다.

1. 환경변수 `RG_PATH`
2. `PATH`의 `rg`
3. VS Code 설치 폴더 안의 rg (`%LOCALAPPDATA%\Programs\Microsoft VS Code\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe` 등)

## 새 기능 추가

1. `src/features/<기능>/index.ts`에 `Feature` 구현 — `start(context)`가 등록한 것(명령, 이벤트 등)을 Disposable 배열로 돌려준다
2. 로직은 `src/features/<기능>/<영역>/`, 화면은 `ui/`로 나눈다
3. `src/extension.ts`의 `FEATURES`에 추가
4. `package.json`
   - 설정 `devBoost.<기능>.enabled` (기본 true)
   - `contributes.commands` + `menus.commandPalette`의 `when: config.devBoost.<기능>.enabled` (끄면 명령 숨김)
   - 단축키에도 같은 `when`
5. `test/<기능>/`에 테스트, `CHANGELOG.md`에 기록

## 알아 둘 VS Code 동작

- **뷰 ID는 위치 기억의 키**: 사용자가 뷰를 어디로 옮겼는지 VS Code가 뷰 ID로 저장한다. 뷰의 기본 자리를 바꿀 때는 ID도 바꿔야 옛 위치가 적용되지 않는다
- **`when` 조건과 설정**: 설정값이 바뀌어도 바로 반영돼야 하는 표시(Activity Bar 아이콘 등)는 `setContext`로 context key를 직접 갱신한다
- **Windows 메뉴 단축키**: `Alt+F/E/S/V/G/R/T/H`는 메뉴 막대가 먼저 가져간다. Webview 안의 `Alt+` 단축키는 이 글자를 피한다
- **`.vscode/`, `.github/workflows/` 폴더**: 원격 도구로는 쓸 수 없게 막혀 있다. 이 폴더는 직접 고친다

## 브랜치와 릴리스

| 브랜치 | 용도 |
|---|---|
| `main` | 확인을 마친 릴리스 코드만. `develop` → `main` PR을 확인한 뒤 merge |
| `develop` | 작업이 모이는 곳. 합치기 전에 로컬에서 `npm test` |
| `feature/…`, `refactor/…` | 기능·정리 작업. 끝나면 `develop`으로 |

릴리스 순서:

1. `package.json`의 `version`을 올린다
2. `CHANGELOG.md`에 `## x.y.z - YYYY-MM-DD` 섹션을 쓴다 (이 내용이 Release 설명이 된다)
3. `develop` → `main` 으로 합친다
4. `main`에서 태그: `git tag vx.y.z && git push origin vx.y.z`
5. GitHub Actions가 테스트 → `.vsix` 생성 → Release 첨부. 태그와 `package.json` 버전이 다르면 실패한다
