// JavaScript 작업대: 예제 읽기 · 고르기로 만든 코드 · 실행기(실제 Node 로 돌림)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'out', 'features', 'playground', 'jsBench');
const MEDIA = path.join(ROOT, 'media', 'playground', 'jsBench');
const { parseExamples, trimBlankLines } = require(path.join(OUT, 'examples.js'));
const { generatePipeline, quote, field } = require(path.join(OUT, 'pipeline.js'));
const { startRun, parseLine, viewOf, failed, browserOnlyName, MARK } = require(path.join(OUT, 'runner.js'));

const TS_LIB = path.join(ROOT, 'node_modules', 'typescript', 'lib');
const run = (mode, code, data = '', extra = {}) =>
  startRun({ node: process.execPath, harness: path.join(MEDIA, 'harness.js'), mode, code, data, timeoutMs: 10000, ...extra });
const done = (...a) => run(...a).done;
const examples = parseExamples(fs.readFileSync(path.join(MEDIA, 'examples.txt'), 'utf8'));

test('예제 모음: 모두 읽히고 묶음 · 제목 · 코드가 있다', () => {
  assert.ok(examples.length >= 500, String(examples.length));
  for (const e of examples) assert.ok(e.group && e.title && e.code, e.title);
  assert.ok(examples.some((e) => e.viewOnly) && examples.some((e) => e.data));
  assert.strictEqual(new Set(examples.map((e) => e.group + '\n' + e.title)).size, examples.length, '같은 묶음에 같은 제목');
});

test('예제 글 읽기: 설명 잇기 · 화면 전용 · 데이터 · 빈 줄 떼기, 모양이 틀리면 줄 번호와 함께 오류', () => {
  const [a, b] = parseExamples('## 묶음\r\n### 하나\n> 설명\n> 둘째 줄\n\nconst x = 1;\n  x;\n\n--- 데이터\n[1]\n\n### 둘\n@보기만\ndocument.title\n> 코드 안의 글\n');
  assert.deepStrictEqual(a, { group: '묶음', title: '하나', description: '설명 둘째 줄', viewOnly: false, code: 'const x = 1;\n  x;', data: '[1]' });
  assert.deepStrictEqual(b, { group: '묶음', title: '둘', description: '', viewOnly: true, code: 'document.title\n> 코드 안의 글', data: '' });
  assert.throws(() => parseExamples('### 묶음 없음\ncode'), /1줄/);
  assert.throws(() => parseExamples('## g\n글'), /2줄/);
  assert.throws(() => parseExamples('## g\n### 빈 예제\n> 설명만\n'), /2줄/);
  assert.strictEqual(trimBlankLines('\n \n a  \n\n b\n\n'), ' a\n\n b');
});

test('실행기 한 줄 읽기', () => {
  assert.deepStrictEqual(parseLine('그냥 글'), { kind: 'text', text: '그냥 글' });
  assert.deepStrictEqual(parseLine(MARK + '{"kind":"log","text":"a"}'), { kind: 'log', text: 'a' });
  assert.deepStrictEqual(parseLine(MARK + '{"kind":"table","columns":["#","a"],"rows":[["0",null]],"more":2}'), { kind: 'table', text: '', columns: ['#', 'a'], rows: [['0', '']], more: 2 });
  assert.deepStrictEqual(parseLine(MARK + '{깨진'), { kind: 'text', text: '{깨진' });
  assert.deepStrictEqual(parseLine(MARK + '{"kind":"모름"}'), { kind: 'text', text: '{"kind":"모름"}' });
  assert.strictEqual(browserOnlyName('ReferenceError: document is not defined'), 'document');
  assert.strictEqual(browserOnlyName('ReferenceError: foo is not defined'), undefined);
});

test('실행: console.log · console.table · 마지막 값, data 는 JSON · 엑셀 표', async () => {
  const r = await done('run-js', "console.log('안녕', {a: 1}); console.table(data); data.length", '[{"A":1},{"A":2,"B":"x"}]');
  assert.strictEqual(r.exitCode, 0);
  assert.ok(!failed(r));
  const v = viewOf(r);
  assert.match(v.output, /^안녕 \{ a: 1 \}\n\[표 1: 2줄 → "표" 탭\]\n\[마지막 값\] 2\n$/);
  assert.deepStrictEqual(v.tables, [{ columns: ['#', 'A', 'B'], rows: [['0', '1', ''], ['1', '2', 'x']], more: 0 }]);
  const tsv = await done('run-js', 'data', 'PART_NO\tQTY\n0012\t1,200\n');
  assert.deepStrictEqual(viewOf(tsv).tables[0].rows, [['0', '0012', '1200']]);
});

test('실행: 최상위 await, 오류는 코드 자리와 함께, 화면 전용 이름이면 안내', async () => {
  const a = await done('run-js', 'const v = await Promise.resolve(3);\nreturn v * 2;');
  assert.match(viewOf(a).output, /\[마지막 값\] 6/);
  const e = await done('run-js', '\nnull.x');
  assert.ok(failed(e));
  assert.match(viewOf(e).output, /\[오류\] TypeError: .*\n\s+at .*작업대\.js:2/);
  const b = await done('run-js', "document.getElementById('a')");
  assert.match(viewOf(b).output, /document 은\(는\) 브라우저/);
});

test('실행: TypeScript', async () => {
  const r = await done('run-ts', 'interface Row { n: number }\nconst rows: Row[] = [{ n: 1 }, { n: 2 }];\nrows.reduce((s, r) => s + r.n, 0)', '', { tsLib: TS_LIB });
  assert.match(viewOf(r).output, /\[마지막 값\] 3/);
  const none = await done('run-ts', '1');
  assert.ok(failed(none));
});

test('실행: 끝나지 않는 반복은 시간 제한으로, 출력이 넘치면 그 자리에서, 멈추기로 끊는다. 임시 폴더는 지운다', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('devboost-jsbench-')).length;
  const t = await done('run-js', 'while (true) {}', '', { timeoutMs: 700 });
  assert.deepStrictEqual([t.timedOut, t.truncated, t.cancelled, t.exitCode], [true, false, false, -1]);
  const big = await done('run-js', "const s = 'x'.repeat(1000); while (true) console.log(s);");
  assert.deepStrictEqual([big.timedOut, big.truncated, big.exitCode], [false, true, -1]);
  const r = run('run-js', 'setInterval(() => {}, 1000)');
  setTimeout(() => r.stop(), 300);
  const s = await r.done;
  assert.deepStrictEqual([s.timedOut, s.cancelled, s.exitCode], [false, true, -1]);
  await assert.rejects(startRun({ node: path.join(os.tmpdir(), '없는-node'), harness: 'x', mode: 'run-js', code: '', data: '', timeoutMs: 1000 }).done);
  assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('devboost-jsbench-')).length, before);
});

test('바꾸기: 엑셀 표 → JSON, 칸 이름, TS 타입, defineProps', async () => {
  const out = async (mode, data) => (await done(mode, '', data)).events.find((e) => e.kind === 'out')?.text;
  assert.deepStrictEqual(JSON.parse(await out('tsv', 'USER_NM\tAGE\n김\t30')), [{ USER_NM: '김', AGE: 30 }]);
  assert.deepStrictEqual(JSON.parse(await out('camel', '[{"USER_NM":"김"}]')), [{ userNm: '김' }]);
  assert.match(await out('ts', '[{"id":1,"name":"a"},{"id":2}]'), /export interface Row \{\n  id: number;\n  name\?: string;\n\}/);
  assert.match(await out('props', '{"title":"a","count":1}'), /title: \{ type: String, default: '' \}/);
  const bad = await done('pretty', '그냥 글');
  assert.ok(failed(bad));
});

test('고르기로 만들기: 만든 코드가 실제로 돈다', async () => {
  assert.strictEqual(quote("a'b\\\n "), "'a\\'b\\\\\\n\\u2028'");
  assert.strictEqual(field('r', 'PART_NO'), 'r.PART_NO');
  assert.strictEqual(field('r', '부품 번호'), "r['부품 번호']");
  const data = JSON.stringify([
    { 차종: 'NX4', 금액: 100, 'PART NO': 'A' }, { 차종: 'CN7', 금액: 50, 'PART NO': 'B' }, { 차종: 'NX4', 금액: 30, 'PART NO': 'A' }, { 차종: 'NX4', 금액: 5, 'PART NO': 'C' },
  ]);
  const rows = async (spec) => {
    const r = await done('run-js', generatePipeline(spec), data);
    assert.ok(!failed(r), viewOf(r).output);
    return viewOf(r).tables[0];
  };
  assert.deepStrictEqual((await rows({})).rows.length, 4);
  const grouped = await rows({ filterColumn: '금액', filterOp: 'GE', filterValue: '30', groupColumn: '차종', aggregate: 'SUM', aggColumn: '금액', sortColumn: 'SUM_금액', sortDescending: true });
  assert.deepStrictEqual(grouped, { columns: ['#', '차종', 'SUM_금액'], rows: [['0', 'NX4', '130'], ['1', 'CN7', '50']], more: 0 });
  const distinct = await rows({ distinctColumn: 'PART NO', sortColumn: 'PART NO', limit: 2 });
  assert.deepStrictEqual(distinct.rows.map((r) => r[3]), ['A', 'B']);
  assert.deepStrictEqual((await rows({ aggregate: 'COUNT' })).rows, [['0', '4']]);
  assert.deepStrictEqual((await rows({ filterColumn: '차종', filterOp: 'CONTAINS', filterValue: "N'X" })).rows, []);
});

test('예제: 화면 전용이 아닌 것은 모두 오류 없이 돈다', { timeout: 300000 }, async () => {
  const todo = examples.filter((e) => !e.viewOnly);
  const bad = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const e = todo[next++];
      const r = await done('run-js', e.code, e.data);
      if (failed(r)) bad.push(`${e.group} / ${e.title}: ${viewOf(r).output.split('\n').find((l) => l.startsWith('[오류]')) ?? (r.timedOut ? '시간 초과' : '실패')}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, os.cpus().length) }, worker));
  assert.deepStrictEqual(bad, []);
});
