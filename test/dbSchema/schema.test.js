// DB 스키마 가져오기·정의서 테스트. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
// 실제 그리드에서 복사한 텍스트가 잘못 읽히면 그 텍스트(이름은 바꿔도 됨)를 케이스로 추가하세요.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbSchema', 'schema');
const { importText, normalizeOracleType } = require(path.join(OUT, 'importer.js'));
const { mergeImport, schemaFileName } = require(path.join(OUT, 'merge.js'));
const { buildMainSql, buildDefaultSql, normalizePrefixes } = require(path.join(OUT, 'collectSql.js'));
const { buildTableDoc, tableDocFileNames } = require(path.join(OUT, 'tableDoc.js'));
const { parseDelimited } = require(path.join(OUT, 'csv.js'));

const H = ['REC', 'TABLE_NAME', 'NAME', 'SEQ', 'COLUMN_NAME', 'KIND', 'DATA_TYPE', 'CHAR_LENGTH', 'CHAR_USED', 'DATA_LENGTH',
  'DATA_PRECISION', 'DATA_SCALE', 'NULLABLE', 'UNIQUENESS', 'DESCEND', 'REF_TABLE', 'REF_COLUMN', 'DELETE_RULE', 'STATUS', 'COMMENTS'];
/** 그리드 복사처럼: 탭 구분, 빈 값은 (null) */
const row = (o) => H.map((h) => (o[h] === undefined ? '(null)' : String(o[h]))).join('\t');
const SUMMARY = (counts) => ({ REC: 'SUMMARY', NAME: 'devboost-schema/1', COMMENTS: `schema=PLM;db=PLMDB;at=2026-10-26T01:00:00+09:00;prefix=TB_;${counts}` });

const MAIN_ROWS = [
  SUMMARY('TABLE=3;COLUMN=7;CONS=4;INDEX=3;DEFAULT=2'),
  { REC: 'TABLE', TABLE_NAME: 'TB_CUSTOMER', KIND: 'TABLE', COMMENTS: '고객' },
  { REC: 'TABLE', TABLE_NAME: 'TB_ORDER', KIND: 'TABLE', COMMENTS: '주문' },
  { REC: 'TABLE', TABLE_NAME: 'TB_ORDER_V', KIND: 'VIEW', COMMENTS: '주문 뷰' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_CUSTOMER', NAME: 'CUST_ID', SEQ: 1, DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: 'N', COMMENTS: '고객 ID' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_CUSTOMER', NAME: 'NAME', SEQ: 2, DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 100, CHAR_USED: 'C', DATA_LENGTH: 400, NULLABLE: 'Y', COMMENTS: '이름, 성명' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_ORDER', NAME: 'ORDER_ID', SEQ: 1, DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 12, DATA_SCALE: 0, NULLABLE: 'N', COMMENTS: '주문 ID' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_ORDER', NAME: 'CUST_ID', SEQ: 2, DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: 'N' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_ORDER', NAME: 'AMOUNT', SEQ: 3, DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 15, DATA_SCALE: 2, NULLABLE: 'Y', COMMENTS: '금액' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_ORDER', NAME: 'REG_DT', SEQ: 4, DATA_TYPE: 'DATE', DATA_LENGTH: 7, NULLABLE: 'Y' },
  { REC: 'COLUMN', TABLE_NAME: 'TB_ORDER_V', NAME: 'ORDER_ID', SEQ: 1, DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, NULLABLE: 'Y' },
  { REC: 'CONS', TABLE_NAME: 'TB_CUSTOMER', NAME: 'PK_TB_CUSTOMER', SEQ: 1, COLUMN_NAME: 'CUST_ID', KIND: 'P', STATUS: 'ENABLED' },
  { REC: 'CONS', TABLE_NAME: 'TB_ORDER', NAME: 'FK_ORDER_CUST', SEQ: 1, COLUMN_NAME: 'CUST_ID', KIND: 'R', REF_TABLE: 'TB_CUSTOMER', REF_COLUMN: 'CUST_ID', DELETE_RULE: 'NO ACTION', STATUS: 'ENABLED' },
  { REC: 'CONS', TABLE_NAME: 'TB_ORDER', NAME: 'PK_TB_ORDER', SEQ: 2, COLUMN_NAME: 'CUST_ID', KIND: 'P', STATUS: 'ENABLED' },
  { REC: 'CONS', TABLE_NAME: 'TB_ORDER', NAME: 'PK_TB_ORDER', SEQ: 1, COLUMN_NAME: 'ORDER_ID', KIND: 'P', STATUS: 'ENABLED' },
  { REC: 'INDEX', TABLE_NAME: 'TB_CUSTOMER', NAME: 'PK_TB_CUSTOMER', SEQ: 1, COLUMN_NAME: 'CUST_ID', KIND: 'NORMAL', UNIQUENESS: 'UNIQUE', DESCEND: 'ASC' },
  { REC: 'INDEX', TABLE_NAME: 'TB_ORDER', NAME: 'IX_ORDER_01', SEQ: 1, COLUMN_NAME: 'REG_DT', KIND: 'NORMAL', UNIQUENESS: 'NONUNIQUE', DESCEND: 'DESC' },
  { REC: 'INDEX', TABLE_NAME: 'TB_ORDER', NAME: 'PK_TB_ORDER', SEQ: 1, COLUMN_NAME: 'ORDER_ID', KIND: 'NORMAL', UNIQUENESS: 'UNIQUE', DESCEND: 'ASC' },
];
const MAIN_TEXT = [H.join('\t'), ...MAIN_ROWS.map(row)].join('\r\n');
const DEFAULT_TEXT = ['REC\tTABLE_NAME\tNAME\tCOMMENTS', "DEFAULT\tTB_ORDER\tAMOUNT\t0 ", 'DEFAULT\tTB_ORDER\tREG_DT\tSYSDATE'].join('\n');

test('1. 수집 SQL: 접두어 정리, 두 쿼리에 같은 접두어, 따옴표 이스케이프, 전체', () => {
  assert.deepStrictEqual(normalizePrefixes([' tb_ ', 'TB_', '', 'tc_']), ['TB_', 'TC_']);
  const main = buildMainSql(['tb_', 'TC_']);
  assert.match(main, /SELECT 'TB_' AS prefix FROM dual\n\s+UNION ALL SELECT 'TC_' FROM dual/);
  assert.match(main, /SUBSTR\(table_name, 1, LENGTH\(p\.prefix\)\) = p\.prefix/);
  assert.match(main, /';DEFAULT=' \|\|/);
  const def = buildDefaultSql(['tb_', 'TC_']);
  assert.match(def, /SELECT 'TB_' AS prefix FROM dual\n\s+UNION ALL SELECT 'TC_' FROM dual/);
  assert.match(def, /data_default IS NOT NULL/);
  assert.match(buildMainSql(["A'B"]), /'A''B'/);
  assert.match(buildMainSql([]), /CAST\(NULL AS VARCHAR2\(128\)\) AS prefix FROM dual/);
});

test('2. 본 쿼리 결과 가져오기: 테이블·컬럼·제약·인덱스, 타입 정리, (null)', () => {
  const p = importText(MAIN_TEXT);
  assert.deepStrictEqual(p.problems, []);
  assert.strictEqual(p.kind, 'main');
  assert.deepStrictEqual(p.summary.prefixes, ['TB_']);
  assert.strictEqual(p.tables.length, 3);
  assert.strictEqual(p.tables.find((t) => t.name === 'TB_ORDER_V').kind, 'view');
  const col = (t, n) => p.columns.find((c) => c.table === t && c.name === n);
  assert.strictEqual(col('TB_CUSTOMER', 'NAME').typeText, 'VARCHAR2(100 CHAR)');
  assert.strictEqual(col('TB_CUSTOMER', 'NAME').comment, '이름, 성명');
  assert.strictEqual(col('TB_ORDER', 'AMOUNT').typeText, 'NUMBER(15,2)');
  assert.strictEqual(col('TB_ORDER', 'ORDER_ID').typeText, 'NUMBER(12)');
  assert.strictEqual(col('TB_ORDER', 'ORDER_ID').nullable, false);
  assert.strictEqual(col('TB_ORDER', 'REG_DT').comment, undefined, '(null) 은 빈 값');
  const pk = p.constraints.find((c) => c.name === 'PK_TB_ORDER');
  assert.deepStrictEqual(pk.columns, ['ORDER_ID', 'CUST_ID'], 'SEQ 순서로 묶음');
  const fk = p.constraints.find((c) => c.kind === 'foreign');
  assert.deepStrictEqual([fk.refTable, fk.refColumns, fk.onDelete], ['TB_CUSTOMER', ['CUST_ID'], 'no action']);
  const ix = p.indexes.find((x) => x.name === 'IX_ORDER_01');
  assert.deepStrictEqual([ix.unique, ix.columns], [false, [{ name: 'REG_DT', desc: true }]]);
});

test('3. 일부만 복사하면 오류 (그리드가 처음 몇 행만 가져온 경우)', () => {
  const partial = [H.join('\t'), ...MAIN_ROWS.slice(0, 6).map(row)].join('\n');
  const p = importText(partial);
  const errs = p.problems.filter((x) => x.level === 'error').map((x) => x.message);
  assert.ok(errs.some((m) => m.startsWith('컬럼 7개 중 2개만')));
  assert.ok(errs.some((m) => m.startsWith('제약조건 컬럼 4개 중 0개만')));
});

test('4. 헤더 없이 / 행 번호 칸이 붙어 복사된 경우', () => {
  const noHeader = MAIN_ROWS.map(row).join('\n');
  const p1 = importText(noHeader);
  assert.ok(!p1.problems.some((x) => x.level === 'error'));
  assert.ok(p1.problems.some((x) => x.message.includes('헤더 없이')));
  assert.strictEqual(p1.columns.length, 7);
  const withRowNo = ['\t' + H.join('\t'), ...MAIN_ROWS.map((r, i) => `${i + 1}\t${row(r)}`)].join('\n');
  const p2 = importText(withRowNo);
  assert.deepStrictEqual(p2.problems, []);
  assert.strictEqual(p2.columns.length, 7);
  assert.strictEqual(p2.constraints.length, 3);
});

test('5. 기본값: 줄바꿈이 섞여 행이 쪼개져도 복구, NULL 글자는 값으로', () => {
  const text = ['REC\tTABLE_NAME\tNAME\tCOMMENTS', "DEFAULT\tTB_ORDER\tAMOUNT\t0", "DEFAULT\tTB_ORDER\tMEMO\tCASE WHEN 1=1", "  THEN 'A' END", 'DEFAULT\tTB_X\tY\tNULL'].join('\n');
  const p = importText(text);
  assert.strictEqual(p.kind, 'defaults');
  assert.deepStrictEqual(p.defaults.map((d) => d.value), ['0', "CASE WHEN 1=1\n  THEN 'A' END", 'NULL']);
});

test('6. 합치기: 본 쿼리 + 기본값, 기본값 누락 알림', () => {
  const main = importText(MAIN_TEXT);
  const r = mergeImport({ main, defaults: importText(DEFAULT_TEXT), label: '개발' });
  assert.deepStrictEqual(r.notes, []);
  assert.strictEqual(r.schema.source.schema, 'PLM');
  assert.deepStrictEqual(r.schema.source.prefixes, ['TB_']);
  assert.ok(r.schema.columns.every((c) => c.schema === 'PLM'));
  const amount = r.schema.columns.find((c) => c.name === 'AMOUNT');
  assert.strictEqual(amount.default, '0', '앞뒤 공백 제거');
  const r2 = mergeImport({ main });
  assert.ok(r2.notes.some((n) => n.message.includes('기본값 2개를 아직')));
  assert.strictEqual(schemaFileName(r.schema.source), 'PLM@개발.json');
});

test('7. 접두어로 받으면 그 접두어 테이블만 교체, 나머지는 유지 / 기본값만 나중에', () => {
  const existing = mergeImport({ main: importText(MAIN_TEXT) }).schema;
  existing.tables.push({ schema: 'PLM', name: 'TC_CODE', kind: 'table', comment: '코드' });
  existing.columns.push({ schema: 'PLM', table: 'TC_CODE', name: 'CODE', position: 1, type: 'string', rawType: 'VARCHAR2', typeText: 'VARCHAR2(10)', nullable: false });
  existing.source.prefixes = ['TB_', 'TC_'];
  // TB_ 를 다시 받음: TB_ORDER_V 가 DB 에서 지워진 상황
  const rows = MAIN_ROWS.filter((r) => r.TABLE_NAME !== 'TB_ORDER_V');
  rows[0] = SUMMARY('TABLE=2;COLUMN=6;CONS=4;INDEX=3;DEFAULT=0');
  const again = importText([H.join('\t'), ...rows.map(row)].join('\n'));
  const r = mergeImport({ existing, main: again });
  const names = r.schema.tables.map((t) => t.name);
  assert.deepStrictEqual(names, ['TB_CUSTOMER', 'TB_ORDER', 'TC_CODE']);
  assert.strictEqual(r.keptTables, 1);
  assert.deepStrictEqual(r.schema.source.prefixes, ['TB_', 'TC_']);
  const later = mergeImport({ existing: r.schema, defaults: importText(DEFAULT_TEXT) });
  assert.strictEqual(later.schema.columns.find((c) => c.name === 'REG_DT').default, 'SYSDATE');
});

test('8. REC 없는 기존 정의서 쿼리 결과 (CSV, 별칭)', () => {
  const csv = ['TABLE_NAME,COLUMN_NAME,COLUMN_ID,DATA_TYPE,DATA_LENGTH,NULLABLE,DATA_DEFAULT,PK,COMMENTS',
    'TB_A,ID,1,NUMBER,22,N,,Y,아이디', 'TB_A,NM,2,VARCHAR2,50,Y,\'X\',,"이름, 설명"'].join('\n');
  const p = importText(csv);
  assert.strictEqual(p.kind, 'columns');
  assert.strictEqual(p.columns[1].typeText, 'VARCHAR2(50)');
  assert.strictEqual(p.columns[1].default, "'X'");
  assert.strictEqual(p.columns[1].comment, '이름, 설명');
  assert.deepStrictEqual(p.constraints[0].columns, ['ID']);
  const r = mergeImport({ main: p, fallbackSchema: 'APP' });
  assert.deepStrictEqual(r.schema.tables.map((t) => t.name), ['TB_A']);
});

test('9. 형식이 아닌 텍스트 / 빈 클립보드 / JSON', () => {
  assert.ok(importText('').problems.some((p) => p.level === 'error'));
  assert.ok(importText('hello world\nfoo').problems.some((p) => p.level === 'error'));
  const j = importText(JSON.stringify({ format: 'devboost-schema', version: 1, source: { dbms: 'oracle', schema: 'X' }, tables: [], columns: [], constraints: [], indexes: [] }));
  assert.strictEqual(j.kind, 'json');
  assert.ok(j.json);
});

test('10. 타입 정리 규칙', () => {
  const t = (...a) => normalizeOracleType(...a).typeText;
  assert.strictEqual(t('VARCHAR2', 20, 'B', 20), 'VARCHAR2(20)');
  assert.strictEqual(t('NVARCHAR2', 20, 'C', 40), 'NVARCHAR2(20)');
  assert.strictEqual(t('NUMBER', undefined, undefined, 22, undefined, 0), 'INTEGER');
  assert.strictEqual(t('NUMBER', undefined, undefined, 22), 'NUMBER');
  assert.strictEqual(t('TIMESTAMP(6)'), 'TIMESTAMP(6)');
  assert.strictEqual(t('RAW', undefined, undefined, 16), 'RAW(16)');
  assert.strictEqual(normalizeOracleType('XMLTYPE').type, 'other');
});

test('11. 테이블 정의서 CSV: 목차 + 정의서 (뷰 제외 기본), Excel 용 BOM·CRLF', () => {
  const schema = mergeImport({ main: importText(MAIN_TEXT), defaults: importText(DEFAULT_TEXT), label: '개발' }).schema;
  const doc = buildTableDoc(schema, { today: '2026-10-26' });
  assert.strictEqual(doc.tableCount, 2, '뷰는 기본으로 빠짐');
  assert.ok(doc.index.startsWith('﻿'));
  assert.ok(doc.index.includes('\r\n'));
  const idx = parseDelimited(doc.index, ',').map((r) => r.cells); // 빈 줄은 빠짐
  assert.deepStrictEqual(idx[0], ['테이블 정의서 목차']);
  assert.deepStrictEqual(idx[2], ['No', '테이블명', '테이블 설명', '구분', '컬럼 수', 'PK', 'FK 수', '인덱스 수']);
  assert.deepStrictEqual(idx[4], ['2', 'TB_ORDER', '주문', '테이블', '4', 'ORDER_ID, CUST_ID', '1', '2']);
  const d = parseDelimited(doc.detail, ',').map((r) => r.cells);
  const head = d.findIndex((r) => r[0] === 'No' && r[1] === '컬럼명' && d[d.indexOf(r) - 2][1] === 'TB_ORDER');
  assert.deepStrictEqual(d[head + 1], ['1', 'ORDER_ID', '주문 ID', 'NUMBER(12)', 'N', '', 'Y(1)', '', '', '']);
  assert.deepStrictEqual(d[head + 2], ['2', 'CUST_ID', '', 'NUMBER(10)', 'N', '', 'Y(2)', '', 'TB_CUSTOMER.CUST_ID', '']);
  assert.deepStrictEqual(d[head + 3], ['3', 'AMOUNT', '금액', 'NUMBER(15,2)', 'Y', '0', '', '', '', '']);
  assert.deepStrictEqual(d[head + 4], ['4', 'REG_DT', '', 'DATE', 'Y', 'SYSDATE', '', '', '', 'IX_ORDER_01(1 DESC)']);
  const cust = d.find((r) => r[1] === 'NAME');
  assert.strictEqual(cust[2], '이름, 성명', '쉼표 들어간 코멘트는 따옴표로 감쌈');
  assert.strictEqual(buildTableDoc(schema, { includeViews: true }).tableCount, 3);
  assert.strictEqual(buildTableDoc(schema, { tables: ['TB_ORDER'] }).tableCount, 1);
  assert.deepStrictEqual(tableDocFileNames(schema, '2026-10-26'), {
    index: '테이블정의서_목차_PLM_개발_20261026.csv', detail: '테이블정의서_PLM_개발_20261026.csv',
  });
});
