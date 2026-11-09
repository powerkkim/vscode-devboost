// mapper → DB 콘솔 SQL·파라미터 변환 (vscode 없이)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'mybatisRunner', 'mapper');
const { buildConsoleRun, bindToConsoleParam } = require(path.join(OUT, 'consoleSql.js'));
const { parseMapper } = require(path.join(OUT, 'mapperDoc.js'));
const { renderStatement } = require(path.join(OUT, 'render.js'));
const { buildParamObject } = require(path.join(OUT, 'values.js'));

test('바인드 값 → 콘솔 파라미터 칸', () => {
  assert.deepStrictEqual(bindToConsoleParam({ varType: 'NUMBER', assign: '10' }), { value: '10', type: 'NUMBER' });
  assert.deepStrictEqual(bindToConsoleParam({ varType: 'VARCHAR2(4000)', assign: "'O''Brien'" }), { value: "O'Brien", type: 'VARCHAR2' });
  assert.deepStrictEqual(bindToConsoleParam({ varType: 'VARCHAR2(4000)', assign: 'NULL' }), { value: '', type: undefined });
  assert.deepStrictEqual(bindToConsoleParam({ varType: 'NUMBER', assign: 'NULL' }), { value: '', type: 'NUMBER' });
});

test('mapper 쿼리 → :이름 SQL + 값', () => {
  const xml = `<mapper namespace="a.UserMapper">
  <select id="find">
    SELECT * FROM TB_USER
    <where>
      <if test="name != null and name != ''">AND NAME = #{name}</if>
      <if test="age != null">AND AGE &gt;= #{age}</if>
      AND DEPT = #{dept}
    </where>
  </select>
</mapper>`;
  const doc = parseMapper(xml, 'UserMapper.xml');
  const st = doc.statements[0];
  const params = buildParamObject({ name: { type: 'string', value: "O'Brien" }, age: { type: 'auto', value: '' }, dept: { type: 'auto', value: '' } });
  const r = renderStatement(doc, st, params, { mode: 'bind' });
  const run = buildConsoleRun(r.sql, r.binds, 'a.UserMapper.find');
  assert.match(run.text, /^-- a\.UserMapper\.find\n/);
  assert.match(run.text, /NAME = :name/);
  assert.doesNotMatch(run.text, /AGE/); // 값이 없어 if 가 꺼짐
  assert.match(run.text, /DEPT = :dept/);
  assert.deepStrictEqual(run.params.name, { value: "O'Brien", type: 'VARCHAR2' });
  assert.strictEqual(run.params.dept.value, '');
  assert.deepStrictEqual(run.empty, ['dept']);
});

const { panelSpecs, parseMapperHeader } = require(path.join(OUT, 'consoleSql.js'));
const { collectParams } = require(path.join(OUT, 'render.js'));

test('콘솔 머리 주석 → mapper 쿼리', () => {
  assert.deepStrictEqual(parseMapperHeader('-- com.example.post.PostMapper.countUncategorized'), { ns: 'com.example.post.PostMapper', id: 'countUncategorized' });
  assert.deepStrictEqual(parseMapperHeader('  --UserMapper.find  '), { ns: 'UserMapper', id: 'find' });
  assert.strictEqual(parseMapperHeader('-- 그룹별 상위 N건 (사전)'), undefined);
  assert.strictEqual(parseMapperHeader('-- find'), undefined);
  assert.strictEqual(parseMapperHeader('SELECT 1 FROM dual'), undefined);
});

test('패널: 늘 들어가는 값 / 조건 값과 켜짐·꺼짐', () => {
  const xml = `<mapper namespace="a.PostMapper">
  <select id="search">
    SELECT * FROM tb_posts p
    WHERE p.create_user = #{userId}
    <if test="category != null and category != ''">AND p.category = #{category}</if>
    <if test="ids != null and ids.size() > 0">
      AND p.post_id IN <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
    </if>
  </select>
</mapper>`;
  const doc = parseMapper(xml, 'PostMapper.xml');
  const st = doc.statements[0];
  const specs = collectParams(doc, st);
  const run = (inputs) => {
    const r = renderStatement(doc, st, buildParamObject(inputs), { mode: 'bind' });
    return { r, p: Object.fromEntries(panelSpecs(specs, r.branches).map((s) => [s.path, s])) };
  };
  let { r, p } = run({ userId: { type: 'auto', value: 'power' } });
  assert.strictEqual(p.userId.group, 'base');
  assert.strictEqual(p.category.group, 'cond');
  assert.strictEqual(p.category.status, 'if 꺼짐');
  assert.strictEqual(p.ids.status, 'foreach 꺼짐');
  assert.doesNotMatch(r.sql, /category|IN/);
  ({ r, p } = run({ userId: { type: 'auto', value: 'power' }, category: { type: 'string', value: 'NEWS' }, ids: { type: 'list', value: '10,20' } }));
  assert.strictEqual(p.category.status, 'if 켜짐');
  assert.strictEqual(p.category.on, true);
  assert.strictEqual(p.ids.status, 'foreach 2개');
  assert.match(r.sql, /p\.category = :category/);
  assert.match(r.sql, /IN\s*\(\s*:id_\d+\s*,\s*:id_\d+\s*\)/);
});
