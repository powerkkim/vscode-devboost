// DB 콘솔: PostgreSQL·MySQL 처리 (DB마다 따로 둔 순수 로직) — 접속 없이 돈다
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole');
const req = (p) => require(path.join(OUT, p));
const pgConnect = req('drivers/postgres/connect.js');
const myConnect = req('drivers/mysql/connect.js');
const pgErrors = req('drivers/postgres/errors.js');
const myErrors = req('drivers/mysql/errors.js');
const { normalizePgType } = req('drivers/postgres/schema.js');
const { normalizeMysqlType } = req('drivers/mysql/schema.js');
const { rulesOf } = req('driver/dialects.js');
const { splitStatements } = req('sql/statements.js');
const { toPositional, findBinds } = req('sql/binds.js');
const { toInsertSql, guessTable } = req('sql/insertSql.js');
const fm = req('connection/form.js');

// ───────── 접속 정보 ─────────
test('PostgreSQL JDBC URL: 호스트·포트·DB·사용자', () => {
  assert.deepEqual(pgConnect.parseHostInput('jdbc:postgresql://db.example:5433/plm?user=dev&ssl=true'), {
    host: 'db.example',
    port: 5433,
    targetKind: 'service',
    target: 'plm',
    user: 'dev',
  });
  assert.equal(pgConnect.parseHostInput('jdbc:postgresql://h/plm').port, 5432);
  assert.equal(pgConnect.parseHostInput('postgresql://u@h:5432/plm').targetKind, 'raw');
  assert.deepEqual(pgConnect.parseHostInput('h:5440'), { host: 'h', port: 5440 });
});

test('MySQL JDBC URL: mysql·mariadb 둘 다, 사용자 정보 포함', () => {
  const a = myConnect.parseHostInput('jdbc:mysql://db.example:3307/plm?useSSL=false');
  assert.equal(a.host, 'db.example');
  assert.equal(a.port, 3307);
  assert.equal(a.target, 'plm');
  const b = myConnect.parseHostInput('jdbc:mariadb://dev:pw@h/plm');
  assert.equal(b.port, 3306);
  assert.equal(b.user, 'dev');
});

test('연결 화면: 다른 DB 의 JDBC URL 을 붙여 넣으면 DB 종류가 바뀐다', () => {
  const f = { ...fm.emptyForm('oracle'), host: 'jdbc:postgresql://h:5433/plm' };
  const r = fm.fillFromHostInput(f);
  assert.equal(r.kind, 'postgres');
  assert.equal(r.port, '5433');
  assert.equal(r.target, 'plm');
  assert.equal(fm.detectKind('jdbc:mariadb://h/x'), 'mysql');
  assert.equal(fm.detectKind('jdbc:oracle:thin:@//h:1521/X'), 'oracle');
  assert.equal(fm.detectKind('10.0.0.5'), undefined);
});

test('연결 화면: DB 종류를 바꾸면 기본 포트·접속 방식이 맞춰진다 (직접 고친 포트는 그대로)', () => {
  const sid = { ...fm.emptyForm('oracle'), targetKind: 'sid' };
  const pg = fm.switchKind(sid, 'postgres');
  assert.equal(pg.port, '5432');
  assert.equal(pg.targetKind, 'service'); // PostgreSQL 에는 SID 가 없다
  const custom = fm.switchKind({ ...fm.emptyForm('oracle'), port: '1599' }, 'mysql');
  assert.equal(custom.port, '1599');
  assert.deepEqual(
    fm.kindChoices().map((k) => [k.value, k.defaultPort]),
    [
      ['oracle', 1521],
      ['postgres', 5432],
      ['mysql', 3306],
    ]
  );
});

// ───────── 오류 해석 ─────────
test('PostgreSQL 오류: SQLSTATE 안내, 자리(1부터 → 0부터), 취소', () => {
  const e = Object.assign(new Error('relation "x" does not exist'), { code: '42P01', position: '15' });
  assert.match(pgErrors.explainError(e), /테이블 또는 뷰가 없습니다/);
  assert.equal(pgErrors.postgresErrors.offset(e), 14);
  assert.equal(pgErrors.postgresErrors.isCancel(Object.assign(new Error('canceling'), { code: '57014' })), true);
  assert.equal(pgErrors.isConnectionLost(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
});

test('MySQL 오류: ER_ 코드 안내, 접속 끊김', () => {
  const e = Object.assign(new Error("Table 'plm.x' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  assert.match(myErrors.explainError(e), /테이블/);
  assert.equal(myErrors.isConnectionLost(Object.assign(new Error('x'), { code: 'PROTOCOL_CONNECTION_LOST' })), true);
});

// ───────── 형 ─────────
test('형 정리: PostgreSQL', () => {
  assert.deepEqual(normalizePgType('character varying(100)'), { type: 'string', length: 100 });
  assert.equal(normalizePgType('numeric(10,2)').type, 'number');
  assert.equal(normalizePgType('numeric(10,2)').scale, 2);
  assert.equal(normalizePgType('timestamp without time zone').type, 'timestamp');
  assert.equal(normalizePgType('bytea').type, 'binary');
});

test('형 정리: MySQL', () => {
  assert.equal(normalizeMysqlType('varchar'), 'string');
  assert.equal(normalizeMysqlType('longtext'), 'lob');
  assert.equal(normalizeMysqlType('bigint'), 'number');
  assert.equal(normalizeMysqlType('datetime'), 'timestamp');
  assert.equal(normalizeMysqlType('blob'), 'lob');
  assert.equal(normalizeMysqlType('varbinary'), 'binary');
});

// ───────── SQL 글 규칙 ─────────
test('PostgreSQL: $$ 본문 안의 ; 로 문장을 자르지 않는다', () => {
  const sql = "create function f() returns int as $$ begin return 1; end; $$ language plpgsql;\nselect 1;";
  const st = splitStatements(sql, rulesOf('postgres'));
  assert.equal(st.length, 2);
  assert.match(st[0].sql, /language plpgsql/);
  // 태그 붙은 것도
  assert.equal(splitStatements('do $body$ begin perform 1; end $body$;\nselect 2;', rulesOf('postgres')).length, 2);
});

test('MySQL: 백틱 이름, # 주석, 백슬래시 탈출 안의 ; 는 무시', () => {
  const sql = "select `a;b` from t; # 주석; 이어짐\nselect 'it\\'s;' from t;";
  const st = splitStatements(sql, rulesOf('mysql'));
  assert.equal(st.length, 2);
  assert.match(st[1].sql, /it\\'s;/);
});

test('Oracle 규칙에는 $$·백틱·# 이 없다 (섞이지 않는다)', () => {
  const st = splitStatements('select 1 from dual; select 2 from dual;', rulesOf('oracle'));
  assert.equal(st.length, 2);
  assert.equal(rulesOf('oracle').dollarQuote, undefined);
  assert.equal(rulesOf('oracle').backtick, undefined);
});

test('바인드: :이름 → $1 (같은 이름은 같은 번호) / ? (값 되풀이)', () => {
  const sql = 'select * from t where a = :a and b = :b or a2 = :a';
  const binds = { a: { value: 1 }, b: { value: 'x' } };
  const pg = toPositional(sql, binds, rulesOf('postgres'), 'dollar');
  assert.equal(pg.sql, 'select * from t where a = $1 and b = $2 or a2 = $1');
  assert.deepEqual(pg.values, [1, 'x']);
  const my = toPositional(sql, binds, rulesOf('mysql'), 'question');
  assert.equal(my.sql, 'select * from t where a = ? and b = ? or a2 = ?');
  assert.deepEqual(my.values, [1, 'x', 1]);
  // 형 변환 ::int 와 문자열 안의 :x 는 바인드가 아니다
  const cast = toPositional("select :a::int, ':b' from t", { a: { value: 3 } }, rulesOf('postgres'), 'dollar');
  assert.equal(cast.sql, "select $1::int, ':b' from t");
  assert.ok(findBinds);
});

// ───────── INSERT 문으로 복사 ─────────
const cols = [
  { name: 'PART_NO', type: 'VARCHAR2', numeric: false },
  { name: 'REG_DT', type: 'DATE', numeric: false },
  { name: 'QTY', type: 'NUMBER', numeric: true },
];

test('INSERT 복사: Oracle 은 날짜를 TO_DATE 로', () => {
  assert.equal(toInsertSql('TB', cols, [['A', '2026-11-07 10:00:00', '3']]), "INSERT INTO TB (PART_NO, REG_DT, QTY) VALUES ('A', TO_DATE('2026-11-07 10:00:00', 'YYYY-MM-DD HH24:MI:SS'), 3);");
});

test('INSERT 복사: PostgreSQL 은 날짜 글자 그대로, 소문자 이름은 따옴표 없이', () => {
  const pgCols = [
    { name: 'part_no', type: 'varchar', numeric: false },
    { name: 'reg_dt', type: 'timestamp', numeric: false },
    { name: 'Qty', type: 'int4', numeric: true },
  ];
  assert.equal(toInsertSql('tb', pgCols, [['A', '2026-11-07 10:00:00', '3']], 'postgres'), `INSERT INTO tb (part_no, reg_dt, "Qty") VALUES ('A', '2026-11-07 10:00:00', 3);`);
});

test('INSERT 복사: MySQL 은 백슬래시를 두 번, 이진 값은 0x 그대로, 이상한 이름은 백틱', () => {
  const myCols = [
    { name: 'path', type: 'VARCHAR', numeric: false },
    { name: 'img', type: 'BLOB', numeric: false },
    { name: 'my col', type: 'INT', numeric: true },
  ];
  assert.equal(toInsertSql('t', myCols, [['C:\\tmp', '0xCAFE', null]], 'mysql'), "INSERT INTO t (path, img, `my col`) VALUES ('C:\\\\tmp', 0xCAFE, NULL);");
  assert.equal(guessTable('select * from `plm`.`tb_part` where 1=1', 'mysql'), '`plm`.`tb_part`');
});
