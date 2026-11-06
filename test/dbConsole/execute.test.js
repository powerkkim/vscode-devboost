// DB 콘솔: 문장 실행 결과를 화면 모양으로 바꾸기 (가짜 접속으로 — 실제 DB 없이 도는 범위)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ex = require(path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'drivers', 'oracle', 'execute.js'));

/** 가짜 접속: execute 가 돌려줄 값을 정해 둔다. 조회면 rows 를 ResultSet 처럼 나눠 준다 */
function fakeConnection({ rows, meta, rowsAffected, fail } = {}) {
  const state = { closed: 0, calls: [] };
  return {
    state,
    execute: async (sql, binds, options) => {
      state.calls.push({ sql, binds, options });
      if (fail) throw fail;
      if (!rows) return { rowsAffected };
      let at = 0;
      return {
        metaData: meta,
        resultSet: {
          getRows: async (n) => rows.slice(at, (at += n)),
          close: async () => void state.closed++,
        },
      };
    },
  };
}
const meta = [{ name: 'ID', dbTypeName: 'NUMBER' }, { name: 'NM', dbTypeName: 'VARCHAR2' }];
const many = (n) => Array.from({ length: n }, (_, i) => [String(i + 1), `이름${i + 1}`]);

test('칸 값: NULL, 글자, 숫자, 날짜, 바이트, 객체', () => {
  assert.equal(ex.formatCell(null), null);
  assert.equal(ex.formatCell(undefined), null);
  assert.equal(ex.formatCell('가나다'), '가나다');
  assert.equal(ex.formatCell(''), '', '빈 글자는 NULL 과 구분');
  assert.equal(ex.formatCell(12.5), '12.5');
  assert.equal(ex.formatCell(new Date(2026, 10, 5, 14, 22, 10)), '2026-11-05 14:22:10');
  assert.equal(ex.formatCell(new Date(2026, 10, 5)), '2026-11-05', '자정이면 날짜만');
  assert.equal(ex.formatCell(new Date(2026, 10, 5, 0, 0, 0, 123)), '2026-11-05 00:00:00.123');
  assert.equal(ex.formatCell(Buffer.from([0xca, 0xfe, 0x01])), 'CAFE01');
  assert.match(ex.formatCell(Buffer.alloc(100, 0xab)), /^(AB){32}… \(100바이트\)$/);
  assert.equal(ex.formatCell({ a: 1 }), '{"a":1}');
  const long = ex.formatCell('x'.repeat(5000));
  assert.ok(long.startsWith('x'.repeat(ex.MAX_CELL_CHARS)) && long.endsWith('… (5,000자)'), '긴 글은 잘라서');
});

test('칸 정보: 타입 이름과 숫자 칸 여부', () => {
  assert.deepEqual(ex.toColumn({ name: 'AMOUNT', dbTypeName: 'NUMBER' }), { name: 'AMOUNT', type: 'NUMBER', numeric: true });
  assert.deepEqual(ex.toColumn({ name: 'NM', dbType: { columnTypeName: 'VARCHAR2' } }), { name: 'NM', type: 'VARCHAR2', numeric: false });
  assert.deepEqual(ex.toColumn({ name: 'X' }), { name: 'X', type: '', numeric: false });
});

test('조회: 처음 pageSize 행만 가져오고, 남았으면 커서로 이어 받는다', async () => {
  const c = fakeConnection({ rows: many(25), meta });
  const r = await ex.runStatement(c, 'select * from t', 10);
  assert.equal(r.kind, 'rows');
  assert.deepEqual(r.columns.map((x) => x.name), ['ID', 'NM']);
  assert.equal(r.page.rows.length, 10);
  assert.equal(r.page.done, false);
  assert.deepEqual(r.page.rows[0], ['1', '이름1']);
  const p2 = await r.cursor.next(10);
  assert.deepEqual([p2.rows.length, p2.done, p2.rows[0][0]], [10, false, '11']);
  const p3 = await r.cursor.next(10);
  assert.deepEqual([p3.rows.length, p3.done], [5, true]);
  assert.equal(c.state.closed, 1, '다 받으면 커서를 닫는다');
  assert.deepEqual(await r.cursor.next(10), { rows: [], done: true }, '닫힌 뒤에는 빈 결과');
  assert.equal(c.state.closed, 1);
});

test('조회: 한 번에 다 받았으면 커서를 남기지 않고 닫는다. 0행도 칸은 나온다', async () => {
  const c = fakeConnection({ rows: many(3), meta });
  const r = await ex.runStatement(c, 'select * from t', 10);
  assert.equal(r.page.done, true);
  assert.equal(r.cursor, undefined);
  assert.equal(c.state.closed, 1);
  const empty = await ex.runStatement(fakeConnection({ rows: [], meta }), 'select * from t where 1=0', 10);
  assert.deepEqual([empty.kind, empty.page.rows.length, empty.columns.length, empty.page.done], ['rows', 0, 2, true]);
});

test('변경: 바뀐 행 수 / DDL·PL/SQL: 성공만', async () => {
  const dml = await ex.runStatement(fakeConnection({ rowsAffected: 3 }), 'update t set a = 1 where b = 2', 10);
  assert.deepEqual([dml.kind, dml.rowsAffected], ['count', 3]);
  const zero = await ex.runStatement(fakeConnection({ rowsAffected: 0 }), 'delete from t where 1=0', 10);
  assert.deepEqual([zero.kind, zero.rowsAffected], ['count', 0], '0행도 변경 결과');
  const ddl = await ex.runStatement(fakeConnection({}), 'create table t (a number)', 10);
  assert.equal(ddl.kind, 'ok');
});

test('자동 커밋하지 않고, 숫자·CLOB 은 글자로 받도록 드라이버에 요청한다', async () => {
  const oracledb = require('oracledb');
  const c = fakeConnection({ rowsAffected: 1 });
  await ex.runStatement(c, 'insert into t values (1)', 10);
  const { options } = c.state.calls[0];
  assert.equal(options.autoCommit, false);
  assert.equal(options.resultSet, true);
  assert.deepEqual(options.fetchTypeHandler({ name: 'N', dbType: oracledb.DB_TYPE_NUMBER }), { type: oracledb.STRING }, '숫자는 글자로 (자릿수 보존)');
  assert.deepEqual(options.fetchTypeHandler({ name: 'C', dbType: oracledb.DB_TYPE_CLOB }), { type: oracledb.STRING });
  assert.deepEqual(options.fetchTypeHandler({ name: 'B', dbType: oracledb.DB_TYPE_BLOB }), { type: oracledb.BUFFER });
  assert.equal(options.fetchTypeHandler({ name: 'V', dbType: oracledb.DB_TYPE_VARCHAR }), undefined, '그 밖은 기본');
});

test('오류: 그대로 던지고, 난 자리를 알 수 있으면 꺼낸다', async () => {
  const fail = Object.assign(new Error('ORA-00942: table or view does not exist'), { code: 'ORA-00942', offset: 14 });
  await assert.rejects(ex.runStatement(fakeConnection({ fail }), 'select * from TB_ORDR', 10), /ORA-00942/);
  assert.equal(ex.errorOffset(fail), 14);
  assert.equal(ex.errorOffset(new Error('x')), undefined);
  assert.equal(ex.errorOffset('글자'), undefined);
});
