# Source Atlas 설계 계획 (v3, 2026-10-26)

> v2(2026-10-25) 대비 변경: **호출 전파(요약 기반 데이터 흐름) 분석**으로 API 추출 방식을 교체, **Vite 설정 프로브**(alias·proxy) 추가,
> 정확도 전략과 범용화 원칙 정리. 이 문서가 최신입니다. (v2: PLAN-source-atlas-v2-2026-10-25.md)

## 1. 정확도에 대한 원칙

- 분석은 **정적 분석**이다. 실행해야만 아는 값(동적 컴포넌트, 환경변수, 런타임 분기 결과)은 100% 알 수 없다.
- 목표는 100% 가 아니라 **"확실한 것은 실선, 모르는 것은 추정(점선)이나 미해석 목록"으로 정확히 구분**하는 것. 가장 나쁜 상태는 틀린 관계가 실선으로 그려지는 것.
- **이름이 아니라 동작으로 판정**한다. `api`, `http` 같은 이름이 아니라 "본문이 결국 axios/fetch 같은 끝점에 닿고, 자기 인자가 URL 자리로 흘러가는가"로 HTTP 래퍼를 알아낸다 → 프로젝트마다 다른 이름·계층에 그대로 동작.
- 프로젝트 관례(끝점 패키지, 전역 주입 `$http`, 프록시, context-path)는 코드가 아니라 **설정/프로필**로 뺀다.
- 해석 못 한 것은 조용히 빠뜨리지 않고 **"해석 못 한 호출" 목록**으로 보여 준다 → 새 프로젝트에서 어디를 보완할지 바로 보인다.

## 2. 호출 전파 분석 (analyzer/flow)

```
values.ts   기호 값: lit · concat · param · unknown(이유) · import · member · call · alt · obj · fn · sink · this · ext
summary.ts  모듈(파일) 하나 → 이름 붙은 함수마다 {calls(callee·args 를 기호 값으로), returns}. Babel 스코프로 import/지역/인자/구조분해 구분
engine.ts   요약을 이어 붙여 해석: import → 다른 모듈, call → 반환값, param → 호출자 인자로 치환, 끝점에 닿으면 Effect{method, url, chain}
```

- **진입점**: `<script setup>` 최상위(가상 함수 `<setup>`), 최상위 함수, Options API 의 methods·hooks·watch·setup.
- **끝점(sink)**: `axios`(및 `axios.create` 인스턴스 → baseURL 기억), `fetch`, `$fetch`/`ofetch`, `ky`, `XMLHttpRequest.open`, `this.$http` 류(추정).
- **잡는 것**: composable 반환 함수(구조 분해·객체 호출), Pinia setup/options 스토어 액션, 래퍼 N겹(`request(method, url)` 형태 포함), 상수 URL 객체·URL 함수, 템플릿 문자열, 삼항/`||`/`??` 분기(후보 모두), `axios(config)`/`.request(config)`, 같은 컴포넌트 안의 함수 호출, Options API `this.method()`.
- **정직하게 남기는 것**: 콜백 인자 호출, 함수 바깥 인자(클로저), `ref/computed` 값, 환경변수 → `unknown(이유)`. URL 에 남은 unknown 은 `{}` 로 표시되고 이유가 상세에 보인다. baseURL 이 불확실하면 붙이지 않고 "baseURL 미확정" 으로만 표시 (경로는 그대로 보이게).
- **폴백**: 함수를 찾았지만 본문에서 끝점에 못 닿았거나(클래스·미지원 문법) 호출 대상이 외부 패키지/전역 주입이면, 이름이 HTTP 래퍼 같고 URL 이 문자열일 때만 **추정** 효과. URL 까지 모르면 효과 대신 **미해석 목록**.
- **표시**: 컴포넌트 → API 선에 진입 함수 라벨(`save(), load()`), 상세 패널에 `경유 useOrder.load → request.get → request.request` (각 단계 클릭 → 그 줄로 이동). composable/store 노드를 거쳐 가는 호출은 **간접**(가는 점선)으로 그려 그 노드 → API 선과 중복임을 보이게 함. URL 이 인자뿐인 래퍼 함수는 API 노드를 만들지 않음.

## 3. Vite 프로브 (analyzer/viteProbe.ts + resources/viteProbe.mjs)

- 프로젝트의 `node_modules/vite` 로 `loadConfigFromFile` 을 **자식 node 프로세스**에서 실행 → `resolve.alias`, `server.proxy`(rewrite 는 표본 경로로 접두어 변화를 알아냄), `base`.
- 결과는 import 해석(alias)과 백엔드 매칭(프록시를 거친 경로를 먼저 비교, `meta.proxied` 표시)에 쓰인다.
- node/vite 가 없거나 실패·시간 초과(15초) → null → 기존 정적 해석(vite.config 텍스트 패턴)으로 폴백. 설정 `devBoost.sourceAtlas.vite.enabled` 로 끌 수 있음.
- 백엔드 `context-path` 는 설정(`backend.contextPath`) 또는 `application.yml/properties` 에서 찾아 매칭에 반영.

## 4. 남아 있는 한계 (다음 후보)

| 항목 | 상태 |
|---|---|
| 클래스 기반 API 클라이언트(`class Http { post() {} }`) | 미지원 → 이름 추정으로 폴백 |
| 분기(`?:`, `\|\|`)·`+=` 로 조합되는 URL | 후보를 모두 만들되 8개까지로 제한. `u = u + …` 자기 참조 누적 대입은 미해석 처리 |
| 함수·끝점 자체가 분기되는 값(`const f = c ? axios.get : axios.post`) | 소실(미해석에도 안 남음) |
| 클로저로 잡힌 바깥 인자(`useApi(base)` 의 `base`) | unknown |
| 템플릿 이벤트(`@click="save"`) → "이 버튼이 어떤 API 를 부른다" | 미구현 (요약 구조상 추가 용이) |
| Vuex(`this.$store.dispatch`) | 미지원 |
| 언어 서버(Volar·Java) 보정 | 있을 때만 쓰는 2단계로 설계 예정. 기본은 정적 분석 |
| Java 정규식 파서 → 실제 파서 | 다층 빈 체인 정확도를 위해 필요 |
| 업무형·eGov 유형 정답 fixture 로 누락/오탐 측정 | 미착수 (유형별 합성 fixture 코퍼스 계획) |

## 5. 설정

`devBoost.sourceAtlas.enabled / maxDepth / maxUpDepth / aliases / backend.enabled / backend.maxDepth / backend.contextPath / vite.enabled`

## 6. 테스트

`test/sourceAtlas/analyzer.test.js` — 기본 10종, 백엔드 B1~B8, 상위 U1~U2, 호출 위치 C1~C2, 심볼 위치 D1~D2, **호출 전파 F1~F7**, **Vite 프로브 V1~V2**, **재검토 엣지 케이스 R1~R5**(배럴 순환·enum·기본 인자·부분 baseURL·래퍼 자체 효과 제외·누적 대입·`+=`·options 스토어 this·메서드 미확정·라벨 병합·다이아몬드 호출 성능).
fixture: `app/`(기본), `viteapp/`, `fullstack/`(Vue+Spring+MyBatis), **`flow/`**(래퍼 2겹·composable·Pinia 두 방식·Options API·상수 URL·baseURL·삼항·콜백·순환·미해석, `edge/`·`diamond/`) + `.vite-shim/`(프로브 테스트용 가짜 vite).

## 7. 재검토 (2026-10-26)

구현 후 코드를 보지 않은 별도 검토에서 찾은 것과 처리:
- HIGH: `export *` 순환으로 스택 오버플로 → import 해석에 깊이·방문 가드 + 그래프 빌더에서 엔진 호출 try/catch
- HIGH: 자기 참조 `let` 재대입이 지수 시간(25줄에 43초) → 바인딩별 메모 + 자기 참조는 미해석
- HIGH: 다이아몬드 호출 그래프에서 경로 수가 곱으로 늘어 46k 행 → (함수, 인자) 효과 메모 + 행 dedupe
- MEDIUM: baseURL 리터럴 래퍼가 `GET /api/{}` 노드 생성, URL 모르는 확실한 호출이 조용히 사라짐, `+=` 를 `=` 로 취급, options 스토어 `this.action()` 미해석, 기본 인자값 무시, 메서드 미확정이 `GET` 확실로, 라벨 병합 4개 이상 깨짐 → 모두 수정(R1~R5 로 고정)
- Vite 프로브: stdout 마커·maxBuffer 16MB, vite 2(CJS) 폴백, target 객체 형태, `statSync` 예외 → 수정. 동기 spawn 15초 블로킹·`.env` 변경 시 캐시 stale 은 남은 과제
- 남김(LOW): 분기된 함수 값 소실, 클로저 바깥 인자, 파일당 Babel 2회 파싱(scriptExtractor + summary 통합 과제)
