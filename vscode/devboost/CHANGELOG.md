# Changelog

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
