// Oracle 워크시트 실행 결과 정리 테스트 (vscode 없이). npm test 가 먼저 compile 한다.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { summarizeRunResult, fmtElapsed, describeRunEnd } = require(path.join(__dirname, '..', '..', 'out', 'core', 'runResult.js'));

test('성공: items 에 오류 없음', () => {
  const s = summarizeRunResult({ data: { items: [{ statementType: 'QUERY' }] }, error: null });
  assert.deepStrictEqual(s, { outcome: 'ok', statements: 1 });
  assert.match(describeRunEnd(s, 1234).text, /실행 끝 \(1\.2초\)/);
});

test('SQL 오류는 items[].error 로 온다', () => {
  const s = summarizeRunResult({
    data: { items: [{}, { error: { message: 'ORA-00942: table or view\n does not exist', errorCode: 'ORA-00942' } }] },
    error: null,
  });
  assert.strictEqual(s.outcome, 'sqlError');
  assert.strictEqual(s.errors, 1);
  assert.strictEqual(s.statements, 2);
  assert.strictEqual(s.message, 'ORA-00942: table or view does not exist');
  const d = describeRunEnd(s, 500);
  assert.strictEqual(d.kind, 'warn');
  assert.match(d.text, /2개 중 오류 1건: ORA-00942/);
});

test('취소·실패·모름', () => {
  const cancel = new Error('No binds were provided');
  cancel.name = 'CancelError';
  assert.strictEqual(summarizeRunResult({ error: cancel, data: null }).outcome, 'cancel');
  const fail = summarizeRunResult({ error: new Error('No session associated with the current worksheet'), data: null });
  assert.strictEqual(fail.outcome, 'fail');
  assert.match(describeRunEnd(fail, 10).text, /No session/);
  assert.strictEqual(summarizeRunResult(undefined).outcome, 'unknown');
  assert.strictEqual(summarizeRunResult({ data: {}, error: null }).outcome, 'ok');
});

test('경과 시간 표시', () => {
  assert.strictEqual(fmtElapsed(400), '0.4초');
  assert.strictEqual(fmtElapsed(59_940), '59.9초');
  assert.strictEqual(fmtElapsed(125_000), '2분 05초');
});
