// DB 콘솔: SQL 을 문장으로 나누기, 커서 위치 문장, 종류 판정
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const st = require(path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'sql', 'statements.js'));
const sqls = (text) => st.splitStatements(text).map((s) => s.sql);

test('; 로 나누고 끝의 ; 는 뗀다. 빈 문장·남은 ; 는 버린다', () => {
  assert.deepEqual(sqls('select 1 from dual;\nselect 2 from dual ;\n\n;;\nselect 3 from dual'), ['select 1 from dual', 'select 2 from dual', 'select 3 from dual']);
  assert.deepEqual(sqls('  \n  '), []);
  assert.deepEqual(sqls(''), []);
});

test('문자열·따옴표 이름·주석 안의 ; 는 세지 않는다', () => {
  assert.deepEqual(sqls("select 'a;b', 'it''s; ok' from dual; select 2 from dual"), ["select 'a;b', 'it''s; ok' from dual", 'select 2 from dual']);
  assert.deepEqual(sqls('select "A;B" from t; select 2 from dual'), ['select "A;B" from t', 'select 2 from dual']);
  assert.deepEqual(sqls("select q'[a;b']c]' from dual; select 2 from dual"), ["select q'[a;b']c]' from dual", 'select 2 from dual']);
  assert.deepEqual(sqls('select 1 -- 주석; 안\n from dual; select 2 from dual'), ['select 1 -- 주석; 안\n from dual', 'select 2 from dual']);
  assert.deepEqual(sqls('select 1 /* a; b */ from dual; select 2 from dual'), ['select 1 /* a; b */ from dual', 'select 2 from dual']);
});

test('문장 앞의 주석·공백은 문장에 넣지 않는다 (시작 자리가 실제 문장)', () => {
  const text = '-- 설명\n/* 블록 */\n  select 1 from dual;';
  const [s] = st.splitStatements(text);
  assert.equal(s.sql, 'select 1 from dual');
  assert.equal(text.slice(s.start, s.start + 6), 'select');
  assert.equal(s.end, text.length);
  assert.deepEqual(sqls('-- 주석만 있는 글'), []);
});

test('PL/SQL 블록은 / 줄에서 끝나고 안의 ; 를 그대로 둔다', () => {
  const text = ['begin', '  update t set a = 1;', '  commit;', 'end;', '/', 'select 1 from dual;'].join('\n');
  assert.deepEqual(sqls(text), ['begin\n  update t set a = 1;\n  commit;\nend;', 'select 1 from dual']);
  const proc = ['create or replace procedure p as', 'begin', '  null;', 'end;', '/', '', 'declare x number; begin x := 1; end;', '/'].join('\n');
  assert.deepEqual(sqls(proc), ['create or replace procedure p as\nbegin\n  null;\nend;', 'declare x number; begin x := 1; end;']);
  assert.deepEqual(sqls('begin null; end;'), ['begin null; end;'], '/ 줄이 없으면 글 끝까지');
  assert.deepEqual(sqls("begin dbms_output.put_line('a\n/\nb'); end;\n/"), ["begin dbms_output.put_line('a\n/\nb'); end;"], '문자열 안의 / 줄은 끝이 아님');
});

test('보통 문장도 / 줄에서 끝난다 (SQL*Plus 식). 나눗셈의 / 는 아니다', () => {
  assert.deepEqual(sqls('select 1 from dual\n/\nselect 2 from dual\n/'), ['select 1 from dual', 'select 2 from dual']);
  assert.deepEqual(sqls('select 6 / 2 from dual;'), ['select 6 / 2 from dual']);
  assert.deepEqual(sqls('create table t (a number);\ncreate view v as select 1 x from dual;'), ['create table t (a number)', 'create view v as select 1 x from dual'], 'CREATE TABLE·VIEW 는 블록이 아님');
});

test('커서가 있는 문장', () => {
  const text = 'select 1 from dual;\n\nupdate t set a = 1\n where b = 2;   \n\nselect 3 from dual';
  const at = (needle, delta = 0) => st.statementAt(text, text.indexOf(needle) + delta).sql;
  assert.equal(at('select 1', 3), 'select 1 from dual');
  assert.equal(at('where b'), 'update t set a = 1\n where b = 2', '여러 줄 문장의 둘째 줄');
  assert.equal(st.statementAt(text, text.indexOf(';') + 1).sql, 'select 1 from dual', '; 바로 뒤');
  assert.equal(st.statementAt(text, text.indexOf('= 2;') + 6).sql, 'update t set a = 1\n where b = 2', '같은 줄 끝의 공백');
  assert.equal(st.statementAt(text, text.indexOf('\n\nupdate') + 1).sql, 'update t set a = 1\n where b = 2', '빈 줄 → 다음 문장');
  assert.equal(st.statementAt(text, text.length).sql, 'select 3 from dual');
  assert.equal(st.statementAt('select 1 from dual;\n\n\n', 22).sql, 'select 1 from dual', '뒤에 문장이 없으면 마지막 문장');
  assert.equal(st.statementAt('  ', 1), undefined);
});

test('종류 판정', () => {
  const kind = (sql) => st.classify(sql).kind;
  assert.equal(kind('select * from t'), 'query');
  assert.equal(kind('  /* 주석 */ WITH x as (select 1 from dual) select * from x'), 'query');
  assert.equal(kind('(select 1 from dual) union all (select 2 from dual)'), 'query');
  for (const s of ['insert into t values (1)', 'update t set a=1 where b=2', 'delete from t where a=1', 'merge into t using s on (1=1) when matched then update set a=1']) assert.equal(kind(s), 'dml', s);
  for (const s of ['create table t (a number)', 'alter table t add b number', 'drop table t', 'truncate table t', 'grant select on t to u', "comment on table t is 'x'"]) assert.equal(kind(s), 'ddl', s);
  for (const s of ['begin null; end;', 'declare x number; begin null; end;', 'create or replace procedure p as begin null; end;', 'call p(1)']) assert.equal(kind(s), 'plsql', s);
  for (const s of ['commit', 'ROLLBACK', 'savepoint a']) assert.equal(kind(s), 'tx', s);
  assert.equal(kind('explain plan for select 1 from dual'), 'other');
  assert.equal(st.classify('-- 설명\nUpdate t set a = 1').verb, 'UPDATE');
});

test('WHERE 없는 UPDATE·DELETE, SELECT FOR UPDATE', () => {
  assert.equal(st.classify('update t set a = 1').noWhere, true);
  assert.equal(st.classify('delete from t').noWhere, true);
  assert.equal(st.classify('delete from t where a = 1').noWhere, false);
  assert.equal(st.classify("update t set a = 'where' -- where 없음").noWhere, true, '문자열·주석 안의 where 는 세지 않는다');
  assert.equal(st.classify('update t set a = 1 WHERE b = 2').noWhere, false);
  assert.equal(st.classify('insert into t select * from s').noWhere, false, 'INSERT 는 해당 없음');
  assert.equal(st.classify('select * from t for update').forUpdate, true);
  assert.equal(st.classify("select 'for update' from dual").forUpdate, false);
});

test('읽기 전용에서 막을 문장: 조회가 아닌 것과 SELECT FOR UPDATE', () => {
  const blocked = (sql) => st.changesData(st.classify(sql));
  assert.equal(blocked('select * from t'), false);
  for (const s of ['update t set a=1 where b=2', 'drop table t', 'begin null; end;', 'commit', 'select * from t for update', 'explain plan for select 1 from dual']) assert.equal(blocked(s), true, s);
});
