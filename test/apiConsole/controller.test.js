// API 콘솔: Controller 의 매핑 메서드 → 요청. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const out = (...p) => path.join(__dirname, '..', '..', 'out', 'features', ...p);
const C = require(out('apiConsole', 'controller.js'));
const J = require(out('sourceAtlas', 'backend', 'javaParser.js'));
const S = require(out('apiConsole', 'springConfig.js'));

const CONTROLLER = `
package com.example.base.controller;

import com.example.base.dto.UserDto;
import java.util.List;

/**
 * 사용자 API
 */
@RestController
@RequestMapping("/api/base/users")
public class UserController {
    private final UserService userService;

    /** 사용자 목록을 조회한다. */
    @GetMapping
    public ResponseEntity<PageResult<UserDto>> list(UserSearch search, @RequestParam(defaultValue = "1") int page, @RequestParam(required = false) Integer size) {
        return ResponseEntity.ok(userService.list(search));
    }

    @Operation(summary = "사용자 한 건")
    @GetMapping("/{userId:[0-9]{1,9}}")
    public ResponseEntity<UserDto> get(@PathVariable("userId") Long id, @RequestHeader("X-Tenant") String tenant) { return null; }

    @PostMapping
    public ResponseEntity<UserDto> create(@Valid @RequestBody UserDto dto, HttpServletRequest request, @AuthenticationPrincipal LoginUser me) { return null; }

    @PutMapping(value = "/{userId}", consumes = "application/json")
    public ResponseEntity<UserDto> update(@PathVariable String userId, @RequestBody UserDto.Patch dto) { return null; }

    @PostMapping("/{userId}/photo")
    public void photo(@PathVariable Long userId, @RequestPart("file") MultipartFile file, @RequestPart("meta") PhotoMeta meta) {}

    @RequestMapping(value = "/bulk", method = RequestMethod.DELETE)
    public void bulk(@RequestBody List<Long> ids) {}

    @GetMapping(Paths.EXPORT)
    public void export(Pageable pageable) {}

    private void helper() {}

    public static class PhotoMeta { private String title; private Kind kind; }
    enum Kind { FACE, FULL("x"); private final String c; Kind() { } }
}
`;
const DTOS = `
package com.example.base.dto;
@Getter @Setter
public class UserDto extends BaseDto {
    private static final long serialVersionUID = 1L;
    private Long userId;
    @JsonProperty("user_name")
    private String userName;
    private boolean active;
    private LocalDate joinDate;
    private List<RoleDto> roles;
    private Map<String, Object> extra;
    @JsonIgnore private String secret;
    private UserDto manager;

    @Getter public static class Patch { private String userName; private BigDecimal salary; }
}
class RoleDto { private String code; private String[] scopes; }
class BaseDto { private String regId; private LocalDateTime regDt; }
class UserSearch { private String keyword; private Boolean active; private Range range; }
record Range(LocalDate from, LocalDate to) {}
`;
const all = [...J.parseJava(CONTROLLER, 'c.java', { detail: true }), ...J.parseJava(DTOS, 'd.java', { detail: true })];
const resolve = (name) => all.find((c) => c.name === name.split('.').pop());
const opts = { contextPath: '/plm', resolve, today: new Date(2026, 10, 14) };
const eps = C.readEndpoints(CONTROLLER, 'c.java');
const by = (name) => eps.find((e) => e.method.name === name);

test('매핑 메서드 읽기: 메서드 · 경로 · 이름 · 줄', () => {
  assert.deepStrictEqual(
    eps.map((e) => `${e.http} ${e.path}`),
    ['GET /api/base/users', 'GET /api/base/users/{userId}', 'POST /api/base/users', 'PUT /api/base/users/{userId}', 'POST /api/base/users/{userId}/photo', 'DELETE /api/base/users/bulk', 'GET /api/base/users']
  );
  assert.strictEqual(by('list').title, '사용자 목록을 조회한다.');
  assert.strictEqual(by('get').title, '사용자 한 건');
  assert.strictEqual(by('create').title, 'create');
  assert.strictEqual(by('get').origin, 'com.example.base.controller.UserController#get');
  // 이름이 같은 매핑 메서드는 둘째부터 번호
  assert.deepStrictEqual(C.readEndpoints('class A { @GetMapping("/a") void x() {} @PostMapping("/a") void x(String s) {} }', 'a.java').map((e) => e.origin), ['A#x', 'A#x~2']);
  assert.strictEqual(by('export').pathUnknown, true);
  assert.strictEqual(by('get').pathUnknown, false);
  // 어노테이션 줄부터 본문 끝까지가 그 메서드
  const lines = CONTROLLER.split('\n');
  assert.match(lines[by('get').method.startLine - 1], /@Operation/);
  assert.match(lines[by('list').method.endLine - 1], /^\s*}\s*$/);
  assert.strictEqual(C.readEndpoints('class A { void x() {} }', 'a.java').length, 0);
});

test('경로 모양: 정규식 · * 를 뗀다', () => {
  assert.strictEqual(C.plainPath('/a/{id:[0-9]{3}}/b/{*rest}/{x}'), '/a/{id}/b/{rest}/{x}');
  assert.strictEqual(C.annArg({ name: 'RequestParam', args: 'value = "q", required = false' }, 'value', 'name'), 'q');
  assert.strictEqual(C.annArg({ name: 'RequestParam', args: '"q"' }, 'value'), 'q');
  assert.strictEqual(C.annArg({ name: 'RequestParam', args: 'name = "a,b", defaultValue = "1"' }, 'defaultValue'), '1');
});

test('GET: 검색 조건 객체는 파라미터로 펴고, 선택 파라미터는 꺼 둔다', async () => {
  const r = await C.toRequest(by('list'), opts);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.url, '{{baseUrl}}/plm/api/base/users');
  assert.deepStrictEqual(
    r.params.map((p) => `${p.key}=${p.value}${p.enabled ? '' : ' (off)'}`),
    ['keyword= (off)', 'active= (off)', 'range.from= (off)', 'range.to= (off)', 'page=1 (off)', 'size= (off)']
  );
  assert.strictEqual(r.bodyMode, 'none');
  assert.strictEqual(r.origin, by('list').origin);
});

test('경로 값 · 헤더', async () => {
  const r = await C.toRequest(by('get'), opts);
  assert.strictEqual(r.url, '{{baseUrl}}/plm/api/base/users/{userId}');
  assert.deepStrictEqual(r.pathVars, [{ key: 'userId', value: '1', enabled: true }]);
  assert.deepStrictEqual(r.headers, [{ key: 'X-Tenant', value: '', enabled: true }]);
  assert.strictEqual(r.name, '사용자 한 건');
  const u = await C.toRequest(by('update'), opts);
  assert.deepStrictEqual(u.pathVars, [{ key: 'userId', value: '', enabled: true }]);
});

test('@RequestBody: DTO 필드로 JSON 뼈대 (부모 필드, @JsonProperty, @JsonIgnore, static, 목록, 자기 참조)', async () => {
  const r = await C.toRequest(by('create'), opts);
  assert.strictEqual(r.bodyMode, 'json');
  assert.deepStrictEqual(JSON.parse(r.bodyText), {
    regId: '',
    regDt: '2026-11-14T00:00:00',
    userId: 0,
    user_name: '',
    active: false,
    joinDate: '2026-11-14',
    roles: [{ code: '', scopes: [''] }],
    extra: {},
    manager: null,
  });
  assert.deepStrictEqual(r.params, []);
  // 안에 든 타입 (UserDto.Patch)
  assert.deepStrictEqual(JSON.parse((await C.toRequest(by('update'), opts)).bodyText), { userName: '', salary: 0 });
  assert.deepStrictEqual(JSON.parse((await C.toRequest(by('bulk'), opts)).bodyText), [0]);
  assert.strictEqual((await C.toRequest(by('bulk'), opts)).method, 'DELETE');
});

test('파일 첨부(multipart) · Pageable · 읽지 못한 것은 메모에', async () => {
  const p = await C.toRequest(by('photo'), opts);
  assert.strictEqual(p.bodyMode, 'multipart');
  assert.deepStrictEqual(p.bodyForm, [
    { key: 'file', value: '', enabled: true, file: true },
    { key: 'meta', value: '{"title":"","kind":"FACE"}', enabled: true },
  ]);
  assert.deepStrictEqual(p.pathVars, [{ key: 'userId', value: '1', enabled: true }]);
  const e = await C.toRequest(by('export'), opts);
  assert.deepStrictEqual(e.params.map((x) => x.key), ['page', 'size', 'sort']);
  assert.match(e.note, /경로가 상수/);
  // DTO 를 못 찾으면 빈 객체로 두고 메모에 적는다
  const blind = await C.toRequest(by('create'), { today: opts.today });
  assert.strictEqual(blind.bodyText, '{}');
  assert.match(blind.note, /읽지 못한 타입: UserDto/);
  assert.strictEqual(blind.url, '{{baseUrl}}/api/base/users');
});

test('쿠키로 받는 값 · 서버가 넣는 값은 메모에, 비어 있는 까닭은 한 줄로', async () => {
  const src = `package a;
import a.dto.AuthDto.LoginRequest;
@RestController @RequestMapping("/api/auth")
public class AuthController {
  @PostMapping("/refresh")
  public ResponseEntity<Token> refresh(@CookieValue(name = "refreshToken", required = false) String refreshToken, HttpServletRequest request, HttpServletResponse response) { return null; }
  @PostMapping("/login")
  public ResponseEntity<Token> login(
      @Valid
      @RequestBody final LoginRequest request,
      @AuthenticationPrincipal UserDetails me) { return null; }
  @PostMapping("/logout")
  public void logout(HttpServletRequest request) {}
  @PostMapping("/form")
  public void form(LoginForm form) {}
}`;
  const dto = J.parseJava('package a.dto; public class AuthDto { public static class LoginRequest { private String loginId; private String password; } }', 'AuthDto.java', { detail: true });
  const find = (name) => dto.find((c) => c.name === name.split('.').pop());
  const list = C.readEndpoints(src, 'AuthController.java');
  const req = async (name) => C.toRequest(list.find((e) => e.method.name === name), { resolve: find });

  const refresh = await req('refresh');
  assert.deepStrictEqual(refresh.headers, [{ key: 'Cookie', value: 'refreshToken=', enabled: false }]);
  assert.strictEqual(refresh.bodyMode, 'none');
  assert.match(refresh.note, /^AuthController\.refresh\(String, HttpServletRequest, HttpServletResponse\)/);
  assert.match(refresh.note, /- request: HttpServletRequest — 서버가 넣는 값/);
  assert.match(refresh.note, /- 쿠키 refreshToken: 브라우저 캡처로 이어받거나/);
  assert.strictEqual(C.warningOf(refresh), '쿠키 refreshToken 로 값을 받는 메서드');

  // 어노테이션이 여러 줄 · final 이 끼어도 본문을 채운다
  const login = await req('login');
  assert.deepStrictEqual([login.bodyMode, JSON.parse(login.bodyText)], ['json', { loginId: '', password: '' }]);
  assert.match(login.note, /- me: @AuthenticationPrincipal — 서버가 넣는 값/);
  assert.strictEqual(C.warningOf(login), '');

  assert.strictEqual(C.warningOf(await req('logout')), '파라미터 · 본문을 받지 않는 메서드');
  assert.strictEqual(C.warningOf(await req('form')), '읽지 못한 타입: LoginForm · form: LoginForm 의 필드를 읽지 못함');
});

test('Java 읽기(detail): 안에 든 타입, enum 상수, record, 파라미터 어노테이션 — 보통 읽기는 그대로', () => {
  const names = all.map((c) => c.name + (c.outer ? '<' + c.outer : ''));
  assert.deepStrictEqual(names, ['UserController', 'PhotoMeta<UserController', 'Kind<UserController', 'UserDto', 'Patch<UserDto', 'RoleDto', 'BaseDto', 'UserSearch', 'Range']);
  assert.deepStrictEqual(all.find((c) => c.name === 'Kind').enumConstants, ['FACE', 'FULL']);
  assert.deepStrictEqual(all.find((c) => c.name === 'Range').fields.map((f) => `${f.raw} ${f.name}`), ['LocalDate from', 'LocalDate to']);
  assert.strictEqual(all.find((c) => c.name === 'UserDto').fields.find((f) => f.name === 'roles').raw, 'List<RoleDto>');
  const plain = J.parseJava(CONTROLLER, 'c.java');
  assert.deepStrictEqual(plain.map((c) => c.name), ['UserController']);
  assert.strictEqual(plain[0].methods[0].params[0].anns, undefined);
  assert.strictEqual(plain[0].methods[0].startLine, undefined);
});

test('application.yml · properties 에서 포트와 context-path', () => {
  assert.deepStrictEqual(S.readSpringServer('spring:\n  application:\n    name: x\nserver:\n  port: 9090\n  servlet:\n    context-path: /plm\nlogging:\n  level: info\n', true), { port: 9090, contextPath: '/plm' });
  assert.deepStrictEqual(S.readSpringServer('server:\n  port: ${PORT:8081}\n', true), { port: 8081 });
  assert.deepStrictEqual(S.readSpringServer('server.port=7070\nserver.servlet.context-path=/app\n', false), { port: 7070, contextPath: '/app' });
  assert.deepStrictEqual(S.readSpringServer('spring.datasource.url=x\n', false), {});
});
