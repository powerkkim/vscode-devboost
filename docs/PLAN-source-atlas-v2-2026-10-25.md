# Source Atlas 설계 계획 (v2, 2026-10-25)

> v1(2026-10-25) 대비 변경: 백엔드(Spring/MyBatis) 흐름 분석, 상위(부모·라우트) 분석, 빌드 방식 확정.
> 이 문서가 최신입니다. (v1: PLAN-source-atlas-v1-2026-10-25.md)

## 한 줄 요약
열려 있는 `.vue` 한 개를 기준으로 **아래**(자식 컴포넌트 · composable · store · API 호출 · 백엔드 Controller → Service → SQL → 테이블)와
**위**(이 컴포넌트를 쓰는 부모 · 라우트)를 함께 그려 주는 Atlas 화면.

## 분석 범위
| 방향 | 내용 | 조건 |
|---|---|---|
| 아래 (UI) | 자식 컴포넌트, props/emits/slots, ref·computed·watch, composable, Pinia store, axios/fetch API 호출 | 항상 |
| 아래 (서버) | API URL → `@RestController` 매핑 → Service(인터페이스→구현체) → MyBatis Mapper(XML/@Select) → SQL → 읽기/쓰기 테이블 | 워크스페이스에 컨트롤러가 있을 때만. 없으면 API 호출까지만 |
| 위 | 부모 컴포넌트(template 사용=확실 / import 만=추정), router 의 `component:` / `() => import()` 라우트 | 기본 3단계 (`maxUpDepth`, 0=끔) |

## 구조
```
src/features/sourceAtlas/
  pipeline.ts          열린 파일 → graphBuilder(아래) + reverse(위) + backend/attach(서버) 합성
  analyzer/            sfcParser · scriptExtractor · templateExtractor · resolver(alias) · graphBuilder · reverse · types
  backend/             javaParser · mybatisParser · sqlTables · pathMatch · indexer(캐시) · attach
  ui/atlasPanel.ts     Webview (ready / refresh / open 메시지)
webview/sourceAtlas/   Vue 3 + Vue Flow + dagre (esbuild 로 media/sourceAtlas/ 에 번들)
```
스키마는 범용 그래프(`AtlasNode{kind}` / `AtlasEdge{type, certainty}`) — Vue 와 Java 가 같은 JSON 을 채운다.

| kind | 설명 | edge type |
|---|---|---|
| component / composable / store / external | UI | uses, imports |
| api-call | axios/fetch 호출 | calls |
| route | 라우터 경로 (상위) | uses |
| controller / service / mapper(SQL) / table | 서버 | handles, calls, reads, writes |

## 매칭 규칙 (정확도 관련)
- URL: `{id}`·`${id}` → `{}` 로 정규화. 세그먼트 완전 일치=확실, 고정 문자열 자리에 프론트 변수가 오면 추정(`loose`), 컨텍스트 경로 차이(뒤쪽 일치)=추정(`suffix`).
- Spring 우선순위 반영: 고정 경로가 `{변수}` 경로보다 우선.
- Service 인터페이스는 구현체(최대 3개)로 해석 → 여러 개면 추정.
- 같은 클래스의 보조 메서드는 노드를 만들지 않고 호출자에 합쳐 따라간다.
- SQL: `<include>` 펼침, 동적 태그 제거, CDATA, `${schema}.` 접두 제거, CTE 이름 제외, 서브쿼리/JOIN/콤마 FROM.
- `sqlSession.selectOne("namespace.id")` 문자열 호출(레거시 DAO)도 추적.

## 알려진 한계 (다음 후보)
- 문자열 상수/변수로 만든 URL, 인터셉터로 붙는 baseURL 은 추정 매칭.
- Spring Data JPA Repository, QueryDSL, 동적 SQL 빌더(`@SelectProvider`)는 미지원.
- Java 는 정규식 기반이라 람다·익명 클래스 안쪽 호출은 일부 놓칠 수 있음.
- 부모 → 자식 `@event` 연결, 라우트 중첩 경로 합성(`children`)은 미지원.
- `src/test` 폴더와 `node_modules`·`target`·`build` 등은 분석에서 제외.

## 설정
`devBoost.sourceAtlas.enabled / maxDepth / maxUpDepth / aliases / backend.enabled / backend.maxDepth`

## 빌드
`npm run build` = 타입검사(tsc) + esbuild (확장 → `dist/extension.js`, 화면 → `media/sourceAtlas/app.js·css`).
`npm test` 는 기존대로 `tsc` 컴파일 + `node --test`.

## 로드맵
| 단계 | 상태 |
|---|---|
| P1 분석 엔진 + 테스트 | 완료 |
| P3 Atlas 화면 | 완료(초안) |
| 상위 분석, 백엔드 흐름 | 완료(초안) — 실제 업무 소스로 검증 필요 |
| P4 라우트 기준 진입, 파일 저장 시 증분 갱신 | 예정 |
| P5 내보내기(SVG/PNG/Markdown), 데이터 흐름 뷰 | 예정 |
