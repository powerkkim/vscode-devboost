# 코드 생성 계획 v1 (2026-11-07)

테이블 정의에서 Java(DTO·Mapper·Service·Controller) + MyBatis XML + Vue(API·화면)를 만든다.
한 번에 전부(한 통) 또는 필요한 조각만.

> 이 문서는 **계획**이다. 아래 "정할 것"에 답을 받은 뒤 1단계부터 만든다.

---

## 1. 별도 플러그인으로 갈까?

**DevBoost 안의 기능(`src/features/codeGen/`)으로 둔다.** 설정 `devBoost.codeGen.enabled` 로 켜고 끈다.

| | DevBoost 안 | 별도 플러그인 |
|---|---|---|
| 테이블 정의 읽기 | DB 스키마(`.devboost/schema/*.json`)와 DB 콘솔 연결(`SchemaReader.collect`)을 그대로 씀 | 같은 것을 다시 만들거나, 두 확장 사이에 API 를 열어야 함 |
| 프로젝트 구조 파악 | Source Atlas 의 Java·MyBatis·Vue 파서, Search Everywhere 의 Spring 색인을 씀 | 다시 만들어야 함 |
| 만든 뒤 확인 | 만든 mapper 쿼리를 바로 `▶ 콘솔에서 실행` | 따로 |
| 무게 | 생성기는 글 조립뿐 (외부 라이브러리 없음). 명령을 처음 쓸 때만 불러옴 | 비슷 |
| 배포 | 지금 VSIX 하나 | 두 개 관리 |

나중에 팀 공용 템플릿 배포처럼 독립이 필요해지면 떼어 낼 수 있게, 생성기는 `TableModel`(아래 3절)만 받고 vscode·DB 모듈에 의존하지 않게 만든다.

---

## 2. 흐름

```
테이블 고르기 ──▶ 모델 만들기 ──▶ 조각 고르기 ──▶ 미리 보기 ──▶ 쓰기
(DB 연결 트리 /     (형 매핑·         (전체 또는       (파일마다,      (있는 파일은
 DB 스키마 화면)     이름 바꾸기)       일부)            기존과 비교)    묻고)
```

진입점:
- DB 연결 트리에서 테이블 오른쪽 클릭 → `코드 생성…` (여러 개 골라도 됨)
- DB 스키마 화면의 가져온 데이터에서 테이블 고르고 `코드 생성`
- 명령 팔레트 `DevBoost: 코드 생성`

화면(웹뷰 하나):
- 왼쪽: 고른 테이블, 테이블마다 이름(`PlmPart`)·URL(`/api/plm-parts`)·검색 조건 칸 고르기
- 가운데: 조각 체크 — `전체` / `백엔드만` / `프런트만` / 하나씩
- 오른쪽: 만들어질 파일 목록(새 파일·바뀜·같음), 누르면 미리 보기(이미 있으면 VS Code 비교 화면)
- `만들기`: 새 파일은 쓰고, 있는 파일은 **덮어쓰지 않고** 파일마다 묻는다(건너뛰기·덮어쓰기·비교 열기)

---

## 3. 모델 (생성기가 받는 것)

DB 스키마의 정규화된 정의(`TableInfo`·`ColumnInfo`·`ConstraintInfo`)에서 만든다. DB 종류는 형 매핑과 SQL 글에만 쓴다.

```ts
interface TableModel {
  db: 'oracle' | 'postgres' | 'mysql';
  table: string;            // TB_PLM_PART
  comment?: string;         // 부품 마스터
  entity: string;           // PlmPart        (접두어 TB_ 빼고 파스칼)
  var: string;              // plmPart
  path: string;             // plm-parts      (URL·Vue 파일 이름)
  columns: FieldModel[];
  pk: FieldModel[];         // 없으면 수정·삭제·단건 조회를 만들지 않고 알림
  key?: { kind: 'identity' | 'sequence' | 'none'; sequence?: string };
}
interface FieldModel {
  column: string;           // PART_NO
  field: string;            // partNo
  javaType: string;         // String, Long, BigDecimal, LocalDateTime …
  jdbcType: string;         // VARCHAR, NUMERIC, TIMESTAMP …
  tsType: string;           // string, number, boolean
  nullable: boolean;
  length?: number; precision?: number; scale?: number;
  comment?: string;         // 화면 라벨·Javadoc
  pk: boolean;
  audit?: 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt';  // 등록자·등록일 같은 공통 칸
}
```

### 형 매핑 (기본값, 설정으로 바꿈)

| DB 형 | Java | jdbcType |
|---|---|---|
| VARCHAR2·CHAR·VARCHAR·TEXT·CLOB | `String` | VARCHAR / CLOB |
| NUMBER(p,0) p≤9 · INT·INTEGER·int4 | `Integer` | INTEGER |
| NUMBER(p,0) p≤18 · BIGINT·int8 | `Long` | BIGINT |
| NUMBER(p,s) s>0 · NUMERIC·DECIMAL · NUMBER(정밀도 없음) | `BigDecimal` | NUMERIC |
| Oracle DATE (시각 포함) · TIMESTAMP · DATETIME | `LocalDateTime` | TIMESTAMP |
| PostgreSQL·MySQL DATE | `LocalDate` | DATE |
| BOOLEAN · MySQL TINYINT(1) | `Boolean` | BOOLEAN |
| BLOB·BYTEA·VARBINARY | `byte[]` | BLOB / BINARY |
| uuid | `UUID` (또는 String) | OTHER |
| json·jsonb | `String` | OTHER / VARCHAR |

- Oracle `CHAR(1)` 에 `Y/N` 을 쓰는 칸(`USE_YN` 처럼 이름이 `_YN` 로 끝남)은 `String` 그대로 두되 Vue 는 체크박스로
- 이름 바꾸기: 테이블 접두어(`TB_`, 여러 개) 빼기, 칸 `PART_NO` → `partNo`. 예약어(`class`, `default`)는 뒤에 `_`

---

## 4. 만드는 조각

`{base}` = 기본 패키지 (예: `com.example.plm`), `{Entity}` = `PlmPart`.

| 조각 | 파일 | 내용 |
|---|---|---|
| DTO | `{base}/dto/{Entity}Dto.java` | 칸마다 필드, 주석은 Javadoc, `@NotNull`(NOT NULL)·`@Size(max)` 선택. Lombok(`@Getter @Setter` 또는 `@Data`) 또는 getter/setter 직접, Java 17 이면 record 선택 |
| 검색 DTO | `{base}/dto/{Entity}SearchDto.java` | 고른 검색 칸 + `page`·`size`(·`sort`) |
| Mapper 인터페이스 | `{base}/mapper/{Entity}Mapper.java` | `@Mapper`. `selectList`·`selectCount`·`selectByKey`·`insert`·`update`·`delete` |
| Mapper XML | `resources/mapper/{...}/{Entity}Mapper.xml` | 아래 5절 |
| Service | `{base}/service/{Entity}Service.java` (+ `impl/…ServiceImpl.java` 선택) | `@Transactional(readOnly = true)` 조회, 쓰기 메서드 `@Transactional`, 없는 키 조회·수정은 예외 |
| Controller | `{base}/controller/{Entity}Controller.java` | `@RestController @RequestMapping("/api/{path}")`. `GET`(목록+건수), `GET /{key}`, `POST`, `PUT /{key}`, `DELETE /{key}`. 복합 키는 `/{k1}/{k2}`. 응답 감싸기(`ResponseEntity` 또는 프로젝트의 공통 응답 클래스) |
| Vue API | `src/api/{path}.(js\|ts)` | 프로젝트의 axios 인스턴스를 import 해서 함수 5개 |
| Vue 목록 화면 | `src/views/{path}/{Entity}List.vue` | `<script setup>`. 검색 폼 + 표 + 페이지 + 등록·수정·삭제 버튼 |
| Vue 입력 화면 | `src/views/{path}/{Entity}Form.vue` | 칸 형에 맞는 입력(글·숫자·날짜·Y/N), 필수·길이 검사 |
| 라우터 조각 | (파일 안 씀) | 붙여 넣을 route 객체를 복사 / 미리 보기에 보여 줌 |

"전체"는 위를 다, "부분"은 아무 조합이나. 이미 있는 Mapper XML 에 **쿼리 하나만 더하기**(예: 검색 조건 추가한 selectList)는 3단계.

---

## 5. Mapper XML 을 정확하게

MyBatis 쪽이 틀리면 실행해야 알 수 있어 가장 꼼꼼히 만든다.

```xml
<mapper namespace="com.example.plm.mapper.PlmPartMapper">
  <resultMap id="plmPartMap" type="com.example.plm.dto.PlmPartDto">
    <id     column="PART_NO" property="partNo" jdbcType="VARCHAR"/>
    <result column="PART_NM" property="partNm" jdbcType="VARCHAR"/>
  </resultMap>

  <sql id="columns">PART_NO, PART_NM, …</sql>
  <sql id="where">
    <where>
      <if test="partNo != null and partNo != ''">AND PART_NO = #{partNo}</if>
      <if test="partNm != null and partNm != ''">AND PART_NM LIKE '%' || #{partNm} || '%'</if>
    </where>
  </sql>

  <select id="selectList" resultMap="plmPartMap"> … 페이지 (DB 별) … </select>
  <select id="selectCount" resultType="long"> SELECT COUNT(*) FROM TB_PLM_PART <include refid="where"/> </select>
  <select id="selectByKey" resultMap="plmPartMap"> … WHERE PART_NO = #{partNo} </select>
  <insert id="insert"> … </insert>
  <update id="update"> UPDATE … <set><if …>…</if></set> WHERE … </update>
  <delete id="delete"> … </delete>
</mapper>
```

DB 마다 다른 것:

| | Oracle | PostgreSQL | MySQL |
|---|---|---|---|
| 페이지 | `OFFSET #{offset} ROWS FETCH NEXT #{size} ROWS ONLY` (12c+), 11g 는 `ROWNUM` 감싸기 선택 | `LIMIT #{size} OFFSET #{offset}` | `LIMIT #{offset}, #{size}` |
| LIKE 잇기 | `'%' \|\| #{x} \|\| '%'` | `'%' \|\| #{x} \|\| '%'` | `CONCAT('%', #{x}, '%')` |
| 새 키 | `<selectKey order="BEFORE">SELECT {SEQ}.NEXTVAL FROM DUAL</selectKey>` (시퀀스 이름 규칙 설정, 12c identity 면 `useGeneratedKeys`) | `useGeneratedKeys keyProperty` (serial·identity) | `useGeneratedKeys keyProperty` (AUTO_INCREMENT) |
| 날짜 기본값 | `SYSDATE` | `now()` | `NOW()` |

- NULL 이 될 수 있는 파라미터에는 `jdbcType` 을 붙인다 (Oracle 에서 `#{x}` 가 null 이면 오류 나는 문제)
- 등록자·등록일 같은 공통 칸은 이름 규칙(설정)으로 알아보고 INSERT 때는 `SYSDATE`/`now()`, UPDATE 의 `<set>` 에서는 빼거나 수정일만 넣는다
- 만든 XML 은 MyBatis Runner 의 파서로 다시 읽어 `#{}`·`<if>` 가 맞는지 확인하고, `▶ 콘솔에서 실행` 으로 바로 돌려 볼 수 있다

---

## 6. 프로젝트에 맞추기 (정확도의 핵심)

생성 코드가 프로젝트 관례와 다르면 결국 손으로 고친다. 그래서 **관례를 읽어 설정으로 저장**하고, 생성은 설정만 따른다.

1. 처음 쓸 때 `프로젝트 설정 읽기` — 읽어서 제안하고, 사용자가 확인·수정해 `.devboost/codegen.json` 에 저장 (예시는 `com.example` 같은 자리 표시로)
   - 기본 패키지: `@SpringBootApplication` 클래스 위치
   - Mapper XML 위치: `application.yml`·`properties` 의 `mybatis.mapper-locations`
   - 응답 감싸기: 기존 `@RestController` 반환형 중 가장 많은 것 (`ResponseEntity<T>`, `ApiResponse<T>` …)
   - Service 구조: 인터페이스 + Impl 인지, 클래스 하나인지
   - Lombok 사용 여부: `pom.xml`/`build.gradle` 의존성과 기존 DTO
   - 패키지 나눔: 계층별(`dto/`, `mapper/`…) 인지 업무별(`plm/part/dto`…) 인지 — 기존 Mapper 경로들로 판단
   - Vue: 프런트 폴더(`package.json` 에 vue), TS/JS, axios 인스턴스 파일(`src/api/index`·`http` 등에서 `axios.create`), UI 라이브러리(Element Plus·Vuetify·Naive·없음), 경로 별칭(`@/`)
2. 템플릿을 프로젝트에 꺼내 고칠 수 있다: `템플릿 꺼내기` → `.devboost/codegen/templates/*.tmpl`. 있으면 그것을, 없으면 내장 템플릿을 씀
   - 템플릿 글은 단순 치환 + 반복·조건만 (`{{entity}}`, `{{#each columns}}…{{/each}}`, `{{#if pk}}…{{/if}}`) — 라이브러리 없이 작은 엔진을 직접 둠
3. 내장 템플릿은 위 기본 관례 한 벌. 프로젝트 템플릿이 생기면 팀이 같은 결과를 얻는다(저장소에 커밋)

---

## 7. 확인 방법

- 단위 테스트: 형 매핑·이름 바꾸기·DB 별 XML 조각
- 골든 파일 테스트: 같은 테이블 정의(Oracle·PostgreSQL·MySQL 각 1벌, PK 하나·복합 PK·PK 없음)로 만든 결과를 저장해 두고 비교
- 컴파일 확인: 테스트에서 만든 Java 를 Spring·MyBatis 의 가짜 어노테이션 몇 개와 함께 `javac` 로 컴파일 (작업 환경에 JDK 있음), Vue 는 `vue-tsc`/파서로 문법 확인
- 실제 DB: 작업 환경의 PostgreSQL·MariaDB 로 만든 Mapper XML 쿼리를 MyBatis Runner 로 실행

---

## 8. 단계

| 단계 | 내용 | 가치 |
|---|---|---|
| 1 | 모델·형 매핑·이름, **DTO + Mapper 인터페이스 + Mapper XML**, 미리 보기·쓰기 화면 | 손으로 쓰기 가장 번거롭고 틀리기 쉬운 부분 |
| 2 | Service·Controller, 검색 DTO | 백엔드 한 통 |
| 3 | Vue API·목록·입력 화면, 라우터 조각 | 프런트까지 한 통 |
| 4 | 프로젝트 설정 읽기, 템플릿 꺼내기 | 프로젝트마다 정확하게 |
| 5 | 기존 파일에 더하기 (Mapper XML 에 쿼리 하나, DTO 에 칸 추가 — 테이블 칸이 바뀌었을 때 차이만) | 유지 보수 |

1·4 를 먼저 하는 방법도 있다(처음부터 프로젝트 관례로). 정할 것 1~3 의 답에 따라 정한다.

---

## 9. 정할 것 (Power 확인)

1. Java 버전과 Lombok — Java 17 + Lombok `@Getter @Setter`? `@Data`? record?
2. 응답 형식 — `ResponseEntity<T>` 그대로인가, 회사 공통 응답 클래스가 있는가 (있으면 이름·생성 방법)
3. Service — 인터페이스 + Impl 인가, 클래스 하나인가
4. 패키지 — 계층별(`dto/`·`mapper/`·`service/`·`controller/`) 인가, 업무별인가
5. Vue — JS/TS, UI 라이브러리(Element Plus 등), axios 인스턴스 위치, 목록·입력을 한 화면(다이얼로그)으로 할지 두 화면으로 할지
6. 페이지 방식 — 페이지 번호(page/size)인가, 화면이 전부 받아 나누는가
7. Oracle 키 — 시퀀스 이름 규칙(`SEQ_{테이블}` 등) 또는 identity
8. 공통 칸 — 등록자·등록일·수정자·수정일 칸 이름 (예: `REG_ID`, `REG_DT`, `UPD_ID`, `UPD_DT`)과 값 채우는 곳(SQL 에서 `SYSDATE`, 또는 Java 에서 세팅)
