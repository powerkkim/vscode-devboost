// SQL 로그: MyBatis 로그 → 값을 채운 SQL. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { LogReader, QueryRing, parseParams, bindSql, literal, layoutSql, stripAnsi, consoleText } = require(
  path.join(__dirname, '..', '..', 'out', 'features', 'sqlLog', 'parse.js')
);

const P = '2026-11-10 12:00:00.123 DEBUG 1234 --- [nio-8080-exec-1] c.e.m.UserMapper.selectUser      : ';
const read = (text, reader = new LogReader(() => 1000)) => [...reader.push(text), ...reader.flush()];

test('값 목록: 타입·null·값 안의 쉼표와 괄호', () => {
  assert.deepStrictEqual(parseParams('10(Integer), kim(String), null, a, b (c)(String)'), [
    { value: '10', type: 'Integer' },
    { value: 'kim', type: 'String' },
    { value: null, type: '' },
    { value: 'a, b (c)', type: 'String' },
  ]);
  assert.deepStrictEqual(parseParams(''), []);
  assert.deepStrictEqual(parseParams('null'), [{ value: null, type: '' }]);
  assert.deepStrictEqual(parseParams('(String), x(String)'), [
    { value: '', type: 'String' },
    { value: 'x', type: 'String' },
  ]);
});

test('값 → SQL 글자', () => {
  assert.strictEqual(literal({ value: '10', type: 'Integer' }), '10');
  assert.strictEqual(literal({ value: '1.50', type: 'BigDecimal' }), '1.50');
  assert.strictEqual(literal({ value: "O'Neil", type: 'String' }), "'O''Neil'");
  assert.strictEqual(literal({ value: null, type: '' }), 'NULL');
  assert.strictEqual(literal({ value: 'true', type: 'Boolean' }), '1');
  assert.strictEqual(literal({ value: '2026-11-10 09:30:00.0', type: 'Timestamp' }), "TIMESTAMP '2026-11-10 09:30:00.0'");
  assert.strictEqual(literal({ value: '2026-11-10T09:30', type: 'LocalDateTime' }), "TIMESTAMP '2026-11-10 09:30:00'");
  assert.strictEqual(literal({ value: '2026-11-10', type: 'Date' }), "DATE '2026-11-10'");
  assert.strictEqual(literal({ value: '10', type: 'String' }), "'10'"); // 글자로 넘긴 숫자는 글자 그대로
  assert.strictEqual(literal({ value: 'abc', type: 'Integer' }), "'abc'");
});

test('? 채우기: 따옴표·주석 안의 ? 는 그대로', () => {
  const r = bindSql("SELECT '?' AS Q /* ? */ FROM T WHERE A = ? AND B = ? -- ?", parseParams('1(Integer), x(String)'));
  assert.strictEqual(r.sql, "SELECT '?' AS Q /* ? */ FROM T WHERE A = 1 AND B = 'x' -- ?");
  assert.strictEqual(r.placeholders, 2);
  assert.strictEqual(bindSql('A = ? AND B = ?', parseParams('1(Integer)')).sql, 'A = 1 AND B = ?');
});

test('로그 읽기: Preparing + Parameters + Total', () => {
  const got = read(
    P + '==>  Preparing: SELECT * FROM TB_USER WHERE ID = ? AND NM LIKE ?\r\n' +
      P + '==> Parameters: 10(Integer), %kim%(String)\r\n' +
      P + '<==      Total: 3\r\n'
  );
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sql, "SELECT * FROM TB_USER WHERE ID = 10 AND NM LIKE '%kim%'");
  assert.strictEqual(got[0].mapper, 'UserMapper.selectUser');
  assert.strictEqual(got[0].rows, 3);
  assert.strictEqual(got[0].warn, undefined);
});

test('로그 읽기: 값 없는 쿼리, 조각이 아무 데서나 끊겨도, 색 코드가 섞여도', () => {
  const text =
    '\x1b[32m' + P + '\x1b[0m==>  Preparing: SELECT COUNT(*) FROM TB_USER\n' + P + '==> Parameters: \n' + P + '<==      Total: 1\n';
  const reader = new LogReader(() => 1);
  const got = [];
  for (let i = 0; i < text.length; i += 7) got.push(...reader.push(text.slice(i, i + 7)));
  got.push(...reader.flush());
  assert.deepStrictEqual(got.map((q) => q.sql), ['SELECT COUNT(*) FROM TB_USER']);
  assert.strictEqual(stripAnsi('\x1b[1;31mERR\x1b[0m'), 'ERR');
});

test('로그 읽기: 스레드가 섞여 찍혀도 같은 것끼리 짝', () => {
  const A = '12:00:00.001 [exec-1] DEBUG c.e.m.UserMapper.selectUser - ';
  const B = '12:00:00.002 [exec-2] DEBUG c.e.m.OrderMapper.selectOrder - ';
  const got = read(
    A + '==>  Preparing: SELECT * FROM TB_USER WHERE ID = ?\n' +
      B + '==>  Preparing: SELECT * FROM TB_ORDER WHERE NO = ?\n' +
      B.replace('002', '009') + '==> Parameters: A-1(String)\n' +
      A.replace('001', '015') + '==> Parameters: 7(Long)\n'
  );
  assert.deepStrictEqual(
    got.map((q) => [q.mapper, q.sql]),
    [
      ['OrderMapper.selectOrder', "SELECT * FROM TB_ORDER WHERE NO = 'A-1'"],
      ['UserMapper.selectUser', 'SELECT * FROM TB_USER WHERE ID = 7'],
    ]
  );
});

test('로그 읽기: 터미널 폭에서 잘려 넘어온 줄은 이어 붙인다', () => {
  const got = read(
    P + '==>  Preparing: SELECT A.USER_ID, A.USER_NM FROM TB_US\n' + 'ER A WHERE A.DEPT_CD = ? AND A.USE_YN = ?\n' +
      P + '==> Parameters: D0\n' + '01(String), Y(String)\n' +
      '2026-11-10 12:00:00.200  INFO 1234 --- [main] c.e.App : done\n'
  );
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sql, "SELECT A.USER_ID, A.USER_NM FROM TB_USER A WHERE A.DEPT_CD = 'D001' AND A.USE_YN = 'Y'");
});

test('로그 읽기: 값 개수가 안 맞으면 안내, Preparing 없는 Parameters 는 버림', () => {
  const got = read(P + '==> Parameters: 1(Integer)\n' + P + '==>  Preparing: SELECT 1 FROM DUAL WHERE A = ? AND B = ?\n' + P + '==> Parameters: 1(Integer)\n');
  assert.strictEqual(got.length, 1);
  assert.match(got[0].warn, /\? 2개, 값 1개/);
  assert.strictEqual(got[0].sql, 'SELECT 1 FROM DUAL WHERE A = 1 AND B = ?');
});

test('줄 나누기: 절·AND 앞에서만, 괄호·따옴표·BETWEEN 은 그대로', () => {
  assert.strictEqual(
    layoutSql("SELECT A.ID, (SELECT COUNT(*) FROM T2 WHERE T2.ID = A.ID AND T2.X = 1) CNT FROM TB_A A LEFT OUTER JOIN TB_B B ON B.ID = A.ID WHERE A.DT BETWEEN 1 AND 2 AND A.NM = ' FROM x AND y' OR A.FROM_DT IS NULL ORDER BY A.ID"),
    [
      'SELECT A.ID, (SELECT COUNT(*) FROM T2 WHERE T2.ID = A.ID AND T2.X = 1) CNT',
      'FROM TB_A A',
      'LEFT OUTER JOIN TB_B B ON B.ID = A.ID',
      'WHERE A.DT BETWEEN 1 AND 2',
      "  AND A.NM = ' FROM x AND y'",
      '  OR A.FROM_DT IS NULL',
      'ORDER BY A.ID',
    ].join('\n')
  );
  assert.strictEqual(layoutSql('UPDATE TB_A SET NM = 1 WHERE ID = 2'), 'UPDATE TB_A\nSET NM = 1\nWHERE ID = 2');
});

test('최근 목록: 새 것이 앞, 개수 제한, 같은 쿼리가 이어 오면 하나로', () => {
  const ring = new QueryRing(3);
  const q = (sql, time) => ({ sql, mapper: 'M.a', time });
  ring.add(q('S1', 1));
  ring.add(q('S1', 2));
  assert.strictEqual(ring.items().length, 1);
  assert.strictEqual(ring.items()[0].time, 2);
  const id1 = ring.items()[0].id;
  ring.add(q('S2', 3));
  ring.add(q('S3', 4));
  ring.add(q('S4', 5));
  assert.deepStrictEqual(ring.items().map((x) => x.sql), ['S4', 'S3', 'S2']);
  assert.strictEqual(ring.get(id1), undefined); // 밀려난 것
  assert.strictEqual(ring.get(ring.items()[1].id).sql, 'S3');
});

test('콘솔에 넣을 글: 머리 주석은 mapper 머리 주석(-- 네임스페이스.id)과 겹치지 않는 모양', () => {
  const text = consoleText({ sql: 'SELECT 1 FROM DUAL WHERE A = 1', mapper: 'UserMapper.selectUser', time: 0, rows: 2 }, '12:00:01');
  assert.strictEqual(text, '-- [로그 12:00:01] UserMapper.selectUser · 2건\nSELECT 1\nFROM DUAL\nWHERE A = 1;');
  const { parseMapperHeader } = require(path.join(__dirname, '..', '..', 'out', 'features', 'mybatisRunner', 'mapper', 'consoleSql.js'));
  assert.strictEqual(parseMapperHeader(text.split('\n')[0]), undefined);
});
