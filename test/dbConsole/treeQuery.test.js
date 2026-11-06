// DB 콘솔: 테이블 이름 필터, 고른 테이블로 SELECT·JOIN 만들기
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'sql');
const { parseNameFilter } = require(path.join(OUT, 'nameFilter.js'));
const jb = require(path.join(OUT, 'joinBuilder.js'));

test('필터: 와일드카드가 없으면 앞부분 일치, 쉼표·공백으로 여러 개, 대소문자 무시', () => {
  const f = parseNameFilter('tb_plm, TB_CM_');
  assert.equal(f.active, true);
  assert.equal(f.text, 'tb_plm, TB_CM_');
  assert.equal(f.test('TB_PLM_PART'), true);
  assert.equal(f.test('TB_CM_CODE'), true);
  assert.equal(f.test('TB_SYS_LOG'), false);
  assert.equal(f.test('XTB_PLM'), false);
});

test('필터: * ? 와일드카드, ! 로 빼기, 빼기만 있으면 나머지 전부', () => {
  const f = parseNameFilter('*PART*  !*_BAK');
  assert.equal(f.test('TB_PART_MST'), true);
  assert.equal(f.test('TB_PART_BAK'), false);
  assert.equal(f.test('TB_USER'), false);
  const only = parseNameFilter('!*_BAK -TMP_*');
  assert.equal(only.test('TB_USER'), true);
  assert.equal(only.test('TB_USER_BAK'), false);
  assert.equal(only.test('TMP_X'), false);
  assert.equal(parseNameFilter('TB_?ART').test('TB_PART'), true);
  assert.equal(parseNameFilter('TB_?ART').test('TB_PART_X'), false);
});

test('필터: 비우면 거르지 않는다. 정규식 글자는 글자 그대로', () => {
  for (const t of ['', '  ', undefined, ' , ']) assert.equal(parseNameFilter(t).active, false);
  assert.equal(parseNameFilter('').test('ANY'), true);
  assert.equal(parseNameFilter('A.B').test('AXB'), false);
  assert.equal(parseNameFilter('T$1').test('T$1_X'), true);
});

test('별칭: 앞머리를 빼고 낱말 첫 글자, 겹치면 숫자', () => {
  const used = new Set();
  assert.equal(jb.aliasFor('TB_PART_MASTER', used), 'PM');
  assert.equal(jb.aliasFor('TB_PART_MAP', used), 'PM2');
  assert.equal(jb.aliasFor('USERS', used), 'U');
  assert.equal(jb.aliasFor('TBL_ORDER', used), 'O');
  assert.equal(jb.aliasFor('T_1ST_ITEM', used), 'T1I');
});

const t = (name, columns, primaryKey = [], qualified = name) => ({ name, qualified, columns, primaryKey });

test('JOIN: 참조 제약이 있으면 그것으로 (방향과 관계없이, 여러 칸도)', () => {
  const part = t('TB_PART', ['PART_NO', 'REV', 'NAME'], ['PART_NO', 'REV']);
  const bom = t('TB_BOM', ['BOM_ID', 'PART_NO', 'REV', 'QTY'], ['BOM_ID']);
  const rel = [{ fromTable: 'TB_BOM', fromColumns: ['PART_NO', 'REV'], toTable: 'TB_PART', toColumns: ['PART_NO', 'REV'] }];
  const r = jb.buildJoin([part, bom], rel);
  assert.equal(r.sql, 'SELECT P.*, B.*\n  FROM TB_PART P\n  JOIN TB_BOM B ON B.PART_NO = P.PART_NO AND B.REV = P.REV;');
  assert.deepEqual(r.guessed, []);
  const back = jb.buildJoin([bom, part], rel);
  assert.equal(back.sql, 'SELECT B.*, P.*\n  FROM TB_BOM B\n  JOIN TB_PART P ON P.PART_NO = B.PART_NO AND P.REV = B.REV;');
});

test('JOIN: 제약이 없으면 기본 키 칸 이름으로 짐작하고 표시한다', () => {
  const user = t('TB_USER', ['USER_ID', 'USER_NM', 'REG_ID'], ['USER_ID']);
  const log = t('TB_LOGIN_LOG', ['LOG_SEQ', 'USER_ID', 'REG_ID'], ['LOG_SEQ']);
  const r = jb.buildJoin([user, log], []);
  assert.equal(r.sql, 'SELECT U.*, LL.*\n  FROM TB_USER U\n  JOIN TB_LOGIN_LOG LL ON LL.USER_ID = U.USER_ID; -- 기본 키 칸 이름으로 짐작');
  assert.deepEqual(r.guessed, ['TB_LOGIN_LOG']);
});

test('JOIN: 이을 수 있는 테이블부터 붙이고, 못 찾으면 CROSS JOIN 으로 두고 알린다', () => {
  const a = t('TB_A', ['A_ID'], ['A_ID']);
  const c = t('TB_C', ['C_ID'], ['C_ID']);
  const b = t('TB_B', ['B_ID', 'A_ID'], ['B_ID'], 'OWNER2.TB_B');
  const r = jb.buildJoin([a, c, b], []);
  assert.deepEqual(r.sql.split('\n'), [
    'SELECT A.*, C.*, B.*',
    '  FROM TB_A A',
    '  JOIN OWNER2.TB_B B ON B.A_ID = A.A_ID -- 기본 키 칸 이름으로 짐작',
    '  CROSS JOIN TB_C C; -- 잇는 칸을 찾지 못했습니다',
  ]);
  assert.deepEqual(r.unresolved, ['TB_C']);
});

test('JOIN: 만든 글은 콘솔에서 문장 하나로 나뉜다 (설명 주석이 ; 를 삼키지 않는다)', () => {
  const st = require(path.join(OUT, 'statements.js'));
  const { ORACLE_RULES } = require(path.join(OUT, '..', 'drivers', 'oracle', 'dialect.js'));
  const a = t('TB_A', ['A_ID'], ['A_ID']);
  const b = t('TB_B', ['B_ID', 'A_ID'], ['B_ID']);
  const r = jb.buildJoin([a, b], []);
  const list = st.splitStatements(r.sql + '\nselect 1 from dual;', ORACLE_RULES);
  assert.equal(list.length, 2);
  assert.equal(list[0].sql, r.sql.slice(0, r.sql.indexOf(';')));
});

test('SELECT·COUNT: 칸을 다 적고, 칸을 모르면 *', () => {
  assert.equal(jb.buildSelect(t('TB_X', ['A', 'B'])), 'SELECT A, B\n  FROM TB_X;');
  assert.equal(jb.buildSelect(t('TB_X', [], [], 'S.TB_X')), 'SELECT *\n  FROM S.TB_X;');
  assert.equal(jb.buildCount(t('TB_X', [])), 'SELECT COUNT(*) FROM TB_X;');
});
