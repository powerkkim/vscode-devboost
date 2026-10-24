// mybatisRunner 의 mapper 해석·SQL 생성 테스트. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
// 실제 프로젝트에서 잘못 나오는 mapper 를 찾으면 fixtures/ 에 넣고 여기에 케이스를 추가하세요.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'mybatisRunner', 'mapper');
const { parseMapper, statementAt } = require(path.join(OUT, 'mapperDoc.js'));
const { renderStatement, collectParams, applyTrim, buildBindScript } = require(path.join(OUT, 'render.js'));
const { buildParamObject } = require(path.join(OUT, 'values.js'));
const { evalOgnlBool, evalOgnl, referencedPaths, OgnlUnsupported } = require(path.join(OUT, 'ognl.js'));

const FIX = path.join(__dirname, 'fixtures');
const load = (name) => parseMapper(fs.readFileSync(path.join(FIX, name), 'utf8'), name);
const order = load('OrderMapper.xml');
const common = load('CommonMapper.xml');
const resolveFragment = (ns, id) => (ns === common.namespace && common.fragments.has(id) ? { el: common.fragments.get(id), doc: common } : undefined);
const st = (id) => order.statements.find((s) => s.id === id);
const inputs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? { type: 'auto', value: v } : v]));
const render = (id, values, opts = {}) => renderStatement(order, st(id), buildParamObject(inputs(values)), { resolveFragment, ...opts });
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const ognl = (expr, vars) => evalOgnlBool(expr, { lookup: (n) => vars[n] });

test('1. mapper 구조: namespace, statement, sql 조각, 커서 위치', () => {
  assert.strictEqual(order.namespace, 'com.demo.order.OrderMapper');
  assert.deepStrictEqual(order.statements.map((s) => `${s.type}:${s.id}`), [
    'select:selectList', 'select:selectItems', 'update:updateOrder', 'insert:insertItems', 'select:trimCase', 'select:crossInclude',
  ]);
  assert.ok(order.fragments.has('baseColumns') && order.fragments.has('authCond'));
  const src = order.src;
  assert.strictEqual(statementAt(order, src.indexOf('o.STATUS = #{status}')).id, 'selectList');
  assert.strictEqual(statementAt(order, src.indexOf('TB_ORDER_ITEM WHERE')).id, 'selectItems');
  assert.strictEqual(parseMapper('<beans></beans>'), null, 'mapper 가 아니면 null');
});

test('2. 조건 없음: <where> 안의 if 가 모두 꺼지면 otherwise 만 남고 앞의 AND 제거', () => {
  const r = render('selectList', { orderBy: 'o.ORDER_ID' });
  assert.match(flat(r.sql), /FROM TB_ORDER o JOIN TB_CUSTOMER c ON c.CUST_ID = o.CUST_ID WHERE 1 = 1 ORDER BY o.ORDER_ID$/);
  assert.match(flat(r.sql), /^SELECT o.ORDER_ID, o.STATUS, o.ORDER_DT , c.NAME/, 'include + property(${alias}) 치환');
});

test('3. 값 입력: bind, foreach, 날짜, choose, 다른 조각의 조건, 정적 유틸, 따옴표 이스케이프', () => {
  const r = render('selectList', {
    keyword: '홍', ids: { type: 'list', value: '1, 2, 3' }, fromDt: { type: 'date', value: '2026-10-01' },
    sort: 'date', 'loginUser.roleCd': 'USER', 'loginUser.deptCd': 'D01', memo: "it's", orderBy: 'o.ORDER_DT DESC',
  });
  const s = flat(r.sql);
  assert.match(s, /WHERE c\.NAME LIKE '%홍%'/, '<bind> + 앞 AND 제거');
  assert.match(s, /AND o\.ORDER_ID IN \(1, 2, 3\)/);
  assert.match(s, /AND o\.ORDER_DT >= TO_DATE\('2026-10-01', 'YYYY-MM-DD'\)/, '&gt; 엔티티 + 날짜');
  assert.ok(!s.includes('ORDER_DT <'), 'toDt 가 비어 있으면 CDATA 조건도 빠짐');
  assert.match(s, /AND o\.ORDER_DT IS NOT NULL/, 'choose 두 번째 when');
  assert.ok(!s.includes('1 = 1'), 'when 이 선택되면 otherwise 는 빠짐');
  assert.match(s, /AND o\.DEPT_CD = 'D01'/, '다른 <sql> 조각 안의 if + property');
  assert.match(s, /AND o\.MEMO = 'it''s'/, 'StringUtils@isNotBlank + 작은따옴표 이스케이프');
  assert.match(s, /ORDER BY o\.ORDER_DT DESC$/, '${} 는 그대로');
});

test('4. 평가할 수 없는 식은 꺼진 채 unknown, 수동 지정하면 반영', () => {
  let r = render('selectList', { useYn: 'Y', orderBy: 'x' });
  const b = r.branches.find((x) => x.expr.includes('@com.demo.Code@ACTIVE'));
  assert.strictEqual(b.how, 'unknown');
  assert.strictEqual(b.on, false);
  assert.match(b.note, /정적 필드/);
  r = render('selectList', { useYn: 'Y', orderBy: 'x' }, { overrides: { [b.key]: 'on' } });
  assert.match(flat(r.sql), /AND o\.USE_YN = 'Y'/);
  assert.strictEqual(r.branches.find((x) => x.key === b.key).how, 'manual');
});

test('5. 수동 지정은 자동 평가보다 우선 (끄기)', () => {
  const r0 = render('selectList', { status: 'A', orderBy: 'x' });
  const b = r0.branches.find((x) => x.expr === 'status != null');
  assert.ok(b.on);
  const r = render('selectList', { status: 'A', orderBy: 'x' }, { overrides: { [b.key]: 'off' } });
  assert.ok(!flat(r.sql).includes('o.STATUS ='));
});

test('6. 바인드 변수 모드: :이름, foreach 는 항목마다 다른 이름', () => {
  const r = render('selectList', { ids: { type: 'list', value: '10,20' }, status: 'A', orderBy: 'x' }, { mode: 'bind' });
  const s = flat(r.sql);
  assert.match(s, /o\.STATUS = :status/);
  assert.match(s, /IN \(:id_\d+, :id_\d+\)/);
  assert.deepStrictEqual(r.binds.map((b) => b.literal), ["'A'", '10', '20']);
});

test('7. <set>: 끝 쉼표 제거 / <trim prefixOverrides> / 객체 목록 foreach', () => {
  assert.strictEqual(flat(render('updateOrder', { status: 'A', memo: 'm', orderId: '7' }).sql), "UPDATE TB_ORDER SET STATUS = 'A', MEMO = 'm' WHERE ORDER_ID = 7");
  assert.strictEqual(flat(render('updateOrder', { status: 'A', orderId: '7' }).sql), "UPDATE TB_ORDER SET STATUS = 'A' WHERE ORDER_ID = 7");
  assert.strictEqual(flat(render('trimCase', { a: '1', b: { type: 'string', value: 'Y' } }).sql), "SELECT * FROM T WHERE A = 1 AND B = 'Y'");
  assert.strictEqual(flat(render('trimCase', {}).sql), 'SELECT * FROM T', '모두 꺼지면 WHERE 도 없음');
  const ins = render('insertItems', { list: { type: 'json', value: '[{"orderId":1,"seq":1,"name":"a"},{"orderId":1,"seq":2,"name":"b"}]' } });
  assert.strictEqual(ins.sql.split('\n').filter((l) => l.includes('INTO TB_ORDER_ITEM')).length, 2);
  assert.match(ins.sql, /VALUES \(1, 2, 'b'\)/);
});

test("8. 'Y' (char) 비교는 경고", () => {
  const r = render('trimCase', { b: 'Y' });
  assert.ok(r.warnings.some((w) => w.includes('char')));
});

test('9. 다른 mapper 의 <sql> 조각 / 못 찾으면 경고', () => {
  assert.strictEqual(flat(render('crossInclude', {}).sql), 'SELECT REG_ID, REG_DT, MOD_ID, MOD_DT FROM T');
  const r = renderStatement(order, st('crossInclude'), {}, {});
  assert.ok(r.warnings.some((w) => w.includes('찾지 못했')));
});

test('10. 빈 목록 / null 목록 foreach 경고', () => {
  let r = render('insertItems', { list: { type: 'json', value: '[]' } });
  assert.ok(r.warnings.some((w) => w.includes('빈 목록')));
  r = render('insertItems', {});
  assert.ok(r.warnings.some((w) => w.includes('null')));
});

test('11. 파라미터 수집: 경로, 용도, jdbcType, 지역 변수 제외', () => {
  const ps = collectParams(order, st('selectList'), resolveFragment);
  const byPath = Object.fromEntries(ps.map((p) => [p.path, p]));
  assert.deepStrictEqual(Object.keys(byPath).sort(), [
    'fromDt', 'ids', 'keyword', 'loginUser.deptCd', 'loginUser.roleCd', 'memo', 'orderBy', 'sort', 'status', 'toDt', 'useYn',
  ]);
  assert.ok(!byPath.id && !byPath.kw, 'foreach item, bind 이름은 제외');
  assert.ok(!byPath.loginUser, '하위 경로가 있으면 상위 객체는 따로 묻지 않음');
  assert.deepStrictEqual(byPath.ids.uses.sort(), ['collection', 'test']);
  assert.deepStrictEqual(byPath.orderBy.uses, ['raw']);
  assert.strictEqual(byPath.fromDt.jdbcType, 'DATE');
  const items = collectParams(order, st('insertItems'));
  assert.deepStrictEqual(items.map((p) => p.path), ['list']);
});

test('12. 값 변환: 빈칸=null, 앞자리 0 은 문자열, 하위 경로가 비면 상위도 null', () => {
  const p = buildParamObject(inputs({ a: '', code: '001', n: '12', b: 'true', 'user.name': '', 'emp.id': '3', s: { type: 'string', value: '' } }));
  assert.strictEqual(p.a, null);
  assert.strictEqual(p.code, '001');
  assert.strictEqual(p.n, 12);
  assert.strictEqual(p.b, true);
  assert.strictEqual(p.user, undefined);
  assert.deepStrictEqual(p.emp, { id: 3 });
  assert.strictEqual(p.s, '');
});

test('13. OGNL: 자주 쓰는 식', () => {
  const v = { name: '홍', empty: '', list: [1, 2], map: { k: 1 }, n: 5, s: '10', nul: null, flag: true, user: { role: 'A' } };
  assert.ok(ognl("name != null and name != ''", v));
  assert.ok(!ognl("empty != null and empty != ''", v));
  assert.ok(ognl('empty', v), "OGNL 에서 '' 는 참");
  assert.ok(ognl('list != null and list.size() > 0', v));
  assert.ok(ognl('!list.isEmpty()', v));
  assert.ok(ognl("map.containsKey('k')", v));
  assert.ok(ognl('n gt 3 and n lte 5', v));
  assert.ok(ognl('s == 10', v), '숫자 문자열과 숫자 비교');
  assert.ok(ognl("user.role == 'A'.toString()", v));
  assert.ok(ognl('user.role eq "A"', v));
  assert.ok(ognl("name.equals('홍')", v));
  assert.ok(ognl('nul == null && !flag == false', v));
  assert.ok(ognl("n in {1, 5}", v));
  assert.ok(ognl("n not in {1, 2}", v));
  assert.ok(ognl("(n > 1 ? 'x' : 'y') == 'x'.toString()", v));
  assert.ok(ognl('missing == null', v), '없는 이름은 null');
  assert.ok(ognl('nul.x == null', v), 'null 의 속성은 null');
  assert.ok(ognl('@org.springframework.util.StringUtils@hasText(name)', v));
  assert.ok(ognl('@org.apache.commons.collections.CollectionUtils@isNotEmpty(list)', v));
  assert.strictEqual(evalOgnl("'%' + name + '%'", { lookup: (n) => v[n] }), '%홍%');
  assert.throws(() => ognl('@com.x.Code@ACTIVE == 1', v), OgnlUnsupported);
  assert.throws(() => ognl('name.someCustomMethod()', v), OgnlUnsupported);
  assert.throws(() => ognl('#this.x', v), OgnlUnsupported);
});

test('14. OGNL: 참조 경로 추출', () => {
  assert.deepStrictEqual(referencedPaths("user.name != null and list.size() > 0 and name.trim() != ''").sort(), ['list', 'name', 'user.name']);
  assert.deepStrictEqual(referencedPaths('@x.StringUtils@isNotEmpty(a.b)'), ['a.b']);
  assert.deepStrictEqual(referencedPaths('items[0].id != null'), ['items']);
});

test('15. TrimSqlNode 규칙: AND 뒤에 공백·줄바꿈이 있어야 제거', () => {
  assert.strictEqual(applyTrim('  AND a = 1', 'WHERE', ['AND ', 'OR '], undefined, []), 'WHERE a = 1');
  assert.strictEqual(applyTrim('ANDROID = 1', 'WHERE', ['AND ', 'OR '], undefined, []), 'WHERE ANDROID = 1');
  assert.strictEqual(applyTrim('a = 1,', 'SET', [','], undefined, [',']), 'SET a = 1');
  assert.strictEqual(applyTrim('   ', 'WHERE', ['AND '], undefined, []), '');
});

test('16. 깨진 XML 도 최대한 읽음 (편집 중)', () => {
  const doc = parseMapper('<mapper namespace="x"><select id="a">SELECT 1 FROM DUAL <if test="b != null">AND B = #{b}</select><select id="c">SELECT 2</select></mapper>');
  assert.deepStrictEqual(doc.statements.map((s) => s.id), ['a', 'c']);
  const r = renderStatement(doc, doc.statements[0], { b: 1 });
  assert.strictEqual(flat(r.sql), 'SELECT 1 FROM DUAL AND B = 1');
});

test('17. 바인드 변수 스크립트: VARIABLE/EXEC + 날짜는 TO_DATE(:이름) + null 도 명시', () => {
  const r = render('selectList', {
    keyword: '홍', ids: { type: 'list', value: '10,20' }, fromDt: { type: 'date', value: '2026-10-01 09:30' }, sort: 'x', orderBy: 'o.ORDER_ID',
    'loginUser.roleCd': 'USER',
  }, { mode: 'bind' });
  const s = flat(r.sql);
  assert.match(s, /o\.ORDER_DT >= TO_DATE\(:fromDt, 'YYYY-MM-DD HH24:MI:SS'\)/, 'VARIABLE 은 DATE 가 없어 문자열 + TO_DATE');
  const script = buildBindScript(r.sql, r.binds, 'OrderMapper.selectList (바인드 변수)');
  const lines = script.split('\n');
  assert.strictEqual(lines[0], '-- OrderMapper.selectList (바인드 변수)');
  assert.ok(lines.some((l) => /^VARIABLE kw\s+VARCHAR2\(4000\)$/.test(l)));
  assert.ok(lines.some((l) => /^VARIABLE id_\d+\s+NUMBER$/.test(l)));
  assert.ok(lines.some((l) => /^EXEC :kw\s+:= '%홍%';$/.test(l)));
  assert.ok(lines.some((l) => /^EXEC :fromDt\s+:= '2026-10-01 09:30:00';$/.test(l)));
  assert.ok(lines.some((l) => /^EXEC :loginUser_deptCd\s+:= NULL;$/.test(l)), '빈 값도 NULL 로 넣어 세션에 남은 이전 값을 지움');
  assert.ok(script.trimEnd().endsWith(';'));
  assert.ok(script.indexOf('VARIABLE') < script.indexOf('EXEC') && script.indexOf('EXEC') < script.indexOf('SELECT'), '선언 → 값 → 쿼리 순서');
  assert.strictEqual(new Set(r.binds.map((b) => b.name)).size, r.binds.length, '같은 이름은 한 번만 선언');
});

test('18. 바인드가 없는 쿼리는 스크립트도 쿼리만', () => {
  const r = render('crossInclude', {}, { mode: 'bind' });
  assert.strictEqual(buildBindScript(r.sql, r.binds), 'SELECT REG_ID, REG_DT, MOD_ID, MOD_DT FROM T;');
});
