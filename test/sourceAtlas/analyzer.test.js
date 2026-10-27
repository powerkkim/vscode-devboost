// Source Atlas 분석기 테스트. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { buildAtlasGraph } = require('../../out/features/sourceAtlas/analyzer/graphBuilder.js');
const { parseViteAliases } = require('../../out/features/sourceAtlas/analyzer/resolver.js');

const FIX = path.join(__dirname, 'fixtures');
const APP = path.join(FIX, 'app');
const at = (rel, opts = {}) => buildAtlasGraph(path.join(APP, rel), { workspaceRoot: FIX, ...opts });
const node = (g, suffix) => g.nodes.find((n) => n.id.endsWith(suffix));
const edge = (g, fromSuffix, toSuffix, type) =>
  g.edges.find((e) => e.from.endsWith(fromSuffix) && e.to.endsWith(toSuffix) && (!type || e.type === type));

test('1. script setup + TS: props/emits/ref/computed/watch 추출', () => {
  const g = at('src/views/Basic.vue');
  const n = node(g, 'views/Basic.vue');
  assert.strictEqual(n.meta.style, 'script-setup');
  assert.strictEqual(n.meta.lang, 'ts');
  assert.deepStrictEqual(n.meta.props.map((p) => [p.name, p.required]), [['title', true], ['count', false]]);
  assert.deepStrictEqual(n.meta.emits, ['select', 'refresh']);
  assert.ok(n.meta.refs.includes('keyword'));
  assert.deepStrictEqual(n.meta.computed, ['total']);
  assert.deepStrictEqual(n.meta.watchers, ['keyword']);
  assert.deepStrictEqual(n.meta.slots, ['footer']);
});

test('2. defineComponent: 스타일 판별 + 런타임 props/emits', () => {
  const g = at('src/views/Basic.vue');
  const n = node(g, 'components/ChildCard.vue');
  assert.strictEqual(n.meta.style, 'define-component');
  assert.deepStrictEqual(n.meta.props.map((p) => [p.name, !!p.required]), [['item', true], ['mode', false]]);
  assert.deepStrictEqual(n.meta.emits, ['close', 'save']);
  assert.ok(edge(g, 'ChildCard.vue', 'GrandChild.vue', 'uses'), 'components 옵션 등록 → template 사용');
});

test('3. Options API: props 배열, emits 객체, components 옵션', () => {
  const g = at('src/views/Basic.vue');
  const n = node(g, 'components/OrderList.vue');
  assert.strictEqual(n.meta.style, 'options');
  assert.deepStrictEqual(n.meta.props.map((p) => p.name), ['items', 'status']);
  assert.deepStrictEqual(n.meta.emits, ['change']);
  assert.ok(edge(g, 'OrderList.vue', 'GrandChild.vue', 'uses'), 'Deep 로 등록된 컴포넌트');
});

test('4. 경로 해석: 상대경로, jsconfig paths(@/), vite alias, 외부 패키지', () => {
  const g = at('src/views/Basic.vue');
  assert.ok(edge(g, 'Basic.vue', 'components/ChildCard.vue', 'uses'), '@/ (jsconfig paths + JSONC)');
  assert.ok(edge(g, 'Basic.vue', 'components/OrderList.vue', 'uses'), '상대경로 + kebab-case 태그');

  const v = buildAtlasGraph(path.join(FIX, 'viteapp/src/views/Home.vue'), { workspaceRoot: FIX });
  assert.ok(edge(v, 'Home.vue', 'ui/Panel.vue', 'uses'), 'vite alias @');
  assert.ok(edge(v, 'Home.vue', 'ui/Btn.vue', 'uses'), 'vite alias ~ui');

  const ext = g.nodes.find((n) => n.kind === 'external');
  assert.strictEqual(ext.label, 'element-plus');
  assert.ok(edge(g, 'Basic.vue', 'element-plus', 'uses'));
  assert.deepStrictEqual(node(g, 'Basic.vue').meta.unresolvedTags, ['MyGlobalWidget']);
});

test('4b. vite.config alias 텍스트 파서', () => {
  const rules = parseViteAliases("resolve: { alias: { '@': path.resolve(__dirname, 'src'), } }", '/p');
  assert.strictEqual(rules[0].prefix, '@');
  assert.ok(rules[0].targets[0].endsWith(path.join('p', 'src')));
  const arr = parseViteAliases("alias: [{ find: '@', replacement: '/src' }]", '/p');
  assert.strictEqual(arr[0].prefix, '@');
});

test('5. 깊이 제한 + 순환 import 방지', () => {
  const g = at('src/views/Basic.vue', { maxDepth: 3 });
  // Basic(0) → ChildCard(1) → GrandChild(2) → DeepChild(3) → TooDeep(4, 펼치지 않음)
  assert.strictEqual(node(g, 'TooDeep.vue').meta.truncated, true);
  assert.ok(edge(g, 'DeepChild.vue', 'ChildCard.vue'), '순환 엣지는 기록');
  assert.strictEqual(g.nodes.filter((n) => n.id.endsWith('ChildCard.vue')).length, 1);
  const deeper = at('src/views/Basic.vue', { maxDepth: 4 });
  assert.ok(!node(deeper, 'TooDeep.vue').meta.truncated);
  assert.ok(node(deeper, 'TooDeep.vue').meta.refs.includes('hidden'));
});

test('6. composable 노드', () => {
  const g = at('src/views/Basic.vue');
  const n = node(g, 'composables/useOrder.ts');
  assert.strictEqual(n.kind, 'composable');
  assert.strictEqual(n.label, 'useOrder');
  assert.ok(n.meta.refs.includes('orders'));
  assert.ok(edge(g, 'Basic.vue', 'useOrder.ts', 'uses'));
});

test('7. Pinia store 노드', () => {
  const g = at('src/views/Basic.vue');
  const n = node(g, 'stores/cart.ts');
  assert.strictEqual(n.kind, 'store');
  assert.strictEqual(n.meta.storeId, 'cart');
  assert.strictEqual(n.label, 'useCartStore');
});

test('8. API 호출: axios/fetch 는 sure, 끝점에 닿지 않는 이름뿐인 래퍼(stub)는 guess (composable 안쪽 포함)', () => {
  const g = at('src/views/Basic.vue');
  const api = (label) => g.nodes.find((n) => n.kind === 'api-call' && n.label === label);
  assert.ok(api('GET /api/orders'));
  assert.ok(api('POST /api/users/{}'), 'fetch + 템플릿 리터럴 + method');
  assert.ok(api('POST /orders'));
  assert.strictEqual(edge(g, 'Basic.vue', 'GET /api/orders', 'calls').certainty, 'sure');
  assert.strictEqual(edge(g, 'useOrder.ts', 'POST /orders', 'calls').certainty, 'guess');
  assert.ok(api('POST /orders').warnings[0].includes('본문에서 끝점을 찾지 못함'));
});

test('9. 동적 컴포넌트: 경고, 변수 import 경고, 리터럴 import 는 추적', () => {
  const g = at('src/components/Dynamic.vue');
  const n = node(g, 'Dynamic.vue');
  assert.ok(n.warnings.some((w) => w.includes('동적 컴포넌트')));
  assert.ok(n.warnings.some((w) => w.includes('동적 import')));
  assert.ok(edge(g, 'Dynamic.vue', 'GrandChild.vue', 'imports'));
  assert.ok(edge(g, 'Dynamic.vue', 'TooDeep.vue', 'imports'), 'import 했지만 템플릿에서 직접 쓰지 않음 → 추정');
  assert.strictEqual(edge(g, 'Dynamic.vue', 'TooDeep.vue').certainty, 'guess');
});

test('10. 중복 사용: 노드는 하나, 엣지는 중복 없음 / 미사용 import 는 guess', () => {
  const g = at('src/views/Basic.vue');
  const ids = g.nodes.map((n) => n.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(g.edges.filter((e) => e.from.endsWith('Basic.vue') && e.to.endsWith('ChildCard.vue')).length, 1);
  const unused = edge(g, 'Basic.vue', 'Unused.vue', 'imports');
  assert.strictEqual(unused.certainty, 'guess');
});

test('스키마: version/root/analyzer, 모든 엣지가 존재하는 노드를 가리킴', () => {
  const g = at('src/views/Basic.vue');
  assert.strictEqual(g.version, 1);
  assert.strictEqual(g.analyzer, 'vue3');
  assert.strictEqual(g.root, 'app/src/views/Basic.vue');
  const ids = new Set(g.nodes.map((n) => n.id));
  g.edges.forEach((e) => assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} → ${e.to}`));
});

// ───────────── 백엔드 · 상위 분석 (fullstack fixture: Vue + Spring + MyBatis) ─────────────
const { analyzeSource } = require('../../out/features/sourceAtlas/pipeline.js');
const { extractTables } = require('../../out/features/sourceAtlas/backend/sqlTables.js');
const { parseJava } = require('../../out/features/sourceAtlas/backend/javaParser.js');
const { matchPaths, pathSegments } = require('../../out/features/sourceAtlas/backend/pathMatch.js');
const { parseMapperXml } = require('../../out/features/sourceAtlas/backend/mybatisParser.js');

const FULL = path.join(FIX, 'fullstack');
const full = (opts = {}) => analyzeSource(path.join(FULL, 'frontend/src/views/OrderPage.vue'), { workspaceRoot: FULL, ...opts });
const byLabel = (g, kind, label) => g.nodes.find((n) => n.kind === kind && n.label === label);
const hasEdge = (g, from, to, type) => g.edges.some((e) => e.from === from.id && e.to === to.id && (!type || e.type === type));

test('B1. API 호출 → 컨트롤러 매칭 (exact), 일치 없는 호출은 unmatched 표시', () => {
  const { graph: g } = full();
  const api = (l) => g.nodes.find((n) => n.kind === 'api-call' && n.label === l);
  const list = byLabel(g, 'controller', 'OrderController.list');
  assert.ok(hasEdge(g, api('GET /api/orders'), list, 'handles'));
  assert.strictEqual(list.meta.httpMethod, 'GET');
  assert.strictEqual(list.meta.path, '/api/orders');
  const get = byLabel(g, 'controller', 'OrderController.get');
  assert.ok(hasEdge(g, api('GET /api/orders/{}'), get, 'handles'), '템플릿 리터럴 ${id} ↔ {id}');
  assert.ok(hasEdge(g, api('POST /api/orders'), byLabel(g, 'controller', 'OrderController.create')), 'POST + path="/" 정규화');
  assert.strictEqual(api('GET /api/nothing/here').meta.backend, 'unmatched');
  assert.ok(!g.edges.some((e) => e.from === api('GET /api/nothing/here').id && e.type === 'handles'));
  assert.strictEqual(api('GET /api/orders').meta.backend, 'matched');
  // 고정 문자열 엔드포인트(legacy-count)와 {id} 엔드포인트가 서로 섞이지 않는다 (Spring 우선순위: 고정 경로 > {변수})
  const legacy = byLabel(g, 'controller', 'OrderController.legacyCount');
  assert.ok(!hasEdge(g, api('GET /api/orders/{}'), legacy));
  assert.ok(hasEdge(g, api('GET /api/orders/legacy-count'), legacy, 'handles'));
  assert.ok(!hasEdge(g, api('GET /api/orders/legacy-count'), get));
});

test('B2. Controller → Service(인터페이스→구현체) → Mapper SQL → 테이블 전체 흐름', () => {
  const { graph: g } = full();
  const list = byLabel(g, 'controller', 'OrderController.list');
  const svc = byLabel(g, 'service', 'OrderServiceImpl.findAll');
  assert.strictEqual(svc.meta.interface, 'OrderService');
  assert.ok(hasEdge(g, list, svc, 'calls'));
  const sel = byLabel(g, 'mapper', 'OrderMapper.selectOrders');
  assert.ok(hasEdge(g, svc, sel, 'calls'), '필드 주입(@Autowired) 타입으로 호출 대상 해석');
  assert.strictEqual(sel.meta.sqlType, 'select');
  assert.ok(sel.meta.sql.includes('o.ID, o.STATUS'), '<include refid> 가 펼쳐짐');
  assert.ok(!sel.meta.sql.includes('<'), '동적 태그 제거');
  const tbl = (n) => g.nodes.find((x) => x.kind === 'table' && x.label === n);
  for (const t of ['ORDER_HDR', 'ORDER_LINE', 'CUSTOMER']) {
    assert.ok(hasEdge(g, sel, tbl(t), 'reads'), `${t} 읽기 (JOIN / 콤마 FROM)`);
  }
});

test('B3. 같은 클래스의 private 보조 메서드 안의 호출도 따라간다 + 생성자 주입', () => {
  const { graph: g } = full();
  const find = byLabel(g, 'mapper', 'ItemMapper.findByIds');
  assert.ok(hasEdge(g, byLabel(g, 'service', 'OrderServiceImpl.findAll'), find, 'calls'), 'findAll → enrich() → itemMapper');
});

test('B4. 어노테이션 SQL(@Select 문자열 이어붙임) + 서브쿼리 테이블', () => {
  const { graph: g } = full();
  const find = byLabel(g, 'mapper', 'ItemMapper.findByIds');
  assert.strictEqual(find.meta.sqlType, 'select');
  const reads = find.meta.tables.read.map((t) => t.toUpperCase()).sort();
  assert.deepStrictEqual(reads, ['ITEM', 'ORDER_ITEM']);
});

test('B5. 쓰기 구문: INSERT(+selectKey FROM DUAL 제외) / UPDATE / DELETE(CDATA)', () => {
  const { graph: g } = full();
  const w = (label) => byLabel(g, 'mapper', label).meta.tables;
  assert.deepStrictEqual(w('OrderMapper.insertOrder').write, ['ORDER_HDR']);
  assert.deepStrictEqual(w('OrderMapper.insertOrder').read, [], 'DUAL 은 테이블이 아님');
  assert.deepStrictEqual(w('OrderMapper.updateStatus').write, ['ORDER_HDR']);
  assert.deepStrictEqual(w('OrderMapper.deleteOld').write, ['ORDER_HIST']);
  const hdr = g.nodes.find((n) => n.kind === 'table' && n.label === 'ORDER_HDR');
  assert.ok(g.edges.some((e) => e.type === 'writes' && e.to === hdr.id));
  assert.ok(g.edges.some((e) => e.type === 'reads' && e.to === hdr.id));
});

test('B6. ${schema}.TABLE 접두 제거, CTE 이름은 테이블 아님, sqlSession.selectOne("ns.id") 레거시 DAO', () => {
  const { graph: g } = full();
  assert.deepStrictEqual(byLabel(g, 'mapper', 'OrderMapper.selectOne').meta.tables.read, ['ORDER_HDR']);
  const legacy = g.nodes.find((n) => n.id === 'sql:com.acme.legacy.countAll');
  assert.deepStrictEqual(legacy.meta.tables.read, ['AUDIT_LOG'], 'WITH recent AS (...) 의 recent 제외');
  assert.ok(hasEdge(g, byLabel(g, 'service', 'LegacyDao.count'), legacy, 'calls'));
});

test('B7. 테스트 소스(src/test)와 주석·문자열 속 호출은 무시', () => {
  const { graph: g } = full();
  assert.ok(!g.nodes.some((n) => n.label.includes('FakeTestController')));
  assert.ok(!g.nodes.some((n) => n.label.includes('fake') || n.label.includes('ignoredInComment')));
});

test('B8. 백엔드 소스가 없으면 UI·API 호출까지만 (오류 없음)', () => {
  const r = analyzeSource(path.join(APP, 'src/views/Basic.vue'), { workspaceRoot: APP });
  assert.ok(r.notes.some((n) => n.includes('백엔드 소스 없음')));
  assert.ok(!r.graph.nodes.some((n) => ['controller', 'service', 'mapper', 'table'].includes(n.kind)));
  assert.ok(r.graph.nodes.some((n) => n.kind === 'api-call'));
  const off = full({ backend: false });
  assert.ok(!off.graph.nodes.some((n) => n.kind === 'controller'));
});

test('U1. 하위 컴포넌트에서 시작하면 상위 컴포넌트와 라우트까지 올라간다', () => {
  const r = analyzeSource(path.join(FULL, 'frontend/src/components/OrderRow.vue'), { workspaceRoot: FULL });
  const g = r.graph;
  const row = g.nodes.find((n) => n.id.endsWith('OrderRow.vue'));
  const page = g.nodes.find((n) => n.id.endsWith('OrderPage.vue'));
  assert.strictEqual(page.meta.relation, 'ancestor');
  assert.ok(hasEdge(g, page, row, 'uses'), 'template 에서 실제 사용');
  const route = g.nodes.find((n) => n.kind === 'route' && n.label === '/orders');
  assert.ok(route && hasEdge(g, route, page), '라우트 → 페이지');
  assert.ok(g.nodes.some((n) => n.kind === 'route' && n.label === '/lazy'), '() => import() 라우트');
  assert.strictEqual(page.meta.props !== undefined, true, '상위 노드도 메타를 가짐');
  assert.ok(r.notes[0].includes('상위 1개'));
});

test('U2. 상위 깊이 제한(maxUp=0 이면 끔) / 어디에서도 쓰이지 않으면 안내', () => {
  const none = analyzeSource(path.join(FULL, 'frontend/src/components/OrderRow.vue'), { workspaceRoot: FULL, maxUp: 0 });
  assert.ok(!none.graph.nodes.some((n) => n.meta.relation === 'ancestor'));
  const top = analyzeSource(path.join(FULL, 'frontend/src/components/Unrelated.vue'), { workspaceRoot: FULL });
  assert.ok(top.graph.nodes.some((n) => n.id.endsWith('OrderPage.vue') && n.meta.relation === 'ancestor'), 'import 만 된 부모도 표시');
  const edge = top.graph.edges.find((e) => e.to.endsWith('Unrelated.vue'));
  assert.strictEqual(edge.type, 'imports');
  assert.strictEqual(edge.certainty, 'guess');
});

test('단위: SQL 테이블 추출', () => {
  const t = (s) => extractTables(s);
  assert.deepStrictEqual(t('select * from a x, b y where 1=1'), { read: ['a', 'b'], write: [] });
  assert.deepStrictEqual(t('select * from a left outer join b on a.id=b.id inner join c on 1=1').read.sort(), ['a', 'b', 'c']);
  assert.deepStrictEqual(t('delete from T where id=1'), { read: [], write: ['T'] });
  assert.deepStrictEqual(t('insert into T select * from S'), { read: ['S'], write: ['T'] });
  assert.deepStrictEqual(t('merge into T using S on (1=1) when matched then update set x=1').write, ['T']);
  assert.deepStrictEqual(t('select * from t for update').write, []);
  assert.deepStrictEqual(t('select x from (select y from inner_t) z').read, ['inner_t']);
});

test('단위: 경로 매칭 / Java 파서 / MyBatis XML', () => {
  assert.deepStrictEqual(pathSegments('https://h:8080/api/u/{id:[0-9]+}?a=1#x'), ['api', 'u', '{}']);
  assert.strictEqual(matchPaths(['api', 'u', '{}'], ['api', 'u', '{}']), 'exact');
  assert.strictEqual(matchPaths(['api', 'u', '1'], ['api', 'u', '{}']), 'exact');
  assert.strictEqual(matchPaths(['api', 'u', '{}'], ['api', 'u', 'me']), 'loose');
  assert.strictEqual(matchPaths(['orders'], ['api', 'orders']), 'suffix');
  assert.strictEqual(matchPaths(['{}'], ['api', 'orders']), null);
  const [c] = parseJava('package a.b;\n@Service("x") public class Foo<T> extends Bar implements Baz { private final Qux q; void m(@RequestParam("a") String a, Map<String, List<X>> b) throws E { q.go(a); } }', 'Foo.java');
  assert.strictEqual(c.fqcn, 'a.b.Foo');
  assert.deepStrictEqual(c.implements, ['Baz']);
  assert.deepStrictEqual(c.fields, [{ type: 'Qux', name: 'q' }]);
  assert.deepStrictEqual(c.methods[0].params, [{ type: 'String', name: 'a' }, { type: 'Map', name: 'b' }]);
  const x = parseMapperXml('<mapper namespace="n"><select id="s">select * from t where a &lt; 1 <if test="x">and b=1</if></select></mapper>', 'n.xml');
  assert.strictEqual(x.statements[0].sql, 'select * from t where a < 1 and b=1');
});

test('B9. 메서드 본문은 저장하지 않고 호출·지역 변수·sqlSession id 만 뽑아 둔다', () => {
  const src = [
    'package a; public class S {',
    '  private final OrderMapper orderMapper;',
    '  public List<Order> list(Long id) {',
    '    OrderDto dto = new OrderDto(); // 주석 안 x.fake()',
    '    String s = "y.notCall()";',
    '    check(id, dto);',
    '    sqlSession.selectList("order.findAll", id);',
    '    return orderMapper.select(id, dto);',
    '  }',
    '  abstract void none();',
    '  void empty() {}',
    '}',
  ].join('\n');
  const [c] = parseJava(src, 'S.java');
  const [list, none, empty] = c.methods;
  assert.strictEqual(list.body, undefined, '본문 문자열은 없어야 함');
  assert.deepStrictEqual(list.scan.locals, [['dto', 'OrderDto'], ['s', 'String']]);
  assert.deepStrictEqual(list.scan.sqlIds, ['order.findAll']);
  assert.deepStrictEqual(list.scan.calls, [
    { recv: 'sqlSession', name: 'selectList', argc: 2 },
    { recv: 'orderMapper', name: 'select', argc: 2 },
    { recv: null, name: 'check', argc: 2 },
  ]);
  assert.strictEqual(none.scan, null, '추상 메서드');
  assert.strictEqual(empty.scan, null, '빈 본문');
});

test('B10. 백엔드 색인은 같은 결과를 다시 만들고, 비우면 새로 만든다', () => {
  const { buildBackendIndex, clearBackendCache } = require('../../out/features/sourceAtlas/backend/indexer.js');
  const root = path.join(__dirname, 'fixtures', 'fullstack');
  clearBackendCache();
  const a = buildBackendIndex(root);
  assert.strictEqual(buildBackendIndex(root), a, '캐시 사용');
  clearBackendCache();
  const b = buildBackendIndex(root);
  assert.notStrictEqual(b, a, '비운 뒤에는 새로 만듦');
  assert.deepStrictEqual(b.classes, a.classes);
  assert.ok(a.classes.every((c) => c.methods.every((m) => !('body' in m) && !('bodyText' in m))));
});

test('B11. maskSource: 주석·문자열·텍스트 블록·끝나지 않은 문자열 (예전 구현과 같은 결과)', () => {
  const { maskSource } = require('../../out/features/sourceAtlas/backend/javaParser.js');
  const cases = [["a(\"x\\\"y\", 'c') // 주석 \"q\"\r\nb();", {"plain": "a(\"x\\\"y\", 'c')          \r\nb();", "masked": "a(\"    \", ' ')          \r\nb();"}], ["/* 여러\r\n줄 */ s = \"\"\"\n  텍스트 \"따옴표\"\n\"\"\"; t", {"plain": "     \r\n     s = \"\"\"\n  텍스트 \"따옴표\"\n\"\"\"; t", "masked": "     \r\n     s = \"\"\"\n           \n\"\"\"; t"}], ["x = \"끝나지 않음\ny = '\\\\'", {"plain": "x = \"끝나지 않음\ny = '\\\\'", "masked": "x = \"      \ny = '  '"}], ["s = \"abc\\\\", {"plain": "s = \"abc\\\\", "masked": "s = \"     "}]];
  for (const [src, want] of cases) assert.deepStrictEqual(maskSource(src), want, JSON.stringify(src));
});

test('C1. API 노드에 호출 위치(파일·줄·함수)가 기록된다 — 같은 URL 은 노드 하나, 위치는 모두', () => {
  const g = at('src/views/Basic.vue');
  const api = g.nodes.find((n) => n.label === 'GET /api/orders');
  assert.strictEqual(api.file, 'app/src/views/Basic.vue');
  assert.strictEqual(api.meta.callers.length, 1);
  const c = api.meta.callers[0];
  assert.strictEqual(c.fn, 'load', 'async function load() 안의 호출');
  assert.strictEqual(c.line, 29, '.vue 파일 기준 줄 번호');
  assert.ok(c.col > 1);
  const e = g.edges.find((x) => x.to === api.id);
  assert.strictEqual(e.label, 'load()');
  // composable 안의 호출은 composable 파일을 가리킨다
  const post = g.nodes.find((n) => n.label === 'POST /orders');
  assert.strictEqual(post.meta.callers[0].file, 'app/src/composables/useOrder.ts');
  assert.strictEqual(post.meta.callers[0].fn, 'create');
});

test('C2. 화살표 함수 / Options API 메서드 이름도 잡는다 (요약 단계)', () => {
  const { summarizeModule } = require('../../out/features/sourceAtlas/analyzer/flow/summary.js');
  const names = (code, lang = 'ts') => [...summarizeModule(code, { file: 'x.' + lang, lang, isComponent: true, isSetup: true }).fns.values()].map((f) => f.name);
  assert.ok(names("const addItem = async () => { await api.post('/x', {}); };").includes('addItem'));
  const b = summarizeModule("export default { methods: { save() { axios.put('/y'); }, del: function () { axios.delete('/z'); } } }", { file: 'x.js', lang: 'js', isComponent: true });
  assert.deepStrictEqual([...b.fns.values()].filter((f) => f.name !== '<module>').map((f) => f.name), ['save', 'del']);
  assert.deepStrictEqual(Object.keys(b.thisMembers), ['save', 'del']);
  const c = summarizeModule("axios.get('/top');", { file: 'x.js', lang: 'js', isComponent: true, isSetup: true });
  assert.strictEqual(c.fns.get('<setup>').calls.length, 1);
});

test('D1. 심볼 위치(locs): props/emits/ref/computed/watch/slot/전역 태그 — .vue 파일 기준 줄', () => {
  const g = at('src/views/Basic.vue');
  const L = node(g, 'views/Basic.vue').meta.locs;
  assert.strictEqual(L['props:title'].line, 12, 'interface Props 의 title');
  assert.strictEqual(L['emits:select'].line, 17);
  assert.strictEqual(L['refs:keyword'].line, 21);
  assert.strictEqual(L['computed:total'].line, 22);
  assert.strictEqual(L['watchers:keyword'].line, 23);
  assert.strictEqual(L['slots:footer'].line, 41);
  assert.strictEqual(L['unresolvedTags:MyGlobalWidget'].line, 40);
  const oL = node(g, 'OrderList.vue').meta.locs; // Options API
  assert.ok(oL['props:items'] && oL['emits:change']);
});

test('D2. 래퍼(api.post) 호출도 백엔드와 정확히 매칭되면 확실로 승격, 경고 제거', () => {
  const F = path.join(FIX, 'fullstack');
  const fs = require('fs');
  const tmpVue = path.join(F, 'frontend/src/views/WrapperPage.vue');
  fs.writeFileSync(tmpVue, "<script setup>\nimport { useApi } from '@/x';\nconst api = {};\nasync function save() { await api.post('/api/orders', {}); }\nasync function nope() { await api.get('/api/zzz'); }\n</script>\n<template><i /></template>\n");
  try {
    const { graph: g } = analyzeSource(tmpVue, { workspaceRoot: F, fresh: true });
    const ok = g.nodes.find((n) => n.label === 'POST /api/orders');
    assert.strictEqual(ok.meta.confirmedBy, 'backend');
    assert.ok(!ok.warnings, '래퍼 경고 제거');
    assert.strictEqual(g.edges.find((e) => e.to === ok.id && e.type === 'calls').certainty, 'sure');
    const no = g.nodes.find((n) => n.label === 'GET /api/zzz');
    assert.strictEqual(g.edges.find((e) => e.to === no.id && e.type === 'calls').certainty, 'guess', '매칭 안 되면 그대로 추정');
  } finally {
    fs.unlinkSync(tmpVue);
  }
});

// ───────────── 호출 전파 (flow fixture: 래퍼 2겹 · composable · Pinia · 상수 URL · Options API) ─────────────
const FLOW = path.join(FIX, 'flow');
const flowGraph = (rel) => analyzeSource(path.join(FLOW, rel), { workspaceRoot: FLOW, backend: false, maxUp: 0 }).graph;
const apiNode = (g, label) => g.nodes.find((n) => n.kind === 'api-call' && n.label === label);
const callsOf = (g, nodeSuffix) => g.edges.filter((e) => e.type === 'calls' && e.from.endsWith(nodeSuffix)).map((e) => `${e.to.slice(4)}${e.certainty === 'guess' ? '?' : ''}${e.indirect ? '~' : ''}`).sort();

test('F1. composable 반환 함수의 구조 분해 호출 → 래퍼 2겹(request → axios 인스턴스 baseURL) 끝까지 추적', () => {
  const g = flowGraph('src/views/OrderPage.vue');
  const page = g.nodes.find((n) => n.id.endsWith('OrderPage.vue'));
  const rows = page.meta.apiCalls;
  const byFn = (fn) => rows.filter((r) => r.fn === fn).map((r) => `${r.method} ${r.url}`).sort();
  assert.deepStrictEqual(byFn('<setup>'), ['GET /api/orders'], 'onMounted(() => load()) 콜백은 setup 효과');
  assert.deepStrictEqual(byFn('open'), ['DELETE /api/orders/{}', 'GET /api/orders/{}'], 'detail(id) 는 상수 함수 URL, order.remove 는 객체 호출');
  const load = rows.find((r) => r.fn === '<setup>');
  assert.deepStrictEqual(load.via.map((v) => v.fn), ['load', 'get', 'request'], '경유 체인: useOrder.load → request.get → request.request');
  assert.ok(load.via.every((v) => v.file && v.line > 0));
  assert.strictEqual(load.certainty, 'sure', '이름이 아니라 코드로 끝점을 확인했으므로 확실');
});

test('F2. 래퍼 객체(useApi().post) + 삼항 URL + baseURL 환경변수 → 경로는 확정, baseURL 만 미확정 표시', () => {
  const g = flowGraph('src/views/OrderPage.vue');
  const page = g.nodes.find((n) => n.id.endsWith('OrderPage.vue'));
  const save = page.meta.apiCalls.filter((r) => r.fn === 'save').map((r) => `${r.method} ${r.url}`).sort();
  assert.deepStrictEqual(save, ['POST /api/admin/addGroupCode', 'POST /api/admin/modifyGroupCode', 'POST /api/auth/logout', 'POST /api/cart/items']);
  const add = apiNode(g, 'POST /api/admin/addGroupCode');
  assert.ok(add.meta.unknowns.some((u) => u.includes('baseURL 미확정') && u.includes('VITE_API_BASE')));
  assert.ok(!add.warnings, '추정이 아니라 확실 (경고 없음)');
});

test('F3. Pinia setup 스토어 액션 / options 스토어 액션 / 인라인 useUserStore().logout()', () => {
  const g = flowGraph('src/views/OrderPage.vue');
  assert.ok(apiNode(g, 'POST /api/cart/items'), 'setup 스토어 add()');
  assert.ok(apiNode(g, 'POST /api/auth/logout'), 'options 스토어 actions.logout()');
  // 스토어 노드 자체도 함수별 효과를 가진다
  const cart = g.nodes.find((n) => n.id.endsWith('stores/cart.ts'));
  assert.deepStrictEqual(cart.meta.apiCalls.map((r) => [r.fn, r.url]), [['add', '/api/cart/items']]);
  const user = g.nodes.find((n) => n.id.endsWith('stores/user.ts'));
  assert.deepStrictEqual(user.meta.apiCalls.map((r) => r.fn).sort(), ['login', 'logout']);
});

test('F4. 간접 호출 표시: composable/store 노드를 거치면 indirect, 래퍼(비노드)만 거치면 직접', () => {
  const g = flowGraph('src/views/OrderPage.vue');
  const calls = callsOf(g, 'OrderPage.vue');
  assert.ok(calls.includes('POST /api/cart/items~'), '스토어 노드 경유 → indirect');
  assert.ok(calls.includes('GET /api/orders~'), 'useOrder 노드 경유 → indirect');
  assert.ok(calls.includes('POST /api/admin/addGroupCode'), 'useApi 는 노드지만 URL 이 인자뿐인 래퍼라 자기 API 선이 없음 → 직접');
  const useApi = g.nodes.find((n) => n.id.endsWith('useApi.ts'));
  assert.ok(!useApi.meta.apiCalls, '래퍼 composable 은 API 노드를 만들지 않음');
  assert.ok(!g.nodes.some((n) => n.kind === 'api-call' && /^(GET|POST) \{\}$/.test(n.label)));
  const e = g.edges.find((x) => x.type === 'calls' && x.from.endsWith('OrderPage.vue') && x.to === 'api:GET /api/orders');
  assert.strictEqual(e.label, 'setup()', '<setup> 은 setup() 으로 표시');
  const lg = flowGraph('src/views/Legacy.vue');
  const rows = lg.edges.find((x) => x.type === 'calls' && x.from.endsWith('Legacy.vue') && x.to === 'api:GET /api/legacy/rows');
  assert.strictEqual(rows.label, 'created(), fetchRows()', '같은 API 로 가는 진입 함수들은 한 선에 모임');
});

test('F5. 돌려주지 않는 안쪽 헬퍼는 효과 아님 / 콜백 인자 호출은 효과 없음 / 순환 호출 종료', () => {
  const g = flowGraph('src/views/OrderPage.vue');
  assert.ok(!apiNode(g, 'GET /api/never'), 'useOrder 안의 neverCalled 는 반환되지 않음');
  const page = g.nodes.find((n) => n.id.endsWith('OrderPage.vue'));
  assert.ok(!page.meta.apiCalls.some((r) => r.fn === 'runCallback'));
  assert.ok(page.meta.unresolvedCalls.some((u) => u.startsWith('dynamicUrl:') && u.includes('$legacyApi.get') && u.includes('URL 을 알 수 없음')), '전역 래퍼 + URL 변수는 미해석 목록');
  assert.ok(!page.meta.apiCalls.some((r) => r.fn === 'dynamicUrl'));
  const legacy = flowGraph('src/views/Legacy.vue');
  const l = legacy.nodes.find((n) => n.id.endsWith('Legacy.vue'));
  assert.ok(l.meta.apiCalls.some((r) => r.fn === 'loop' && r.url === '/api/legacy/loop'), 'loop ↔ loop2 순환에서도 끝남');
});

test('F6. Options API: created → this.fetchRows → http, this.$http 는 추정', () => {
  const g = flowGraph('src/views/Legacy.vue');
  const l = g.nodes.find((n) => n.id.endsWith('Legacy.vue'));
  const created = l.meta.apiCalls.filter((r) => r.fn === 'created');
  assert.deepStrictEqual(created.map((r) => [r.method, r.url, r.certainty]).sort(), [['GET', '/api/legacy/rows', 'sure'], ['POST', '/legacy/log', 'guess']]);
  assert.deepStrictEqual(created[0].via.map((v) => v.fn), ['fetchRows']);
  const log = apiNode(g, 'POST /legacy/log');
  assert.ok(log.warnings[0].includes('this.$http'));
});

test('F7. 값 체계 단위: concat/alt/subst/render', () => {
  const V = require('../../out/features/sourceAtlas/analyzer/flow/values.js');
  const u = V.concat([V.lit('/a/'), { k: 'param', i: 0, name: 'id' }, V.lit('/x')]);
  assert.deepStrictEqual(V.render(V.subst(u, [V.lit('7')]))[0], { text: '/a/7/x', unknowns: [] });
  assert.deepStrictEqual(V.render(u)[0], { text: '/a/{}/x', unknowns: ["인자 'id'"] });
  const a = V.alt([V.lit('/p'), V.lit('/q'), V.lit('/p')]);
  assert.deepStrictEqual(V.render(V.concat([V.lit('/api'), a])).map((r) => r.text), ['/api/p', '/api/q']);
  assert.strictEqual(V.concat([V.lit(''), V.lit('x')]).k, 'lit');
});

// ───────────── Vite 프로브 (자식 프로세스로 설정 실행) ─────────────
test('V1. Vite 설정 프로브: alias·proxy(rewrite 포함)·base 를 받아 온다 / 없으면 null', () => {
  const { probeVite, applyProxy, clearViteProbeCache } = require('../../out/features/sourceAtlas/analyzer/viteProbe.js');
  clearViteProbeCache();
  const info = probeVite(FLOW, { viteEntry: path.join(FLOW, '.vite-shim/index.mjs') });
  assert.ok(info, '프로브 결과');
  assert.deepStrictEqual(info.aliases, [{ find: '@', replacement: '/src' }]);
  assert.deepStrictEqual(info.proxies, [{ prefix: '/api', target: 'http://localhost:8080', rewritten: '' }], 'rewrite 함수는 표본 경로로 접두어 변화를 알아낸다');
  assert.deepStrictEqual(applyProxy('/api/orders/3?x=1', info.proxies), { path: '/orders/3', target: 'http://localhost:8080' });
  assert.strictEqual(applyProxy('/other', info.proxies), null);
  assert.strictEqual(probeVite(APP, {}), null, 'vite.config 없음');
  clearViteProbeCache();
  assert.strictEqual(probeVite(FLOW, { viteEntry: path.join(FLOW, 'no-such-vite.mjs') }), null, 'vite 실행 실패 → null (정적 해석 폴백)');
});

test('V2. 파이프라인: 프로브 alias 가 import 해석에 쓰이고, 프록시 경로가 백엔드 매칭·표시에 반영된다', () => {
  const fs = require('fs');
  const F = path.join(FIX, 'fullstack');
  const cfg = path.join(F, 'frontend/vite.config.ts');
  // fullstack 프론트에 임시로 "'/api' → 제거" 프록시를 두면, 컨트롤러 매핑이 '/api/orders' 라 프록시 경로('/orders')로는 안 맞고 원래 경로로 맞아야 한다
  fs.writeFileSync(cfg, "import { defineConfig } from 'vite';\nexport default defineConfig({ server: { proxy: { '/api': { target: 'http://localhost:9090', rewrite: (p) => p.replace(/^\\/api/, '') } } } });\n");
  try {
    const r = analyzeSource(path.join(F, 'frontend/src/views/OrderPage.vue'), { workspaceRoot: F, fresh: true, vite: { viteEntry: path.join(FLOW, '.vite-shim/index.mjs') } });
    assert.ok(r.notes.some((n) => n.includes('Vite 설정 읽음') && n.includes('proxy 1')));
    const api = r.graph.nodes.find((n) => n.label === 'GET /api/orders');
    assert.strictEqual(api.meta.proxied, 'http://localhost:9090/orders');
    assert.strictEqual(api.meta.backend, 'matched', '프록시 경로로 안 맞으면 원래 경로로 매칭');
    assert.deepStrictEqual(r.graph.meta.vite.proxies[0].prefix, '/api');
  } finally {
    fs.unlinkSync(cfg);
  }
  // 프로브 끄면 정적 해석만
  const off = analyzeSource(path.join(FLOW, 'src/views/OrderPage.vue'), { workspaceRoot: FLOW, backend: false, maxUp: 0, vite: false });
  assert.ok(!off.notes.some((n) => n.includes('Vite 설정 읽음')));
  assert.ok(off.graph.nodes.some((n) => n.label === 'GET /api/orders'), '정적 alias 해석으로도 동작');
});

// ───────────── 재검토에서 나온 엣지 케이스 (flow/edge, flow/diamond) ─────────────
test('R1. export * 순환(배럴)에서 죽지 않고 값이 풀린다 / enum / 기본 인자값 / 부분 확정 baseURL', () => {
  const t0 = Date.now();
  const g = flowGraph('src/views/EdgePage.vue');
  assert.ok(Date.now() - t0 < 3000, '엣지 케이스 전체가 3초 안에 끝남');
  const page = g.nodes.find((n) => n.id.endsWith('EdgePage.vue'));
  const urls = (fn) => page.meta.apiCalls.filter((r) => r.fn === fn).map((r) => `${r.method} ${r.url}`).sort();
  assert.deepStrictEqual(urls('barrel'), ['GET /edge/a', 'GET /edge/b'], 'export * 순환을 거쳐 상수를 찾음');
  assert.deepStrictEqual(urls('enumUrl'), ['GET /api/enum/list'], 'TS enum 멤버');
  assert.deepStrictEqual(urls('defaults'), ['GET /api/v2/users'], '기본 인자값 base = "/api/v2"');
  const pb = page.meta.apiCalls.find((r) => r.fn === 'partialBase');
  assert.strictEqual(pb.url, '/v1/users', '`${env}/v1` 의 고정 부분 /v1 은 살린다');
  assert.ok(pb.unknowns[0].includes('baseURL 미확정'));
});

test('R2. 래퍼 자체 효과(GET /api/{}, /api/v2{})는 노드가 되지 않고, 경로 변수(/orders/{})는 남는다', () => {
  const g = flowGraph('src/views/EdgePage.vue');
  const labels = g.nodes.filter((n) => n.kind === 'api-call').map((n) => n.label);
  assert.ok(!labels.some((l) => /\/api\/\{\}$|\/api\/v2\{\}$|^(GET|POST) \{\}$/.test(l)), labels.join(', '));
  assert.ok(labels.includes('GET /api/users'), 'useHttp().get("/users") 는 호출자에서 실제 URL 로');
  const o = flowGraph('src/views/OrderPage.vue');
  const useOrder = o.nodes.find((n) => n.id.endsWith('useOrder.ts'));
  assert.ok(useOrder.meta.apiCalls.some((r) => r.fn === 'detail' && r.url === '/api/orders/{}'), 'composable 표에 경로 변수 URL 유지');
});

test('R3. 자기 참조 누적 대입(u = u + …)은 지수 폭발 없이 미해석으로, `+=` 는 이어 붙이기, URL 변수는 미해석 목록', () => {
  const t0 = Date.now();
  const g = flowGraph('src/views/EdgePage.vue');
  assert.ok(Date.now() - t0 < 3000);
  const page = g.nodes.find((n) => n.id.endsWith('EdgePage.vue'));
  assert.ok(!page.meta.apiCalls.some((r) => r.fn === 'selfRef'), 'selfRef 는 API 행 없음');
  assert.ok(page.meta.unresolvedCalls.some((u) => u.startsWith('selfRef:') && u.includes('누적 대입')));
  assert.ok(page.meta.unresolvedCalls.some((u) => u.startsWith('unknownUrl:') && u.includes('URL 을 알 수 없음')), '확실한 끝점이라도 URL 을 모르면 미해석 목록');
  const plus = page.meta.apiCalls.filter((r) => r.fn === 'plusEq').map((r) => r.url).sort();
  assert.deepStrictEqual(plus, ['/api/q?x=1', '/api/q?x=1&a={}', '/api/q?x=1&a={}&b={}', '/api/q?x=1&b={}']);
  assert.ok(!g.nodes.some((n) => n.kind === 'api-call' && /^GET [&?]/.test(n.label)), '`+=` 조각이 독립 URL 로 새지 않음');
});

test('R4. Pinia options 스토어의 this.otherAction() / HTTP 메서드 미확정은 ANY / 라벨 4개 이상 병합', () => {
  const g = flowGraph('src/views/EdgePage.vue');
  const page = g.nodes.find((n) => n.id.endsWith('EdgePage.vue'));
  assert.ok(page.meta.apiCalls.some((r) => r.fn === 'store' && r.url === '/api/opt/all'), 'refresh() → this.loadAll()');
  const um = page.meta.apiCalls.find((r) => r.fn === 'unknownMethod');
  assert.strictEqual(um.method, 'ANY');
  assert.ok(um.unknowns[0].startsWith('HTTP 메서드 미확정'));
  const many = g.edges.find((e) => e.to === 'api:GET /api/many');
  assert.strictEqual(many.label, 'm1(), m2(), m3() 외 4');
  assert.deepStrictEqual(many.via, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
});

test('R5. 다이아몬드 호출 그래프(폭 4 × 깊이 7)에서 메모로 빠르게 끝나고 행이 중복되지 않는다', () => {
  const t0 = Date.now();
  const g = flowGraph('src/views/DiamondPage.vue');
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `${ms}ms`);
  const page = g.nodes.find((n) => n.id.endsWith('DiamondPage.vue'));
  assert.strictEqual(page.meta.apiCalls.length, 4, '(fn, method, url) 당 한 행');
  assert.deepStrictEqual(page.meta.apiCalls.map((r) => r.url).sort(), ['/api/deep/a', '/api/deep/b', '/api/deep/c', '/api/deep/d']);
  assert.strictEqual(page.meta.apiCalls[0].via.length, 7, '경유 체인은 첫 경로 하나를 보존');
});

// ───────────── 화면: 깊이 필터 · 분석 진행 표시 ─────────────
test('W1. 깊이 필터: 중심에서 선(방향 무시) N단계 안의 노드만, 깊이 밖 이웃 수, 서버 흐름 함께', () => {
  const { neighborhood } = require('../../out/features/sourceAtlas/view/neighborhood.js');
  // 조부모 → 부모 → [중심] → 자식 → API → Controller → Service → SQL → 테이블,  중심 → 형제API
  const N = (id, kind) => ({ id, kind, label: id, meta: {} });
  const nodes = [N('gp', 'component'), N('p', 'component'), N('c', 'component'), N('ch', 'component'), N('api', 'api-call'),
    N('ctl', 'controller'), N('svc', 'service'), N('sql', 'mapper'), N('tbl', 'table'), N('api2', 'api-call'), N('far', 'component')];
  const E = (from, to, type = 'uses') => ({ from, to, type, certainty: 'sure' });
  const edges = [E('gp', 'p'), E('p', 'c'), E('c', 'ch'), E('ch', 'api', 'calls'), E('api', 'ctl', 'handles'), E('ctl', 'svc', 'calls'),
    E('svc', 'sql', 'calls'), E('sql', 'tbl', 'reads'), E('c', 'api2', 'calls'), E('far', 'gp')];
  const ids = (r) => [...r.dist.keys()].sort();
  const d1 = neighborhood(nodes, edges, 'c', 1, false);
  assert.deepStrictEqual(ids(d1), ['api2', 'c', 'ch', 'p']);
  const d2 = neighborhood(nodes, edges, 'c', 2, false);
  assert.deepStrictEqual(ids(d2), ['api', 'api2', 'c', 'ch', 'gp', 'p'], '조부모-부모-중심-자식-API (사용자 예시)');
  assert.strictEqual(d2.dist.get('gp'), 2);
  assert.strictEqual(d2.hiddenNeighbors.get('gp'), 1, 'gp 위에 far 가 숨어 있음');
  assert.strictEqual(d2.hiddenNeighbors.get('api'), 1, 'api 뒤에 controller 가 숨어 있음');
  assert.ok(!d2.hiddenNeighbors.has('c'));
  const d2s = neighborhood(nodes, edges, 'c', 2, true);
  assert.deepStrictEqual(ids(d2s), ['api', 'api2', 'c', 'ch', 'ctl', 'gp', 'p', 'sql', 'svc', 'tbl'], '서버 흐름은 깊이와 상관없이');
  assert.strictEqual(d2s.dist.get('tbl'), -1);
  assert.ok(!ids(d2s).includes('far'), '서버 흐름은 위(컴포넌트)로는 퍼지지 않음');
  assert.deepStrictEqual(ids(neighborhood(nodes, edges, 'nope', 2, false)), [], '없는 중심');
  // 종류를 숨겨도 거리는 전체 그래프로: 자식(ch) 컴포넌트를 숨겨도 그 너머 API 는 깊이 2 안
  const hid = neighborhood(nodes, edges, 'c', 2, true, { hiddenKinds: new Set(['component']), alwaysShow: new Set(['c']) });
  assert.deepStrictEqual(ids(hid), ['api', 'api2', 'c', 'ctl', 'sql', 'svc', 'tbl'], '숨긴 종류는 빠지지만 경로는 끊기지 않음');
  assert.ok(!hid.hiddenNeighbors.has('api'), '숨긴 종류(ch)는 숨은 이웃 수에 안 셈');
});

test('W2. 비동기 분석: 단계별 진행 알림, 동기 분석과 같은 결과, 취소하면 null', async () => {
  const { analyzeSource, analyzeSourceAsync } = require('../../out/features/sourceAtlas/pipeline.js');
  const F = path.join(FIX, 'fullstack');
  const file = path.join(F, 'frontend/src/views/OrderPage.vue');
  const steps = [];
  const r = await analyzeSourceAsync(file, { workspaceRoot: F, vite: false, fresh: true }, (s) => steps.push(s));
  assert.deepStrictEqual(steps.map((s) => `${s.index}/${s.total}`), ['1/5', '2/5', '3/5', '4/5', '5/5']);
  assert.ok(steps.every((s) => s.label.endsWith('중')));
  const sync = analyzeSource(file, { workspaceRoot: F, vite: false });
  assert.deepStrictEqual(r.graph.nodes.map((n) => n.id).sort(), sync.graph.nodes.map((n) => n.id).sort());
  assert.deepStrictEqual(r.notes, sync.notes);
  const noBackend = [];
  await analyzeSourceAsync(file, { workspaceRoot: F, vite: false, backend: false }, (s) => noBackend.push(s.label));
  assert.ok(!noBackend.some((l) => l.includes('백엔드')), '백엔드 끄면 그 단계 없음');
  let cancel = false;
  const c = await analyzeSourceAsync(file, { workspaceRoot: F, vite: false }, (s) => { if (s.index === 2) cancel = true; }, () => cancel);
  assert.strictEqual(c, null, '새 분석이 시작되면 이전 분석은 버림');
  // 대기 중에 취소되면 그 단계는 실행하지 않는다 (진행 알림 직후 취소 → 2단계 run 없음)
  let ran = 0;
  const { analyzeSourceAsync: run2 } = require('../../out/features/sourceAtlas/pipeline.js');
  let flag = false;
  const r2 = await run2(file, { workspaceRoot: F, vite: false }, (s) => { ran = s.index; if (s.index === 2) flag = true; }, () => flag);
  assert.strictEqual(r2, null);
  assert.strictEqual(ran, 2, '2단계 알림 뒤 대기 중 취소 → 더 진행하지 않음');
});
