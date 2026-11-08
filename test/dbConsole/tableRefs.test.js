// DB 콘솔: 문장 속 테이블 자리 (굵게) · 결과 칸 → 테이블 (테이블별 색)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole');
const { tableRefs, columnSources } = require(path.join(OUT, 'sql', 'tableRefs.js'));
const { rulesOf } = require(path.join(OUT, 'driver', 'dialects.js'));
const ora = rulesOf('oracle');
const names = (sql, r = ora) => tableRefs(sql, r).map((x) => sql.slice(x.from, x.to));

test('테이블 자리: FROM 목록·JOIN·UPDATE·INSERT INTO·MERGE USING·서브쿼리 안', () => {
  assert.deepEqual(names('SELECT * FROM TB_PART P, PLM.TB_BOM B WHERE P.PART_NO = B.PART_NO'), ['TB_PART', 'PLM.TB_BOM']);
  assert.deepEqual(names('select * from tb_part p left outer join tb_bom b on b.part_no = p.part_no join tb_x x using (id)'), ['tb_part', 'tb_bom', 'tb_x']);
  assert.deepEqual(names("update tb_part set nm = 'from x' where no in (select no from tb_bom)"), ['tb_part', 'tb_bom']);
  assert.deepEqual(names('insert into tb_log (a) select a from tb_src'), ['tb_log', 'tb_src']);
  assert.deepEqual(names('merge into tb_t t using tb_s s on (t.id = s.id) when matched then update set t.v = s.v'), ['tb_t', 'tb_s']);
  assert.deepEqual(names('select * from (select * from tb_in) v, tb_out'), ['tb_in', 'tb_out']);
});

test('테이블이 아닌 FROM: 문자열·주석·EXTRACT·TRIM 안', () => {
  assert.deepEqual(names("select extract(year from reg_dt), trim(leading '0' from no) from tb_part -- from tb_comment"), ['tb_part']);
  assert.deepEqual(names("select 'from tb_str' from dual /* join tb_c */"), ['dual']);
  assert.deepEqual(names('select * from "My Table" t'), ['"My Table"']);
  assert.deepEqual(names('select * from `plm`.`tb_part`', rulesOf('mysql')), ['`plm`.`tb_part`']);
});

const cols = { TB_PART: ['PART_NO', 'PART_NM', 'REV'], TB_BOM: ['PART_NO', 'CHILD_NO', 'QTY'] };
const of = (t) => cols[t.toUpperCase()];

test('결과 칸 → 테이블: 별칭.칸, 별칭.*, *, 칸 이름만(한 테이블에만 있을 때)', () => {
  let r = columnSources('SELECT P.PART_NO, P.PART_NM, B.CHILD_NO, B.QTY FROM TB_PART P JOIN TB_BOM B ON B.PART_NO = P.PART_NO', ['PART_NO', 'PART_NM', 'CHILD_NO', 'QTY'], of, ora);
  assert.deepEqual(r.result.groups, [0, 0, 1, 1]);
  assert.deepEqual(r.result.sources.map((s) => s.label), ['TB_PART (P)', 'TB_BOM (B)']);
  r = columnSources('select p.*, b.qty from tb_part p, tb_bom b where b.part_no = p.part_no', ['PART_NO', 'PART_NM', 'REV', 'QTY'], of, ora);
  assert.deepEqual(r.result.groups, [0, 0, 0, 1]);
  r = columnSources('select * from tb_part p, tb_bom b', new Array(6).fill('x'), of, ora);
  assert.deepEqual(r.result.groups, [0, 0, 0, 1, 1, 1]);
  r = columnSources('select part_nm, child_no, part_no, nvl(b.qty, 0) q from tb_part p, tb_bom b', ['PART_NM', 'CHILD_NO', 'PART_NO', 'Q'], of, ora);
  assert.deepEqual(r.result.groups, [0, 1, undefined, 1], '두 테이블에 다 있는 칸(PART_NO)은 모른다');
});

test('결과 칸 → 테이블: 칠하지 않는 경우', () => {
  const none = (sql, n) => columnSources(sql, new Array(n).fill('x'), of, ora).result;
  assert.equal(none('select * from tb_part', 3), undefined, '테이블 하나');
  assert.equal(none('select p.*, b.qty from tb_part p, tb_bom b', 9), undefined, '칸 수가 결과와 다르다');
  assert.equal(none('select count(*), max(p.rev) from tb_part p, tb_bom b', 2), undefined, '한 테이블에서만 온 칸');
  // 칸을 모르는 테이블은 물어볼 목록으로
  const r = columnSources('select * from tb_part p, tb_new n', new Array(5).fill('x'), of, ora);
  assert.equal(r.result, undefined);
  assert.deepEqual(r.need, ['tb_new']);
});

test('결과 칸 → 테이블: 서브쿼리 자리, 바깥 문장만 본다', () => {
  const r = columnSources(
    'select v.cnt, p.part_nm from (select part_no, count(*) cnt from tb_bom group by part_no) v join tb_part p on p.part_no = v.part_no order by 1',
    ['CNT', 'PART_NM'],
    of,
    ora
  );
  assert.deepEqual(r.result.groups, [0, 1]);
  assert.equal(r.result.sources[0].label, '(서브쿼리) v');
});
