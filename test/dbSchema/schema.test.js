// DB 스키마 가져오기·정의서 테스트. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
// 실제 그리드에서 복사한 텍스트가 잘못 읽히면 그 텍스트(이름은 바꿔도 됨)를 케이스로 추가하세요.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbSchema', 'schema');
const { importText, normalizeOracleType, COLLECT_COLUMNS } = require(path.join(OUT, 'importer.js'));
const { mergeImport, schemaFileName } = require(path.join(OUT, 'merge.js'));
const { buildCollectSql, normalizePrefixes } = require(path.join(OUT, 'collectSql.js'));
const { buildTableDoc, tableDocFileNames } = require(path.join(OUT, 'tableDoc.js'));
const { parseDelimited, csvCell, decodeText } = require(path.join(OUT, 'csv.js'));

const H = COLLECT_COLUMNS;
const META = (rows, prefix = 'TB_') => `schema=PLM;db=PLMDB;at=2026-10-26T23:50:00+09:00;prefix=${prefix};rows=${rows}`;
/** 그리드 복사처럼: 탭 구분, 빈 값은 (null), 기본값(DATA_DEFAULT)은 맨 끝 */
const row = (o, meta) => H.map((h) => (h === 'META' ? meta : o[h] === undefined ? '(null)' : String(o[h]))).join('\t');

const COLS = [
  { TABLE_NAME: 'TB_CUSTOMER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '고객', COLUMN_ID: 1, COLUMN_NAME: 'CUST_ID', COLUMN_COMMENT: '고객 ID', DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: 'N', PK_POS: 1, PK_NAME: 'PK_TB_CUSTOMER', IDXS: 'PK_TB_CUSTOMER(1 U)' },
  { TABLE_NAME: 'TB_CUSTOMER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '고객', COLUMN_ID: 2, COLUMN_NAME: 'NAME', COLUMN_COMMENT: '이름, 성명', DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 100, CHAR_USED: 'C', DATA_LENGTH: 400, NULLABLE: 'Y' },
  { TABLE_NAME: 'TB_CUSTOMER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '고객', COLUMN_ID: 3, COLUMN_NAME: 'EMAIL', DATA_TYPE: 'VARCHAR2', CHAR_LENGTH: 200, CHAR_USED: 'B', DATA_LENGTH: 200, NULLABLE: 'Y', UKS: 'UK_CUST_EMAIL(1)', IDXS: 'UK_CUST_EMAIL(1 U)' },
  { TABLE_NAME: 'TB_ORDER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '주문', COLUMN_ID: 1, COLUMN_NAME: 'ORDER_ID', COLUMN_COMMENT: '주문 ID', DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 12, DATA_SCALE: 0, NULLABLE: 'N', PK_POS: 1, PK_NAME: 'PK_TB_ORDER', IDXS: 'PK_TB_ORDER(1 U)' },
  { TABLE_NAME: 'TB_ORDER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '주문', COLUMN_ID: 2, COLUMN_NAME: 'CUST_ID', DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 10, DATA_SCALE: 0, NULLABLE: 'N', PK_POS: 2, PK_NAME: 'PK_TB_ORDER', FKS: 'FK_ORDER_CUST(1)=TB_CUSTOMER.CUST_ID', IDXS: 'PK_TB_ORDER(2 U)' },
  { TABLE_NAME: 'TB_ORDER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '주문', COLUMN_ID: 3, COLUMN_NAME: 'AMOUNT', COLUMN_COMMENT: '금액', DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, DATA_PRECISION: 15, DATA_SCALE: 2, NULLABLE: 'Y', DATA_DEFAULT: '0 ' },
  { TABLE_NAME: 'TB_ORDER', TABLE_TYPE: 'TABLE', TABLE_COMMENT: '주문', COLUMN_ID: 4, COLUMN_NAME: 'REG_DT', DATA_TYPE: 'DATE', DATA_LENGTH: 7, NULLABLE: 'Y', IDXS: 'IX_ORDER_01(1 DESC)', DATA_DEFAULT: 'SYSDATE' },
  { TABLE_NAME: 'TB_ORDER_V', TABLE_TYPE: 'VIEW', TABLE_COMMENT: '주문 뷰', COLUMN_ID: 1, COLUMN_NAME: 'ORDER_ID', DATA_TYPE: 'NUMBER', DATA_LENGTH: 22, NULLABLE: 'Y' },
];
const text = (cols = COLS, meta = META(COLS.length)) => [H.join('\t'), ...cols.map((c) => row(c, meta))].join('\r\n');

test('1. 수집 SQL: 한 번에 (UNION·WITH 없음), 기본값은 맨 끝, 접두어·따옴표·전체', () => {
  assert.deepStrictEqual(normalizePrefixes([' tb_ ', 'TB_', '', 'tc_']), ['TB_', 'TC_']);
  const sql = buildCollectSql(['tb_', 'TC_']);
  const body = sql.replace(/^--.*$/gm, '');
  assert.ok(!/\bUNION\s+ALL\s+SELECT\s+tc\./i.test(body) && !/^\s*WITH\b/im.test(body), '본문에 UNION 행 합치기·WITH 없음');
  assert.match(body, /m\.meta,\s+tc\.data_default\s+FROM/, 'DATA_DEFAULT 가 맨 끝 칸');
  assert.match(body, /SELECT 'TB_' AS prefix FROM dual\s+UNION ALL SELECT 'TC_' FROM dual/, '접두어 목록');
  assert.match(body, /SUBSTR\(table_name, 1, LENGTH\(p\.prefix\)\) = p\.prefix/, 'LIKE 대신 앞부분 비교');
  assert.match(body, /cc\.table_name\(\+\) = tc\.table_name/, '바깥 조인은 (+) 문법');
  assert.match(body, /'schema=' \|\| USER/);
  assert.match(body, /rc\.owner\(\+\) = c\.r_owner/, 'FK 참조는 소유자까지');
  assert.match(buildCollectSql(["A'B"]), /'A''B'/);
  assert.match(buildCollectSql([]), /CAST\(NULL AS VARCHAR2\(128\)\) AS prefix FROM dual/);
  // 수집 SQL 의 칸 순서 = 헤더 없이 읽을 때의 순서
  const selectList = body.slice(body.indexOf('SELECT tc.table_name'), body.indexOf('FROM user_tab_columns tc')).toUpperCase();
  const names = [...selectList.matchAll(/(?:AS\s+|\.)([A-Z_]+),?\s*$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(names, H);
});

test('2. 결과 가져오기: 테이블·컬럼·기본값·PK·UK·FK·인덱스, 타입 정리, (null)', () => {
  const p = importText(text());
  assert.deepStrictEqual(p.problems, []);
  assert.strictEqual(p.kind, 'collect');
  assert.deepStrictEqual(p.summary.prefixes, ['TB_']);
  assert.strictEqual(p.rows, 8);
  assert.strictEqual(p.tables.length, 3);
  assert.strictEqual(p.tables.find((t) => t.name === 'TB_ORDER_V').kind, 'view');
  const col = (t, n) => p.columns.find((c) => c.table === t && c.name === n);
  assert.strictEqual(col('TB_CUSTOMER', 'NAME').typeText, 'VARCHAR2(100 CHAR)', 'DATA_LENGTH(400) 가 아니라 CHAR_LENGTH');
  assert.strictEqual(col('TB_CUSTOMER', 'NAME').comment, '이름, 성명');
  assert.strictEqual(col('TB_ORDER', 'AMOUNT').typeText, 'NUMBER(15,2)');
  assert.strictEqual(col('TB_ORDER', 'ORDER_ID').typeText, 'NUMBER(12)');
  assert.strictEqual(col('TB_ORDER', 'ORDER_ID').nullable, false);
  assert.strictEqual(col('TB_ORDER', 'AMOUNT').default, '0', '기본값 앞뒤 공백 제거');
  assert.strictEqual(col('TB_ORDER', 'REG_DT').default, 'SYSDATE');
  assert.strictEqual(col('TB_ORDER', 'REG_DT').comment, undefined, '(null) 은 빈 값');
  const pk = p.constraints.find((c) => c.name === 'PK_TB_ORDER');
  assert.deepStrictEqual([pk.kind, pk.columns], ['primary', ['ORDER_ID', 'CUST_ID']]);
  const uk = p.constraints.find((c) => c.kind === 'unique');
  assert.deepStrictEqual([uk.name, uk.columns], ['UK_CUST_EMAIL', ['EMAIL']]);
  const fk = p.constraints.find((c) => c.kind === 'foreign');
  assert.deepStrictEqual([fk.name, fk.refTable, fk.refColumns, fk.onDelete], ['FK_ORDER_CUST', 'TB_CUSTOMER', ['CUST_ID'], 'no action']);
  const pkIdx = p.indexes.find((x) => x.name === 'PK_TB_ORDER');
  assert.deepStrictEqual([pkIdx.unique, pkIdx.columns.map((c) => c.name)], [true, ['ORDER_ID', 'CUST_ID']], '인덱스 컬럼 순서 복원');
  const ix = p.indexes.find((x) => x.name === 'IX_ORDER_01');
  assert.deepStrictEqual([ix.unique, ix.columns], [false, [{ name: 'REG_DT', desc: true }]]);
});

test('3. 일부만 복사하면 오류 (그리드가 처음 몇 행만 가져온 경우)', () => {
  const p = importText(text(COLS.slice(0, 3)));
  assert.ok(p.problems.some((x) => x.level === 'error' && x.message.startsWith('컬럼 8개 중 3개만')));
});

test('4. 헤더 없이 / 행 번호 칸이 붙어 복사된 경우', () => {
  const meta = META(COLS.length);
  const p1 = importText(COLS.map((c) => row(c, meta)).join('\n'));
  assert.ok(!p1.problems.some((x) => x.level === 'error'));
  assert.ok(p1.problems.some((x) => x.message.includes('헤더 없이')));
  assert.strictEqual(p1.columns.length, 8);
  const withRowNo = ['\t' + H.join('\t'), ...COLS.map((c, i) => `${i + 1}\t${row(c, meta)}`)].join('\n');
  const p2 = importText(withRowNo);
  assert.deepStrictEqual(p2.problems, []);
  assert.strictEqual(p2.columns.length, 8);
  const rowNoOnlyInData = [H.join('\t'), ...COLS.map((c, i) => `${i + 1}\t${row(c, meta)}`)].join('\n');
  const p3 = importText(rowNoOnlyInData);
  assert.deepStrictEqual(p3.problems, []);
  assert.strictEqual(p3.columns.find((c) => c.name === 'REG_DT').default, 'SYSDATE');
});

test('5. 기본값에 줄바꿈이 섞여 행이 쪼개져도 복구, NULL 글자는 값으로', () => {
  const meta = META(3);
  const cols = [
    { ...COLS[3], DATA_DEFAULT: 'CASE WHEN 1=1' },
    { ...COLS[5], DATA_DEFAULT: 'NULL' },
    { ...COLS[6], DATA_DEFAULT: 'SYSDATE' },
  ];
  const lines = [H.join('\t'), row(cols[0], meta), "  THEN 'A' END", row(cols[1], meta), row(cols[2], meta)];
  const p = importText(lines.join('\n'));
  assert.deepStrictEqual(p.problems, []);
  assert.deepStrictEqual(p.columns.map((c) => c.default), ["CASE WHEN 1=1\n  THEN 'A' END", 'NULL', 'SYSDATE']);
});

test('6. 합치기·파일 이름', () => {
  const r = mergeImport({ main: importText(text()), label: '개발' });
  assert.deepStrictEqual(r.notes, []);
  assert.strictEqual(r.schema.source.schema, 'PLM');
  assert.deepStrictEqual(r.schema.source.prefixes, ['TB_']);
  assert.ok(r.schema.columns.every((c) => c.schema === 'PLM'));
  assert.strictEqual(schemaFileName(r.schema.source), 'PLM@개발.json');
  assert.ok(mergeImport({ codes: importText('CODE_GROUP\tGROUP_NAME\tCODE\tCODE_NAME\nS\t상태\tA\t접수') }).notes.some((n) => n.level === 'error'), '스키마 없이 공통코드만은 저장 불가');
});

test('7. 접두어로 받으면 그 접두어 테이블만 교체, 나머지는 유지 / 공통코드 나중에', () => {
  const existing = mergeImport({ main: importText(text()) }).schema;
  existing.tables.push({ schema: 'PLM', name: 'TC_CODE', kind: 'table', comment: '코드' });
  existing.columns.push({ schema: 'PLM', table: 'TC_CODE', name: 'CODE', position: 1, type: 'string', rawType: 'VARCHAR2', typeText: 'VARCHAR2(10)', nullable: false });
  existing.source.prefixes = ['TB_', 'TC_'];
  const cols = COLS.filter((c) => c.TABLE_NAME !== 'TB_ORDER_V'); // DB 에서 뷰가 지워진 상황
  const r = mergeImport({ existing, main: importText(text(cols, META(cols.length))) });
  assert.deepStrictEqual(r.schema.tables.map((t) => t.name), ['TB_CUSTOMER', 'TB_ORDER', 'TC_CODE']);
  assert.strictEqual(r.keptTables, 1);
  assert.strictEqual(r.fullReplace, false);
  assert.deepStrictEqual(r.schema.source.prefixes, ['TB_', 'TC_']);
  const codes = importText('CODE_GROUP\tGROUP_NAME\tCODE\tCODE_NAME\tSORT_ORDER\tUSE_YN\nORDER_STATUS\t주문상태\tA\t접수\t1\tY');
  assert.strictEqual(codes.kind, 'codes');
  const later = mergeImport({ existing: r.schema, codes });
  assert.deepStrictEqual(later.schema.codes, [{ group: 'ORDER_STATUS', groupName: '주문상태', code: 'A', name: '접수', order: 1, use: true }]);
  assert.strictEqual(later.schema.tables.length, 3);
});

test('8. 인터넷·회사 정의서 쿼리 결과 (한글 별칭, 데이터길이, PK1)', () => {
  const t = [
    'TABLE_NAME\t테이블설명\t컬럼명\tPK\t컬럼설명\t데이터유형\t데이터길이\tNULL여부\t컬럼순서\t기본값',
    'TB_A\t에이\tID\tPK1\t아이디\tNUMBER\t10,0\tN\t1\t(null)',
    'TB_A\t에이\tAMT\t(null)\t금액\tNUMBER\t15,2\tY\t2\t0',
    "TB_A\t에이\tNM\t(null)\t이름, 설명\tVARCHAR2\t50\tY\t3\t'X'",
  ].join('\n');
  const p = importText(t);
  assert.strictEqual(p.kind, 'columns');
  assert.ok(p.problems.some((x) => x.level === 'warn' && x.message.includes('컬럼 명세')));
  assert.deepStrictEqual(p.columns.map((c) => c.typeText), ['NUMBER(10)', 'NUMBER(15,2)', 'VARCHAR2(50)']);
  assert.deepStrictEqual(p.columns.map((c) => c.default), [undefined, '0', "'X'"]);
  assert.strictEqual(p.columns[2].comment, '이름, 설명');
  assert.strictEqual(p.tables[0].comment, '에이');
  assert.deepStrictEqual(p.constraints.map((c) => [c.kind, c.columns]), [['primary', ['ID']]]);
  const r = mergeImport({ main: p, fallbackSchema: 'APP' });
  assert.deepStrictEqual(r.schema.tables.map((x) => x.name), ['TB_A']);
});

test('9. 형식이 아닌 텍스트 / 빈 클립보드 / 헤더만 / JSON', () => {
  assert.ok(importText('').problems.some((p) => p.level === 'error'));
  assert.ok(importText('hello world\nfoo').problems.some((p) => p.level === 'error'));
  assert.ok(importText(H.join('\t') + '\n').problems.some((p) => p.level === 'error'));
  const j = importText(JSON.stringify({ format: 'devboost-schema', version: 1, source: { dbms: 'oracle', schema: 'X' }, tables: [], columns: [] }));
  assert.strictEqual(j.kind, 'json');
  assert.deepStrictEqual([j.json.constraints, j.json.indexes], [[], []]);
  const bad = importText(JSON.stringify({ format: 'devboost-schema', version: 1, source: {}, tables: [], columns: [] }));
  assert.ok(bad.problems.some((p) => p.level === 'error'));
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
  const schema = mergeImport({ main: importText(text()), label: '개발' }).schema;
  const doc = buildTableDoc(schema, { today: '2026-10-26' });
  assert.strictEqual(doc.tableCount, 2, '뷰는 기본으로 빠짐');
  assert.ok(doc.index.startsWith('﻿'));
  assert.ok(doc.index.includes('\r\n'));
  const idx = parseDelimited(doc.index, ',').map((r) => r.cells); // 빈 줄은 빠짐
  assert.deepStrictEqual(idx[0], ['테이블 정의서 목차']);
  assert.deepStrictEqual(idx[2], ['No', '테이블명', '테이블 설명', '구분', '컬럼 수', 'PK', 'FK 수', '인덱스 수']);
  assert.deepStrictEqual(idx[4], ['2', 'TB_ORDER', '주문', '테이블', '4', 'ORDER_ID, CUST_ID', '1', '2']);
  const d = parseDelimited(doc.detail, ',').map((r) => r.cells);
  const head = d.findIndex((r, i) => r[0] === 'No' && r[1] === '컬럼명' && d[i - 2][1] === 'TB_ORDER');
  assert.deepStrictEqual(d[head + 1], ['1', 'ORDER_ID', '주문 ID', 'NUMBER(12)', 'N', '', 'Y(1)', '', '', '']);
  assert.deepStrictEqual(d[head + 2], ['2', 'CUST_ID', '', 'NUMBER(10)', 'N', '', 'Y(2)', '', 'TB_CUSTOMER.CUST_ID', '']);
  assert.deepStrictEqual(d[head + 3], ['3', 'AMOUNT', '금액', 'NUMBER(15,2)', 'Y', '0', '', '', '', '']);
  assert.deepStrictEqual(d[head + 4], ['4', 'REG_DT', '', 'DATE', 'Y', 'SYSDATE', '', '', '', 'IX_ORDER_01(1 DESC)']);
  const email = d.find((r) => r[1] === 'EMAIL');
  assert.strictEqual(email[7], 'UK_CUST_EMAIL');
  assert.strictEqual(d.find((r) => r[1] === 'NAME')[2], '이름, 성명', '쉼표 들어간 코멘트는 따옴표로 감쌈');
  assert.strictEqual(buildTableDoc(schema, { includeViews: true }).tableCount, 3);
  assert.strictEqual(buildTableDoc(schema, { tables: ['TB_ORDER'] }).tableCount, 1);
  assert.deepStrictEqual(tableDocFileNames(schema, '2026-10-26'), {
    index: '테이블정의서_목차_PLM_개발_20261026.csv', detail: '테이블정의서_PLM_개발_20261026.csv',
  });
});

test('12. 데이터 값이 헤더 이름과 같아도 헤더로 오인하지 않음 (컬럼명 REC·COMMENTS 등)', () => {
  const cols = [...COLS, { ...COLS[2], COLUMN_ID: 4, COLUMN_NAME: 'COLUMN_NAME', COLUMN_COMMENT: 'TABLE_NAME', DATA_TYPE: 'VARCHAR2' }];
  const p = importText(text(cols, META(cols.length)));
  assert.deepStrictEqual(p.problems, []);
  assert.strictEqual(p.columns.length, 9);
});

test('13. 그리드 복사(탭)에서는 따옴표를 글자 그대로 읽음', () => {
  const cols = COLS.map((c, i) => (i === 0 ? { ...c, TABLE_COMMENT: '"고객 구분 (1:개인)' } : i === 3 ? { ...c, DATA_DEFAULT: '"PLM"."ISEQ$$_1".nextval' } : c));
  const p = importText(text(cols));
  assert.deepStrictEqual(p.problems, []);
  assert.strictEqual(p.tables.find((t) => t.name === 'TB_CUSTOMER').comment, '"고객 구분 (1:개인)');
  assert.strictEqual(p.columns.length, 8, '뒤 행이 코멘트에 먹히지 않음');
  assert.strictEqual(p.columns.find((c) => c.table === 'TB_ORDER' && c.name === 'ORDER_ID').default, '"PLM"."ISEQ$$_1".nextval');
});

test('14. 전체로 받으면 통째 교체 표시(화면에서 확인), 접두어로 받으면 아님', () => {
  const existing = mergeImport({ main: importText(text()) }).schema;
  const full = mergeImport({ existing, main: importText(text(COLS, META(COLS.length, ''))) });
  assert.strictEqual(full.fullReplace, true);
  assert.strictEqual(full.existingTables, 3);
  assert.strictEqual(mergeImport({ existing, main: importText(text()) }).fullReplace, false);
});

test('15. CSV: 수식으로 읽히는 시작 글자 막기, 숫자는 그대로 / CP949 파일 읽기 / CSV 로 내보낸 결과', () => {
  assert.strictEqual(csvCell('- 삭제예정'), ' - 삭제예정');
  assert.strictEqual(csvCell('=> 미사용'), ' => 미사용');
  assert.strictEqual(csvCell('@user'), ' @user');
  assert.strictEqual(csvCell('-1'), '-1');
  assert.strictEqual(csvCell('a,b'), '"a,b"');
  assert.deepStrictEqual(decodeText(new Uint8Array([0xb0, 0xa1, 0x2c, 0x41])), { text: '가,A', encoding: 'cp949' });
  assert.strictEqual(decodeText(new TextEncoder().encode('가')).encoding, 'utf-8');
  // CSV 내보내기: 쉼표 구분, 줄바꿈 든 기본값은 따옴표로 감싸져 옴
  const meta = META(2);
  const csv = [H.join(','), ...[COLS[5], { ...COLS[6], DATA_DEFAULT: 'SYS\nDATE' }].map((c) => H.map((h) => (h === 'META' ? meta : c[h] === undefined ? '' : String(c[h]))).map(csvCell).join(','))].join('\r\n');
  const p = importText(csv);
  assert.deepStrictEqual(p.problems, []);
  assert.deepStrictEqual(p.columns.map((c) => c.default), ['0', 'SYS\nDATE']);
});

// ───────────── Excel 정의서

const zlib = require('zlib');
const { buildTableDocXlsx, tableDocXlsxName } = require(path.join(OUT, 'tableDoc.js'));
const { safeSheetNames, crc32, colName } = require(path.join(OUT, 'xlsx.js'));

/** 테스트용 zip 읽기: 이름 → 내용(문자열). CRC 도 확인 */
function unzip(buf) {
  const b = Buffer.from(buf);
  const files = {};
  let at = 0;
  while (b.readUInt32LE(at) === 0x04034b50) {
    const method = b.readUInt16LE(at + 8);
    const crc = b.readUInt32LE(at + 14);
    const size = b.readUInt32LE(at + 18);
    const nameLen = b.readUInt16LE(at + 26);
    const extra = b.readUInt16LE(at + 28);
    const name = b.toString('utf8', at + 30, at + 30 + nameLen);
    const start = at + 30 + nameLen + extra;
    const data = b.subarray(start, start + size);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.strictEqual(crc32(raw), crc, `CRC ${name}`);
    files[name] = raw.toString('utf8');
    at = start + size;
  }
  assert.strictEqual(b.readUInt32LE(b.length - 22), 0x06054b50, 'zip 끝 레코드');
  return files;
}

test('16. Excel 정의서: 목차 시트 + 테이블마다 시트, 시트 링크, 스타일', () => {
  const schema = mergeImport({ main: importText(text()), label: '개발' }).schema;
  const x = buildTableDocXlsx(schema, { today: '2026-10-26' });
  assert.strictEqual(x.tableCount, 2);
  const f = unzip(x.data);
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']) {
    assert.ok(f[n], n);
  }
  assert.deepStrictEqual([...f['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), ['목차', 'TB_CUSTOMER', 'TB_ORDER']);
  const idx = f['xl/worksheets/sheet1.xml'];
  assert.match(idx, /<hyperlink ref="B6" location="'TB_ORDER'!A1"/, '목차 → 테이블 시트 링크');
  assert.match(idx, /<autoFilter ref="A4:H6"\/>/);
  const order = f['xl/worksheets/sheet3.xml'];
  assert.match(order, /<t xml:space="preserve">TB_ORDER  주문<\/t>/);
  assert.match(order, /location="'목차'!A1"/, '테이블 시트 → 목차');
  assert.match(order, /<t xml:space="preserve">TB_CUSTOMER.CUST_ID<\/t>/);
  assert.match(order, /<t xml:space="preserve">SYSDATE<\/t>/);
  assert.match(order, /orientation="landscape"/);
  assert.ok(!/[\u0000-\u0008]/.test(order));
  assert.strictEqual(tableDocXlsxName(schema, '2026-10-26'), '테이블정의서_PLM_개발_20261026.xlsx');
});

test('17. 시트 이름 규칙: 31자, 금지 문자, 중복(대소문자 무시) / 열 이름', () => {
  assert.deepStrictEqual(safeSheetNames(['목차', 'A/B', 'X'.repeat(40), 'x'.repeat(40), "'Q'"]), [
    '목차', 'A_B', 'X'.repeat(31), 'x'.repeat(29) + '_2', 'Q',
  ]);
  assert.deepStrictEqual([0, 25, 26, 701, 702].map(colName), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
});
