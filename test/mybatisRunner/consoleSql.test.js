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
