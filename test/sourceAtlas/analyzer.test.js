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

test('8. API 호출: axios/fetch 는 sure, 커스텀 래퍼는 guess (composable 안쪽 포함)', () => {
  const g = at('src/views/Basic.vue');
  const api = (label) => g.nodes.find((n) => n.kind === 'api-call' && n.label === label);
  assert.ok(api('GET /api/orders'));
  assert.ok(api('POST /api/users/{}'), 'fetch + 템플릿 리터럴 + method');
  assert.ok(api('POST /orders'));
  assert.strictEqual(edge(g, 'Basic.vue', 'GET /api/orders', 'calls').certainty, 'sure');
  assert.strictEqual(edge(g, 'useOrder.ts', 'POST /orders', 'calls').certainty, 'guess');
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

test('C2. 화살표 함수 / Options API 메서드 이름도 잡는다', () => {
  const { extractScript } = require('../../out/features/sourceAtlas/analyzer/scriptExtractor.js');
  const a = extractScript("const addItem = async () => { await api.post('/x', {}); };", { lang: 'ts' });
  assert.strictEqual(a.apis[0].fn, 'addItem');
  const b = extractScript("export default { methods: { save() { axios.put('/y'); }, del: function () { axios.delete('/z'); } } }", { lang: 'js' });
  assert.deepStrictEqual(b.apis.map((x) => x.fn), ['save', 'del']);
  const c = extractScript("axios.get('/top');", { lang: 'js' });
  assert.strictEqual(c.apis[0].fn, undefined);
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
