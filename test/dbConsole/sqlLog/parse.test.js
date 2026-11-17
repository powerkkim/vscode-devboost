// SQL 로그: MyBatis 로그 → 값을 채운 SQL. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { LogReader, QueryRing, parseParams, bindSql, literal, layoutSql, stripAnsi, consoleText } = require(
  path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'sqlLog', 'parse.js')
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

test('최근 목록: 새 것이 앞, 요청(묶음) 개수 제한, 같은 묶음에서 같은 쿼리가 이어 오면 하나로', () => {
  const ring = new QueryRing(3);
  // 요청 줄이 없는 쿼리: 스레드가 다르거나 2초 넘게 떨어지면 다른 묶음
  const q = (sql, thread, at) => ({ sql, mapper: 'M.a', time: at, thread, at });
  ring.add(q('S1', 'exec-1', 1000));
  ring.add(q('S1', 'exec-1', 1001));
  assert.strictEqual(ring.items().length, 1);
  assert.strictEqual(ring.items()[0].time, 1001);
  const id1 = ring.items()[0].id;
  ring.add(q('S2', 'exec-2', 1002));
  ring.add(q('S3', 'exec-1', 9000));
  ring.add(q('S4', 'exec-1', 9001));
  ring.add(q('S5', 'exec-3', 9002));
  assert.deepStrictEqual(ring.groups().map((g) => g.queries.map((x) => x.sql)), [['S5'], ['S3', 'S4'], ['S2']]);
  assert.strictEqual(ring.get(id1), undefined); // 밀려난 묶음
  assert.strictEqual(ring.get(ring.items()[1].id).sql, 'S4');
});

test('콘솔에 넣을 글: 머리 주석은 mapper 머리 주석(-- 네임스페이스.id)과 겹치지 않는 모양', () => {
  const text = consoleText({ sql: 'SELECT 1 FROM DUAL WHERE A = 1', mapper: 'UserMapper.selectUser', time: 0, rows: 2 }, '12:00:01');
  assert.strictEqual(text, '-- [로그 12:00:01] UserMapper.selectUser · 2건\nSELECT 1\nFROM DUAL\nWHERE A = 1;');
  const { parseMapperHeader } = require(path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'mybatis', 'mapper', 'consoleSql.js'));
  assert.strictEqual(parseMapperHeader(text.split('\n')[0]), undefined);
});

// ───────── log4jdbc (jdbc.sqltiming · jdbc.sqlonly) ─────────
const { queryTitle, queryInfo, queryMapper } = require(path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'sqlLog', 'parse.js'));

const T = '20170202 20:37:02.0';
const SQLTIMING_BLOCK = [
  T + '40 [http-nio-7070-exec-5] DEBUG j.sqltiming -  sun.reflect.NativeMethodAccessorImpl.invoke0(null:-2)',
  '10. SELECT /*"selectOneUser"*/',
  '                USER_ID,',
  '                    EMAIL,',
  '                    DELETE_YN,',
  '                    SUPER_USER',
  '           FROM LCUSRBASE',
  "          WHERE EMAIL = 'abc@test.com'",
  "            AND DELETE_YN = 'N'",
  ' {executed in 3 msec}',
  T + '45 [http-nio-7070-exec-5] INFO j.resultsettable - ',
  '|--------|',
  '|user_id |',
  '',
].join('\r\n');
const TIDY = [
  'SELECT /*"selectOneUser"*/',
  '      USER_ID,',
  '          EMAIL,',
  '          DELETE_YN,',
  '          SUPER_USER',
  ' FROM LCUSRBASE',
  "WHERE EMAIL = 'abc@test.com'",
  "  AND DELETE_YN = 'N'",
].join('\n');

test('log4jdbc: j.sqltiming 덩어리 — 호출 위치·번호를 떼고, 들여쓰기를 줄이고, 실행 시간을 적는다', () => {
  const got = read(SQLTIMING_BLOCK);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sql, TIDY);
  assert.strictEqual(got[0].ms, 3);
  assert.strictEqual(queryTitle(got[0]), 'selectOneUser');
  assert.strictEqual(queryInfo(got[0]), '3ms');
  // 여러 줄로 찍힌 SQL 은 줄을 다시 나누지 않는다
  assert.strictEqual(consoleText(got[0], '20:37:02'), '-- [로그 20:37:02] selectOneUser · 3ms\n' + TIDY + ';');
});

test('log4jdbc: MyBatis 로그와 같이 찍히면 한 건 (이름은 MyBatis, SQL·시간은 log4jdbc, 건수는 Total)', () => {
  const M = '[http-nio-7070-exec-5] DEBUG c.l.c.u.m.L.selectOneUserForLogin - ';
  const got = read(
    T + '30 ' + M + '==>  Preparing: SELECT /*"selectOneUser"*/ USER_ID, EMAIL, DELETE_YN, SUPER_USER FROM LCUSRBASE WHERE EMAIL = ? AND DELETE_YN = \'N\'\r\n' +
      T + '37 ' + M + '==> Parameters: abc@test.com(String)\r\n' +
      SQLTIMING_BLOCK +
      T + '50 ' + M + '<==      Total: 1\r\n'
  );
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sql, TIDY);
  assert.strictEqual(got[0].mapper, 'selectOneUserForLogin'); // 줄여 찍힌 클래스(L)는 뺀다
  assert.strictEqual(got[0].ms, 3);
  assert.strictEqual(got[0].rows, 1);
  assert.strictEqual(queryInfo(got[0]), '1건 · 3ms');
  // 제목은 SQL 머리 주석의 쿼리 id, mapper 메서드는 다를 때만 곁들인다
  assert.strictEqual(queryTitle(got[0]), 'selectOneUser');
  assert.strictEqual(queryMapper(got[0]), 'selectOneUserForLogin');
  assert.match(consoleText(got[0], 't'), /^-- \[로그 t\] selectOneUser \(selectOneUserForLogin\) · 1건 · 3ms\n/);
  assert.strictEqual(queryMapper({ sql: 'SELECT /* selectA */ 1 FROM DUAL', mapper: 'AMapper.selectA', time: 0 }), '');
  assert.strictEqual(queryTitle({ sql: 'SELECT /* 사용자 조회 */ 1 FROM DUAL', mapper: 'AMapper.selectA', time: 0 }), 'AMapper.selectA');
});

test('log4jdbc: 이 시각 형식(20170202 20:37:02.037)에서 MyBatis 값 줄 뒤의 줄이 붙지 않는다', () => {
  const M = '[exec-1] DEBUG c.e.m.UserMapper.selectUser - ';
  const got = read(
    T + '30 ' + M + '==>  Preparing: SELECT 1 FROM DUAL WHERE A = ?\n' + T + '31 ' + M + '==> Parameters: x(String)\n' + T + '32 [exec-1] INFO c.e.Other - hello\n'
  );
  assert.deepStrictEqual(got.map((q) => q.sql), ["SELECT 1 FROM DUAL WHERE A = 'x'"]);
});

test('log4jdbc: 한 줄로 찍힌 것, 실패, 이어지는 같은 쿼리, sqlonly + sqltiming 은 한 건', () => {
  const H = '2026-11-12 00:20:01.123  INFO 1 --- [exec-1] jdbc.sqltiming : ';
  const one = read(H + 'UPDATE TB_ORDER SET STATUS = \'DONE\' WHERE ORDER_NO = 1001 {executed in 12 msec}\n');
  assert.deepStrictEqual(one.map((q) => [q.sql, q.ms, queryTitle(q)]), [["UPDATE TB_ORDER SET STATUS = 'DONE' WHERE ORDER_NO = 1001", 12, 'UPDATE TB_ORDER']]);
  assert.strictEqual(consoleText(one[0], 't'), "-- [로그 t] UPDATE TB_ORDER · 12ms\nUPDATE TB_ORDER\nSET STATUS = 'DONE'\nWHERE ORDER_NO = 1001;");

  const failed = read(H + 'SELECT X FROM NO_TABLE {FAILED after 2 msec}\n');
  assert.strictEqual(failed[0].failed, true);
  assert.strictEqual(queryInfo(failed[0]), '2ms · 실패');

  // 같은 스레드에서 같은 쿼리가 두 번 실행되면 두 건으로 읽힌다 (목록에서 하나로 합치는 건 QueryRing)
  const twice = read((H + 'SELECT 1 FROM DUAL {executed in 1 msec}\n').repeat(2));
  assert.strictEqual(twice.length, 2);

  const O = '2026-11-12 00:20:01.100  INFO 1 --- [exec-1] jdbc.sqlonly   : ';
  const both = read(O + 'SELECT A\n  FROM TB_A\n WHERE X = 1\n' + H + 'SELECT A\n  FROM TB_A\n WHERE X = 1\n {executed in 4 msec}\n');
  assert.strictEqual(both.length, 1);
  assert.strictEqual(both[0].sql, 'SELECT A\n FROM TB_A\nWHERE X = 1');
  assert.strictEqual(both[0].ms, 4);

  // sqlonly 만 켜져 있으면 꼬리가 없다 → 로그가 멈췄을 때(flush) 끝난다
  const only = new LogReader(() => 1);
  assert.strictEqual(only.push(O + 'SELECT B\n  FROM TB_B\n').length, 0);
  assert.deepStrictEqual(only.flush().map((q) => q.sql), ['SELECT B\nFROM TB_B']);
});

test('log4jdbc: SQL 안에 로그 수준 같은 낱말·빈 줄이 있어도 덩어리가 끊기지 않고, 다른 스레드와 섞이지 않는다', () => {
  const got = read(
    '12:00:00.001 [exec-1] DEBUG jdbc.sqltiming - \n3. SELECT INFO,\n       ERROR_CD\n\n  FROM TB_LOG\n {executed in 1 msec}\n' +
      '12:00:00.002 [exec-2] DEBUG c.e.m.AMapper.selectA - ==>  Preparing: SELECT INFO, ERROR_CD FROM TB_LOG WHERE ID = ?\n' +
      '12:00:00.003 [exec-2] DEBUG c.e.m.AMapper.selectA - ==> Parameters: 5(Integer)\n'
  );
  assert.deepStrictEqual(got.map((q) => q.sql), ['SELECT INFO,\n     ERROR_CD\n\nFROM TB_LOG', 'SELECT INFO, ERROR_CD FROM TB_LOG WHERE ID = 5']);
  assert.strictEqual(queryTitle(got[0]), 'SELECT TB_LOG');
});

// ───────── 목록 요약 ─────────
const { summarize } = require(path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'sqlLog', 'parse.js'));

test('요약: 종류·테이블·값이 보이는 조건', () => {
  assert.deepStrictEqual(summarize(TIDY), { verb: 'SELECT', tables: 'LCUSRBASE', cond: "EMAIL = 'abc@test.com'" });
  assert.deepStrictEqual(
    summarize("SELECT R.ROLE_ID FROM LCUSRROLE UR JOIN LCROLEBASE R ON R.ROLE_ID = UR.ROLE_ID WHERE 1 = 1 AND R.USE_YN IS NOT NULL AND UR.USER_ID = 'U0012' ORDER BY 1"),
    { verb: 'SELECT', tables: 'LCUSRROLE, LCROLEBASE', cond: "UR.USER_ID = 'U0012'" }
  );
  assert.deepStrictEqual(summarize("UPDATE TB_ORDER SET STATUS = 'DONE' WHERE ORDER_NO = 1001"), { verb: 'UPDATE', tables: 'TB_ORDER', cond: 'ORDER_NO = 1001' });
  assert.deepStrictEqual(summarize("INSERT INTO LCLOGINHIST (USER_ID, LOGIN_IP) VALUES ('U0012', '10.0.0.7')"), {
    verb: 'INSERT',
    tables: 'LCLOGINHIST',
    cond: "VALUES ('U0012', '10.0.0.7')",
  });
  assert.deepStrictEqual(summarize('DELETE FROM LCTOKEN WHERE EXPIRE_DT < SYSDATE'), { verb: 'DELETE', tables: 'LCTOKEN', cond: 'EXPIRE_DT < SYSDATE' });
  // 서브쿼리 안의 WHERE·AND, 따옴표 안의 낱말, BETWEEN 의 AND 에 속지 않는다
  assert.deepStrictEqual(
    summarize("SELECT A.ID, (SELECT COUNT(*) FROM T2 WHERE T2.ID = A.ID AND T2.X = 9) C FROM TB_A A WHERE A.NM = ' WHERE x AND y' AND A.DT BETWEEN 1 AND 2 GROUP BY A.ID"),
    { verb: 'SELECT', tables: 'T2, TB_A', cond: "A.NM = ' WHERE x AND y'" }
  );
  assert.deepStrictEqual(summarize('SELECT A FROM T1 WHERE DT BETWEEN SYSDATE - 7 AND SYSDATE OR X IS NULL').cond, 'DT BETWEEN SYSDATE - 7 AND SYSDATE');
  assert.deepStrictEqual(summarize('SELECT 1 FROM DUAL'), { verb: 'SELECT', tables: 'DUAL', cond: '' });
  assert.deepStrictEqual(summarize('SELECT A FROM T1 A, T2 AS B, T3, T4 WHERE A.ID = B.ID').tables, 'T1, T2, T3, …');
  assert.deepStrictEqual(summarize('SELECT A FROM T1 A JOIN T6 ON 1 = 1').tables, 'T1, T6');
});

// ───────── 로거를 몰라도 읽기 (SQL 로 시작하는 로그) · 설정 낱말 ─────────
const readWith = (text, options) => read(text, new LogReader(() => 1, options));

test('자동: 로그 내용이 SQL 로 시작하면 다음 로그 줄 전까지 한 건 (한 줄 · 여러 줄 · 주석 먼저)', () => {
  const H = '2026-11-12 00:20:01.123  INFO 1 --- [exec-1] c.e.common.SqlLogger : ';
  const got = read(
    H + "SELECT A.ID FROM TB_A A WHERE A.CD = 'X'\n" +
      H + '/* orderList */ SELECT O.NO\n         FROM TB_ORDER O\n        WHERE O.NO = 7\n' +
      H + 'done\n' +
      '12:00:01 [exec-2] DEBUG c.e.Dao - \n    update TB_A\n       set NM = 1\n     where ID = 2\n' +
      '12:00:02 [exec-2] INFO c.e.App - next\n'
  );
  assert.deepStrictEqual(got.map((q) => q.sql), [
    "SELECT A.ID FROM TB_A A WHERE A.CD = 'X'",
    '/* orderList */ SELECT O.NO\n FROM TB_ORDER O\nWHERE O.NO = 7',
    'update TB_A\n   set NM = 1\n where ID = 2',
  ]);
  assert.strictEqual(queryTitle(got[1]), 'orderList');
  assert.strictEqual(got[0].unbound, undefined);
});

test('자동: Hibernate 로그 — 한 줄(로거)·여러 줄(Hibernate:), 값이 없는 ? 는 표시', () => {
  const got = read(
    '2026-11-12T00:20:01.123+09:00 DEBUG 1 --- [nio-8080-exec-1] org.hibernate.SQL : select u1_0.id,u1_0.name from users u1_0 where u1_0.id=?\n' +
      'Hibernate: \n    select\n        u1_0.id\n    from\n        users u1_0\n    where\n        u1_0.email=?\n' +
      'Hibernate: insert into users (name) values (?)\n'
  );
  assert.deepStrictEqual(got.map((q) => q.sql), [
    'select u1_0.id,u1_0.name from users u1_0 where u1_0.id=?',
    'select\n    u1_0.id\nfrom\n    users u1_0\nwhere\n    u1_0.email=?',
    'insert into users (name) values (?)',
  ]);
  assert.strictEqual(got[0].unbound, true);
  assert.strictEqual(queryInfo(got[0]), '? 값 없음');
});

test('자동: SQL 이 아닌 로그는 읽지 않는다', () => {
  const H = '2026-11-12 00:20:01.123  INFO 1 --- [main] c.e.App : ';
  const got = read(
    H + 'Update done for user 7\n' +
      H + 'select a profile with --spring.profiles.active\n' +
      H + 'with great power\n' +
      H + 'Started App in 3.2 seconds\n' +
      '20170202 20:37:02.045 [exec-5] INFO j.resultsettable - \n|--------|\n|user_id |\n|--------|\n' +
      H + '\njava.lang.IllegalStateException: select failed\n\tat c.e.App.main(App.java:1)\n'
  );
  assert.deepStrictEqual(got, []);
});

test('자동: 같은 실행을 MyBatis 도 찍으면 한 건 — 값이 채워진 SQL 을 남긴다 (순서가 어느 쪽이어도)', () => {
  const M = '12:00:00.001 [exec-1] DEBUG c.e.m.AMapper.selectA - ';
  const R = '12:00:00.000 [exec-1] DEBUG c.e.SqlTrace - ';
  const prep = M + '==>  Preparing: SELECT A FROM TB_A WHERE ID = ?\n' + M + '==> Parameters: 5(Integer)\n';
  const raw = R + 'SELECT A FROM TB_A WHERE ID = ?\n';
  for (const text of [raw + prep, prep + raw]) {
    const got = read(text + M + '<==      Total: 1\n');
    assert.deepStrictEqual(got.map((q) => [q.sql, q.mapper, q.unbound, q.rows]), [['SELECT A FROM TB_A WHERE ID = 5', 'AMapper.selectA', undefined, 1]]);
  }
});

test('설정 낱말: 그 낱말이 있는 로그 줄부터 다음 로그 줄 전까지 (자동을 꺼도, SQL 로 시작하지 않아도)', () => {
  const text =
    '12:00:00.001 [exec-1] INFO SQL_LOG ▶ [selectA] 3ms\n  SELECT A\n    FROM TB_A\n' +
    '12:00:00.002 [exec-1] INFO c.e.App - SELECT B FROM TB_B\n' +
    '12:00:00.003 [exec-1] INFO c.e.App - bye\n';
  assert.deepStrictEqual(readWith(text, { auto: false, keywords: ['SQL_LOG ▶'] }).map((q) => q.sql), ['[selectA] 3ms\nSELECT A\n  FROM TB_A']);
  assert.deepStrictEqual(readWith(text, { auto: false }).map((q) => q.sql), []);
  assert.deepStrictEqual(readWith(text, {}).map((q) => q.sql), ['SELECT B FROM TB_B']);
});

test('자동을 켜도 MyBatis · log4jdbc 로그는 한 번씩만 읽힌다', () => {
  const got = read(
    T + '30 [http-nio-7070-exec-5] DEBUG c.l.c.u.m.L.selectOneUserForLogin - ==>  Preparing: SELECT /*"selectOneUser"*/ USER_ID, EMAIL, DELETE_YN, SUPER_USER FROM LCUSRBASE WHERE EMAIL = ? AND DELETE_YN = \'N\'\r\n' +
      T + '37 [http-nio-7070-exec-5] DEBUG c.l.c.u.m.L.selectOneUserForLogin - ==> Parameters: abc@test.com(String)\r\n' +
      SQLTIMING_BLOCK
  );
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].sql, TIDY);
});

// ── 수집 필터
const { QueryFilter, filterPattern, tableNames, sameQueryKey, excludeWords } = require(path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'sqlLog', 'parse.js'));
const Q = (sql, mapper = '') => ({ sql, mapper, time: 1 });

test('수집 필터 낱말: 대소문자 무시 · 낱말 단위 · * · 공백', () => {
  const t = (w, s) => filterPattern(w).test(s);
  assert.ok(t('TB_USER', 'FROM tb_user u'));
  assert.ok(!t('TB_USER', 'FROM TB_USER_ROLE'));
  assert.ok(t('TB_COMM*', 'FROM TB_COMMON_CODE'));
  assert.ok(t('*Common*', 'selectCommonCode'));
  assert.ok(t('CommonMapper', 'com.x.CommonMapper.selectCode'));
  assert.ok(!t('common', 'com.x.CommonMapper.selectCode'));
  assert.ok(t('from dual', 'SELECT 1 FROM\n   DUAL'));
  assert.ok(t('a.b(', 'x a.b(1)'));
  assert.strictEqual(filterPattern('  '), undefined);
  assert.strictEqual(filterPattern('**'), undefined);
});

test('수집 필터: 쿼리 id · mapper · SQL 에서 찾고, 제외가 포함보다 먼저', () => {
  const common = Q('SELECT /* selectCommonCode */ CD FROM TB_COMMON_CODE WHERE GRP = \'A\'', 'com.x.CommonMapper.selectCommonCode');
  const order = Q('SELECT * FROM TB_ORDER WHERE NO = 1', 'com.x.OrderMapper.selectOrder');
  const none = new QueryFilter();
  assert.ok(none.accepts(common) && none.accepts(order));
  assert.ok(!new QueryFilter([], ['selectCommonCode']).accepts(common));
  assert.ok(!new QueryFilter([], ['CommonMapper']).accepts(common));
  assert.ok(!new QueryFilter([], ['TB_COMMON*']).accepts(common));
  assert.ok(new QueryFilter([], ['TB_COMMON']).accepts(common));
  const inc = new QueryFilter(['OrderMapper'], []);
  assert.ok(inc.accepts(order) && !inc.accepts(common));
  assert.ok(!new QueryFilter(['OrderMapper'], ['TB_ORDER']).accepts(order));
  assert.ok(new QueryFilter(['', '*'], ['  ']).accepts(common), '빈 낱말은 없는 것');
});

test('최근 쿼리 목록: 필터에 걸리면 넣지 않고 세기, 필터 바꾸면 모인 것에도 적용, 같은 쿼리 id 는 최신 하나', () => {
  const ring = new QueryRing(5, new QueryFilter([], ['TB_LOG']));
  assert.strictEqual(ring.add(Q('INSERT INTO TB_LOG VALUES (1)')), false);
  assert.strictEqual(ring.add(Q('SELECT /* a.sel */ 1 FROM T1')), true);
  ring.add(Q('SELECT 2 FROM T2', 'M.two'));
  ring.add(Q('SELECT /* a.sel */ 3 FROM T1'));
  assert.deepStrictEqual([ring.items().length, ring.excluded], [3, 1]);
  // 제외를 TB_LOG → T2 로: T2 · 예전 a.sel 이 빠지고, 걸려 있던 TB_LOG 는 돌아온다
  assert.deepStrictEqual(ring.setFilter(new QueryFilter([], ['T2']), true), { removed: 2, restored: 1 });
  assert.deepStrictEqual(ring.items().map((q) => q.sql), ['SELECT /* a.sel */ 3 FROM T1', 'INSERT INTO TB_LOG VALUES (1)']);
  assert.strictEqual(ring.excluded, 1, '걸려 있는 것: T2 (같은 id 로 밀린 예전 a.sel 은 걸린 것이 아님)');
  ring.add(Q('SELECT /* a.sel */ 4 FROM T1'));
  ring.add(Q('SELECT 5 FROM T5'));
  ring.add(Q('SELECT 6 FROM T5'));
  assert.deepStrictEqual(ring.items().map((q) => q.sql), ['SELECT 6 FROM T5', 'SELECT 5 FROM T5', 'SELECT /* a.sel */ 4 FROM T1', 'INSERT INTO TB_LOG VALUES (1)'], 'id 없는 쿼리는 하나로 합치지 않음');
  ring.clear();
  assert.deepStrictEqual([ring.items().length, ring.excluded], [0, 0]);
  assert.strictEqual(sameQueryKey(Q('SELECT 1', 'M.x')), 'M.x');
});

test('고르는 창의 수집 제외 단추: 쿼리 id(없으면 mapper) · 테이블', () => {
  assert.deepStrictEqual(tableNames('SELECT * FROM A a JOIN B ON 1=1, C WHERE X IN (SELECT 1 FROM A)'), ['A', 'B']);
  assert.deepStrictEqual(excludeWords(Q('SELECT /* selectUser */ * FROM TB_USER U JOIN TB_DEPT D ON 1=1', 'x.UserMapper.selectUser')), [
    { word: 'selectUser', kind: 'query' },
    { word: 'TB_USER', kind: 'table' },
    { word: 'TB_DEPT', kind: 'table' },
  ]);
  assert.deepStrictEqual(excludeWords(Q('UPDATE TB_X SET A = 1', 'x.M.upd')).map((x) => x.word), ['x.M.upd', 'TB_X']);
  assert.deepStrictEqual(excludeWords(Q('SELECT 1')), []);
});

test('최근 쿼리 목록: 필터를 풀면 걸려 있던 쿼리가 차례대로 돌아온다 (최근 50개까지)', () => {
  const ring = new QueryRing(10, new QueryFilter([], ['TB_CODE']));
  ring.add(Q('SELECT 1 FROM TB_A'));
  ring.add(Q('SELECT 2 FROM TB_CODE'));
  ring.add(Q('SELECT 3 FROM TB_B'));
  ring.add(Q('SELECT 4 FROM TB_CODE'));
  assert.deepStrictEqual([ring.items().length, ring.excluded], [2, 2]);
  assert.deepStrictEqual(ring.setFilter(new QueryFilter(), false), { removed: 0, restored: 2 });
  assert.deepStrictEqual(ring.items().map((q) => q.sql), ['SELECT 4 FROM TB_CODE', 'SELECT 3 FROM TB_B', 'SELECT 2 FROM TB_CODE', 'SELECT 1 FROM TB_A']);
  assert.strictEqual(ring.excluded, 0);
  // 포함만: TB_A 만 남고 나머지는 걸려 있다가, 다시 풀면 돌아온다
  assert.deepStrictEqual(ring.setFilter(new QueryFilter(['TB_A'], []), false), { removed: 3, restored: 0 });
  assert.deepStrictEqual(ring.setFilter(new QueryFilter(), false).restored, 3);
  // 기억은 50개까지, 넘친 것은 개수만
  const many = new QueryRing(5, new QueryFilter([], ['X']));
  for (let i = 0; i < 60; i++) many.add(Q(`SELECT ${i} FROM X`));
  assert.strictEqual(many.excluded, 60);
  assert.strictEqual(many.setFilter(new QueryFilter(), false).restored, 50, '기억한 50개가 돌아옴 (한 묶음에 50개까지)');
  assert.deepStrictEqual(many.items()[0].sql, 'SELECT 59 FROM X');
});

// ── Run · Debug 로 띄운 Java 서버: 실행 설정 바꾸기
const { redirectJavaLaunch, toTerminalText, MARK } = require(path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'sqlLog', 'launch.js'));

test('Java 실행 설정: 출력 곳을 정하지 않았거나 통합 터미널이면 디버그 콘솔로 받아 확장 터미널에', () => {
  const base = { type: 'java', request: 'launch', name: 'DemoApplication', mainClass: 'com.x.Demo' };
  const r = redirectJavaLaunch(base);
  assert.deepStrictEqual(r, { ...base, console: 'internalConsole', internalConsoleOptions: 'neverOpen', vmArgs: '-Dspring.output.ansi.enabled=ALWAYS', [MARK]: true });
  assert.strictEqual(base.console, undefined, '원래 설정은 그대로');
  assert.strictEqual(redirectJavaLaunch({ ...base, console: 'integratedTerminal', vmArgs: '-Xmx1g' }).vmArgs, '-Xmx1g -Dspring.output.ansi.enabled=ALWAYS');
  assert.deepStrictEqual(redirectJavaLaunch({ ...base, vmArgs: ['-Xmx1g'] }).vmArgs, ['-Xmx1g', '-Dspring.output.ansi.enabled=ALWAYS']);
  assert.strictEqual(redirectJavaLaunch({ ...base, vmArgs: '-Dspring.output.ansi.enabled=NEVER' }).vmArgs, '-Dspring.output.ansi.enabled=NEVER');
  // 따로 정해 둔 출력 곳 · attach · 다른 언어는 그대로
  for (const keep of [{ ...base, console: 'internalConsole' }, { ...base, console: 'externalTerminal' }, { ...base, request: 'attach' }, { type: 'node', request: 'launch' }]) {
    assert.strictEqual(redirectJavaLaunch(keep), keep);
  }
  assert.strictEqual(toTerminalText('a\nb\r\nc'), 'a\r\nb\r\nc');
});

// ── 요청 단위 (요청 top 10)
const { threadOf, logTimeOf, repeats, repeatKey, PER_REQUEST, groupConsoleText } = require(path.join(__dirname, '..', '..', '..', 'out', 'features', 'dbConsole', 'sqlLog', 'parse.js'));

test('스레드 · 로그 시각: Spring Boot 2 · 3.4 · logback, 로그 내용의 [..] 는 보지 않음', () => {
  assert.strictEqual(threadOf('2026-11-15 01:10:00.123 DEBUG 1 --- [nio-8080-exec-1] c.e.b.m.PostMapper.findPostById   : ==>  Preparing'), 'nio-8080-exec-1');
  assert.strictEqual(threadOf('2026-11-15T01:50:00.000+09:00 DEBUG 1 --- [demo] [nio-8081-exec-1] c.e.d.mapper.PostMapper : ==> x'), 'nio-8081-exec-1');
  assert.strictEqual(threadOf('01:10:00.123 [http-nio-8080-exec-1] DEBUG c.e.b.m.X - [REQ][e2] GET /a'), 'http-nio-8080-exec-1');
  assert.strictEqual(threadOf('2026-11-15 01:10:00 [DEBUG] [main] c.e.App : started'), 'main');
  assert.strictEqual(threadOf('2026-11-15 01:10:00.200  INFO 1 --- [exec-2] c.e.LogFilter : [REQ][e2ccdecf] GET /x'), 'exec-2');
  assert.strictEqual(logTimeOf('2026-11-15T01:50:00.123+09:00 DEBUG'), ((1 * 60 + 50) * 60) * 1000 + 123);
  assert.strictEqual(logTimeOf('01:10:02,5 [x]'), ((1 * 60 + 10) * 60 + 2) * 1000 + 500);
  assert.strictEqual(logTimeOf('no time here'), undefined);
});

/** 로그 줄 만들기 (Spring Boot 3.4 모양) */
const L = (time, thread, logger, msg) => `2026-11-17T${time}+09:00 DEBUG 1 --- [demo] [${thread}] ${logger} : ${msg}`;
const M = (time, thread, id, msg) => L(time, thread, `c.e.d.mapper.${id}`, msg);

test('요청 묶기: [REQ][id] ~ [RES][id] 사이 같은 스레드의 쿼리, 상태 · 시간 · 몇 ms 뒤에 돌았는지', () => {
  const r = new LogReader(() => 1);
  const lines = [
    L('22:00:00.000', 'exec-1', 'c.e.common.config.LogFilter', '[REQ][47be5123] GET /api/blog/posts?page=0&size=12 | ip=0:0:0:0:0:0:0:1'),
    M('22:00:00.010', 'exec-1', 'PostMapper.findPostAll', '==>  Preparing: SELECT p.id FROM tb_posts p FETCH NEXT ? ROWS ONLY'),
    M('22:00:00.011', 'exec-1', 'PostMapper.findPostAll', '==> Parameters: 12(Integer)'),
    M('22:00:00.020', 'exec-1', 'PostMapper.findPostAll', '<==      Total: 12'),
    // 다른 요청이 다른 스레드에서 겹쳐 돈다
    L('22:00:00.030', 'exec-2', 'c.e.common.config.LogFilter', '[REQ][2c3c1149] GET /api/blog/posts/261'),
    M('22:00:00.040', 'exec-2', 'PostMapper.findPostById', '==>  Preparing: SELECT * FROM tb_posts WHERE id = ?'),
    M('22:00:00.041', 'exec-2', 'PostMapper.findPostById', '==> Parameters: 261(Long)'),
    M('22:00:00.201', 'exec-1', 'PostMapper.countPostAll', "==>  Preparing: SELECT COUNT(*) FROM tb_posts WHERE visibility = 'BLOG'"),
    M('22:00:00.202', 'exec-1', 'PostMapper.countPostAll', '==> Parameters: '),
    L('22:00:00.236', 'exec-1', 'c.e.common.config.LogFilter', '[RES][47be5123] GET /api/blog/posts | status=200 | 236ms'),
    L('22:00:00.300', 'exec-2', 'c.e.common.config.LogFilter', '[RES][2c3c1149] GET /api/blog/posts/261 | status=404 | 270ms'),
    M('22:00:05.000', 'scheduling-1', 'CodeMapper.selectCodes', '==>  Preparing: SELECT CD FROM TB_CODE'),
    M('22:00:05.001', 'scheduling-1', 'CodeMapper.selectCodes', '==> Parameters: '),
  ];
  const found = [...r.push(lines.join('\n') + '\n'), ...r.flush()];
  const ring = new QueryRing(10);
  found.forEach((q) => ring.add(q));
  const g = ring.groups();
  assert.deepStrictEqual(
    g.map((x) => [x.req ? `${x.req.method} ${x.req.url} ${x.req.status} ${x.req.ms} ${x.req.key}` : `스레드 ${x.thread}`, x.queries.map((q) => queryTitle(q))]),
    [
      ['스레드 scheduling-1', ['CodeMapper.selectCodes']],
      ['GET /api/blog/posts/261 404 270 2c3c1149', ['PostMapper.findPostById']],
      ['GET /api/blog/posts?page=0&size=12 200 236 47be5123', ['PostMapper.findPostAll', 'PostMapper.countPostAll']],
    ]
  );
  const posts = g[2];
  assert.deepStrictEqual(posts.queries.map((q) => q.at - posts.req.at), [11, 202]);
  assert.strictEqual(posts.queries[0].rows, 12);
});

test('요청 묶기: DispatcherServlet DEBUG 로그, 끝 줄 없이 다음 요청이 오면 앞 요청을 닫음, 요청 줄이 없으면 스레드 · 2초', () => {
  const r = new LogReader(() => 1);
  const D = (t, msg) => L(t, 'exec-5', 'o.s.web.servlet.DispatcherServlet', msg);
  const lines = [
    D('10:00:00.000', 'GET "/api/orders?page=1", parameters={masked}'),
    M('10:00:00.050', 'exec-5', 'OrderMapper.list', '==>  Preparing: SELECT * FROM TB_ORDER'),
    M('10:00:00.051', 'exec-5', 'OrderMapper.list', '==> Parameters: '),
    D('10:00:00.120', 'Completed 200 OK'),
    D('10:00:01.000', 'Completed initialization in 0 ms'),
    D('10:00:02.000', 'POST "/api/orders", parameters={}'),
    M('10:00:02.010', 'exec-5', 'OrderMapper.insert', '==>  Preparing: INSERT INTO TB_ORDER VALUES (?)'),
    M('10:00:02.011', 'exec-5', 'OrderMapper.insert', '==> Parameters: 1(Integer)'),
  ];
  const found = [...r.push(lines.join('\n') + '\n'), ...r.flush()];
  assert.deepStrictEqual(found.map((q) => [q.req.method, q.req.url, q.req.status, q.req.ms, !!q.req.ended]), [
    ['GET', '/api/orders?page=1', 200, 120, true],
    ['POST', '/api/orders', undefined, undefined, false],
  ]);
});

test('N+1: 값만 다른 같은 쿼리가 한 요청에서 여러 번, 요청 하나에 50개까지 담고 나머지는 개수만', () => {
  const r = new LogReader(() => 1);
  const lines = [L('11:00:00.000', 'e1', 'c.e.LogFilter', '[REQ][a1] GET /api/blog/posts')];
  for (let i = 0; i < 60; i++) {
    lines.push(M('11:00:00.100', 'e1', 'TagMapper.findTags', '==>  Preparing: SELECT name FROM tb_tag WHERE post_id = ?'));
    lines.push(M('11:00:00.101', 'e1', 'TagMapper.findTags', `==> Parameters: ${300 - i}(Long)`));
  }
  lines.push(L('11:00:00.400', 'e1', 'c.e.LogFilter', '[RES][a1] GET /api/blog/posts | status=200 | 400ms'));
  // 반복 앞에 주 쿼리가 하나 있다 — 넘쳐도 주 쿼리는 남아야 한다
  lines.splice(1, 0, M('11:00:00.050', 'e1', 'PostMapper.list', '==>  Preparing: SELECT * FROM tb_posts'), M('11:00:00.051', 'e1', 'PostMapper.list', '==> Parameters: '));
  const ring = new QueryRing(10);
  [...r.push(lines.join('\n') + '\n'), ...r.flush()].forEach((q) => ring.add(q));
  const [g] = ring.groups();
  assert.deepStrictEqual([g.queries.length, g.overflow], [PER_REQUEST, 11]);
  assert.strictEqual(queryTitle(g.queries[0]), 'PostMapper.list', '먼저 돈 주 쿼리는 남는다');
  assert.ok(groupConsoleText(g, () => '11:00:00', 5).includes('뒤에 돈 쿼리 11개는 담지 못했습니다'));
  assert.deepStrictEqual(repeats(g.queries, 5).map((x) => [x.title, x.count]), [['TagMapper.findTags', 49]]);
  assert.deepStrictEqual(repeats(g.queries.slice(0, 4), 5), []);
  // 쿼리 id · mapper 가 없으면 값을 뺀 SQL 로 같은지 본다
  assert.strictEqual(repeatKey({ sql: "SELECT * FROM T WHERE A = 'x' AND B = 12", mapper: '' }), repeatKey({ sql: "SELECT * FROM T WHERE A = 'y''z' AND B = 3.5", mapper: '' }));
});

test('설정 낱말(loggers)로 읽는 SQL 도 로그 시각이 붙는다', () => {
  const r = new LogReader(() => 1, { keywords: ['MY.SQL'] });
  const found = [...r.push('2026-11-17 12:00:01.250 DEBUG [exec-9] MY.SQL - SELECT 1 FROM DUAL\n2026-11-17 12:00:02.000 INFO [exec-9] other - done\n'), ...r.flush()];
  assert.deepStrictEqual(found.map((q) => [q.sql, q.at, q.thread]), [['SELECT 1 FROM DUAL', 12 * 3600000 + 1250, 'exec-9']]);
});
