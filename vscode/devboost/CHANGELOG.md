# Changelog

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
