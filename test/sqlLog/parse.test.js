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

// ───────── log4jdbc (jdbc.sqltiming · jdbc.sqlonly) ─────────
const { queryTitle, queryInfo, queryMapper } = require(path.join(__dirname, '..', '..', 'out', 'features', 'sqlLog', 'parse.js'));

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
const { summarize } = require(path.join(__dirname, '..', '..', 'out', 'features', 'sqlLog', 'parse.js'));

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
