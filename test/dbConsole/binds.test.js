// DB 콘솔: 파라미터(바인드 변수) 찾기·값 변환, 결과 → INSERT 문
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'sql');
const b0 = require(path.join(OUT, 'binds.js'));
const { ORACLE_RULES } = require(path.join(OUT, '..', 'drivers', 'oracle', 'dialect.js'));
// Oracle 규칙으로 (q'[…]' 안의 :이름 은 파라미터가 아니다)
const b = { ...b0, bindNames: (s) => b0.bindNames(s, ORACLE_RULES), findBinds: (s) => b0.findBinds(s, ORACLE_RULES), toDriverSql: (s) => b0.toDriverSql(s, ORACLE_RULES), bindValuesFor: (s, i) => b0.bindValuesFor(s, i, ORACLE_RULES) };
const ins = require(path.join(OUT, 'insertSql.js'));

test('파라미터 찾기: :name 과 MyBatis #{name}, 나온 순서대로 한 번씩', () => {
  const sql = "select * from t where a = :fromDt and b = :status and c >= :fromDt and d = #{orderId} and e = #{user.name, jdbcType=VARCHAR}";
  assert.deepEqual(b.bindNames(sql), ['fromDt', 'status', 'orderId', 'user_name']);
  assert.deepEqual(b.findBinds('x = :a').map((x) => [x.raw, x.start, x.end]), [[':a', 4, 6]]);
  assert.deepEqual(b.bindNames('where a = :Status or b = :STATUS'), ['Status'], '대소문자를 구분하지 않는다');
});

test('파라미터가 아닌 것: 문자열·주석 안, :=, 시각, ::, 트리거의 :new·:old', () => {
  assert.deepEqual(b.bindNames("select ':a', q'[:b]' from t -- :c\n /* :d */ where x = :real"), ['real']);
  assert.deepEqual(b.bindNames('begin v := 1; x := :p; end;'), ['p']);
  assert.deepEqual(b.bindNames("select to_date('12:30:45') from dual where t = 12:30"), []);
  assert.deepEqual(b.bindNames('select a::b from t'), []);
  assert.deepEqual(b.bindNames('begin :new.id := :old.id + :step; end;'), ['step']);
  assert.deepEqual(b.bindNames('select 1 from dual'), []);
});

test('드라이버에 보낼 SQL: #{name} 만 :name 으로 바꾼다', () => {
  assert.equal(b.toDriverSql("select * from t where a = #{id} and b = :nm and c = '#{안바꿈}'"), "select * from t where a = :id and b = :nm and c = '#{안바꿈}'");
  assert.equal(b.toDriverSql('where a = #{user.id,jdbcType=NUMERIC}'), 'where a = :user_id');
  assert.equal(b.toDriverSql('select 1 from dual'), 'select 1 from dual');
});

test('타입 짐작: 숫자·날짜·글자 (0 으로 시작하는 코드값은 글자)', () => {
  assert.equal(b.inferType('1042'), 'NUMBER');
  assert.equal(b.inferType('-3.5'), 'NUMBER');
  assert.equal(b.inferType('0012'), 'VARCHAR2');
  assert.equal(b.inferType('0'), 'NUMBER');
  assert.equal(b.inferType('2026-11-01'), 'DATE');
  assert.equal(b.inferType('2026-11-01 14:30:00'), 'DATE');
  assert.equal(b.inferType('20261101'), 'NUMBER', '구분자 없는 8자리는 숫자로 본다 (날짜로 쓰려면 타입을 고른다)');
  assert.equal(b.inferType('PAID'), 'VARCHAR2');
  assert.equal(b.inferType(''), 'VARCHAR2');
});

test('값 변환: 빈 값은 NULL, 타입에 안 맞으면 이유', () => {
  assert.deepEqual(b.parseBindValue('', 'NUMBER'), { ok: true, value: null });
  assert.deepEqual(b.parseBindValue('1042', 'NUMBER'), { ok: true, value: 1042 });
  assert.equal(b.parseBindValue('abc', 'NUMBER').ok, false);
  assert.deepEqual(b.parseBindValue(' 공백 유지 ', 'VARCHAR2'), { ok: true, value: ' 공백 유지 ' });
  const d = b.parseBindValue('2026-11-01', 'DATE');
  assert.ok(d.ok && d.value.getFullYear() === 2026 && d.value.getMonth() === 10 && d.value.getDate() === 1 && d.value.getHours() === 0);
  const dt = b.parseBindValue('2026-11-01 14:30:05', 'DATE');
  assert.ok(dt.ok && dt.value.getHours() === 14 && dt.value.getMinutes() === 30 && dt.value.getSeconds() === 5);
  assert.ok(b.parseBindValue('20261101', 'DATE').ok, '타입을 DATE 로 고르면 8자리도 날짜');
  assert.equal(b.parseBindValue('2026-02-31', 'DATE').ok, false, '없는 날짜');
  assert.equal(b.parseBindValue('어제', 'DATE').ok, false);
});

test('문장에 넘길 값: 그 문장에 나오는 이름만, 없는 값은 NULL, 틀리면 어느 파라미터인지', () => {
  const inputs = { fromDt: { value: '2026-11-01' }, STATUS: { value: 'PAID' }, orderId: { value: '1042' }, unused: { value: 'x' } };
  const r = b.bindValuesFor('select * from t where a >= :fromDt and b = :status and c = :missing', inputs);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.values), ['fromDt', 'status', 'missing']);
  assert.equal(r.values.fromDt.type, 'DATE');
  assert.deepEqual(r.values.status, { value: 'PAID', type: 'VARCHAR2' }, '이름은 대소문자 구분 없이 찾는다');
  assert.deepEqual(r.values.missing, { value: null, type: 'VARCHAR2' });
  const typed = b.bindValuesFor('where a = :code', { code: { value: '1042', type: 'VARCHAR2' } });
  assert.deepEqual(typed.values.code, { value: '1042', type: 'VARCHAR2' }, '고른 타입이 짐작보다 먼저');
  const bad = b.bindValuesFor('where a = :n', { n: { value: 'abc', type: 'NUMBER' } });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /^:n — 숫자가 아닙니다/);
  assert.deepEqual(b.bindValuesFor('select 1 from dual', inputs), { ok: true, values: {} });
});

const cols = [
  { name: 'ORDER_ID', type: 'NUMBER', numeric: true },
  { name: 'CUSTOMER_NM', type: 'VARCHAR2', numeric: false },
  { name: 'ORDER_DT', type: 'DATE', numeric: false },
  { name: 'UPDATED_AT', type: 'TIMESTAMP', numeric: false },
];

test('INSERT 문: 숫자는 그대로, 글자는 따옴표(\' 는 두 번), NULL, 날짜는 TO_DATE', () => {
  const sql = ins.toInsertSql('TB_ORDER', cols, [['1042', "O'Brien", '2026-11-05 14:22:10', '2026-11-05 14:22:10.123'], ['1043', null, '2026-11-05', null]]);
  assert.deepEqual(sql.split('\n'), [
    "INSERT INTO TB_ORDER (ORDER_ID, CUSTOMER_NM, ORDER_DT, UPDATED_AT) VALUES (1042, 'O''Brien', TO_DATE('2026-11-05 14:22:10', 'YYYY-MM-DD HH24:MI:SS'), TO_TIMESTAMP('2026-11-05 14:22:10.123', 'YYYY-MM-DD HH24:MI:SS.FF'));",
    "INSERT INTO TB_ORDER (ORDER_ID, CUSTOMER_NM, ORDER_DT, UPDATED_AT) VALUES (1043, NULL, TO_DATE('2026-11-05', 'YYYY-MM-DD'), NULL);",
  ]);
  assert.equal(ins.toInsertSql('T', cols, []), '');
  assert.equal(ins.sqlLiteral('abc', cols[0]), "'abc'", '숫자 칸인데 숫자가 아니면 따옴표로');
  assert.match(ins.toInsertSql('T', [{ name: 'lower col', type: 'VARCHAR2', numeric: false }], [['x']]), /\("lower col"\)/, '소문자·공백 이름은 따옴표');
});

test('테이블 이름 짐작: 첫 FROM 뒤 (스키마 포함). 서브쿼리·문자열·주석은 건너뛴다', () => {
  assert.equal(ins.guessTable('select * from TB_ORDER o where 1=1'), 'TB_ORDER');
  assert.equal(ins.guessTable('SELECT a FROM hr.tb_order'), 'hr.tb_order');
  assert.equal(ins.guessTable("select 'from X' c /* from Y */ from TB_REAL"), 'TB_REAL');
  assert.equal(ins.guessTable('select * from "My Table" t'), '"My Table"', '따옴표 이름은 그대로');
  assert.equal(ins.guessTable('select * from hr . tb_order'), 'hr.tb_order');
  assert.equal(ins.guessTable('select * from (select 1 x from dual)'), undefined);
  assert.equal(ins.guessTable('select 1'), undefined);
});
