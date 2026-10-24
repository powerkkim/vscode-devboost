# Source Atlas 설계 계획 (v1, 2026-10-25)

Vue 3 `.vue` 파일 소스 구조를 분석해 Atlas(그래프)로 시각화하는 DevBoost 기능.

## 확정 사항
- 진입 기준: 에디터에서 열린 `.vue` 파일을 루트로, import를 따라 재귀 분석 (기본 깊이 3)
- 파일별로 `script setup` / `defineComponent` / Options API, JS/TS 자동 판별
- 스키마: 범용 그래프 (Node/Edge, kind·type 문자열). PLM과 무관하게 소스 구조 파악용
- 화면: Vue 3 + Vue Flow (노드=카드). 빌드는 esbuild 하나로 확장+Webview 동시 번들
- 번들 결과 `media/sourceAtlas/`는 git 커밋하지 않음

## 스키마
`src/features/sourceAtlas/analyzer/types.ts` 참고.

## 폴더 구조
```
src/features/sourceAtlas/
  index.ts
  analyzer/  (types, sfcParser, scriptExtractor, templateExtractor, resolver, graphBuilder)
  ui/        (atlasPanel)
webview/sourceAtlas/      Vue Flow 화면 소스
media/sourceAtlas/        번들 결과 (git 제외)
test/sourceAtlas/fixtures/
docs/
```

## import 경로 해석 순서
1. 상대경로 (확장자 생략, index.vue)
2. tsconfig/jsconfig `paths`
3. vite.config `resolve.alias` (텍스트 패턴 추출)
4. 설정 `devBoost.sourceAtlas.aliases`
5. 실패 시 `external` + `guess`

## 로드맵
| 단계 | 내용 |
|---|---|
| P0 | 실제 Vue 파일 샘플로 alias·패턴 확인 |
| P1 | 분석 엔진 + JSON 덤프 명령 + fixture 10종 테스트 |
| P2 | props/emits/composable/store/API 추출 |
| P3 | Webview Atlas (Vue Flow) — v0.9.0 후보 |
| P4 | 라우트 기준 진입, 증분 분석 |
| P5 | 데이터 흐름 뷰, 내보내기 |

## P1 테스트 fixture
1 script setup TS / 2 defineComponent / 3 Options API / 4 `@/` alias / 5 3단계 중첩+순환 / 6 composable / 7 Pinia / 8 axios·fetch·래퍼 / 9 `<component :is>` / 10 중복 사용

## 미결
- 실제 프로젝트의 alias 사용 여부 (resolver 4단계로 대응)
