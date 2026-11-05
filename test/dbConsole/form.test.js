// DB 콘솔: 연결 입력 화면의 값 확인·변환 (화면 없이 도는 순수 로직)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fm = require(path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'connection', 'form.js'));

const filled = { name: '개발 DB', host: '10.0.0.5', port: '1521', targetKind: 'service', target: 'ORCLPDB1', user: 'hr', password: 'pw', savePassword: true, readOnly: false, production: false };

test('빈 화면: 포트 1521, 서비스 이름, 비밀번호 저장 켬', () => {
  const f = fm.emptyForm();
  assert.equal(f.port, '1521');
  assert.equal(f.targetKind, 'service');
  assert.equal(f.savePassword, true);
});

test('확인: 다 맞으면 오류 없음, 빈 칸은 칸마다 이유', () => {
  assert.deepEqual(fm.validateForm(filled, false), {});
  const e = fm.validateForm(fm.emptyForm(), false);
  assert.deepEqual(Object.keys(e).sort(), ['host', 'name', 'password', 'target', 'user']);
  assert.ok(fm.validateForm({ ...filled, port: 'abc' }, false).port);
  assert.ok(fm.validateForm({ ...filled, host: 'db host' }, false).host);
});

test('확인: 비밀번호 — 저장을 켰으면 넣어야 하고, 이미 저장된 것이 있거나 저장을 끄면 비워도 된다', () => {
  assert.ok(fm.validateForm({ ...filled, password: '' }, false).password);
  assert.deepEqual(fm.validateForm({ ...filled, password: '' }, true), {}, '고치는 연결에 저장된 비밀번호가 있음');
  assert.deepEqual(fm.validateForm({ ...filled, password: '', savePassword: false }, false), {}, '저장 안 함 → 접속할 때 물음');
});

test('확인: 연결 문자열 직접 입력이면 호스트·포트는 보지 않는다', () => {
  const raw = { ...filled, host: '', port: '', targetKind: 'raw', target: '(DESCRIPTION=(A=1))' };
  assert.deepEqual(fm.validateForm(raw, false), {});
  assert.ok(fm.validateForm({ ...raw, target: ' ' }, false).target);
});

test('화면 → 저장할 연결: 앞뒤 공백 정리, 포트는 숫자, 직접 입력이면 호스트를 비움', () => {
  const c = fm.formToConfig({ ...filled, name: ' 개발 DB ', host: ' 10.0.0.5 ', port: ' 1522 ', user: ' hr ', readOnly: true }, 'id1');
  assert.deepEqual(c, { id: 'id1', name: '개발 DB', host: '10.0.0.5', port: 1522, targetKind: 'service', target: 'ORCLPDB1', user: 'hr', readOnly: true, production: false, savePassword: true });
  assert.ok(!('password' in c), '비밀번호는 연결 정보에 넣지 않는다');
  const raw = fm.formToConfig({ ...filled, host: '남은 값', targetKind: 'raw', target: ' (DESCRIPTION=(A=1)) ' }, 'id2');
  assert.equal(raw.host, '');
  assert.equal(raw.target, '(DESCRIPTION=(A=1))');
});

test('저장된 연결 → 화면: 비밀번호는 보내지 않는다, 왕복해도 같은 값', () => {
  const c = fm.formToConfig(filled, 'id1');
  const f = fm.formFromConfig(c);
  assert.equal(f.password, '');
  assert.deepEqual(fm.formToConfig(f, 'id1'), c);
});

test('연결 문자열 미리 보기: 다 채워야 보이고, 종류에 따라 모양이 다르다', () => {
  assert.equal(fm.previewConnectString(filled), '10.0.0.5:1521/ORCLPDB1');
  assert.match(fm.previewConnectString({ ...filled, targetKind: 'sid', target: 'ORCL' }), /\(SID=ORCL\)/);
  assert.equal(fm.previewConnectString({ ...filled, targetKind: 'raw', target: ' (DESCRIPTION=(A=1)) ' }), '(DESCRIPTION=(A=1))');
  assert.equal(fm.previewConnectString({ ...filled, target: '' }), '');
  assert.equal(fm.previewConnectString({ ...filled, host: '' }), '');
  assert.equal(fm.previewConnectString({ ...filled, port: 'x' }), '');
});

test('호스트 칸에 한꺼번에 붙여 넣으면 다른 칸에 나눠 채운다', () => {
  const base = fm.emptyForm();
  const jdbc = fm.fillFromHostInput({ ...base, host: 'jdbc:oracle:thin:@10.0.0.5:1522:ORCL' });
  assert.deepEqual([jdbc.host, jdbc.port, jdbc.targetKind, jdbc.target], ['10.0.0.5', '1522', 'sid', 'ORCL']);
  const ez = fm.fillFromHostInput({ ...base, host: 'db.example.com:1521/svc' });
  assert.deepEqual([ez.host, ez.port, ez.targetKind, ez.target], ['db.example.com', '1521', 'service', 'svc']);
  const hp = fm.fillFromHostInput({ ...base, host: 'db.example.com:1522', targetKind: 'sid', target: 'KEEP' });
  assert.deepEqual([hp.host, hp.port, hp.targetKind, hp.target], ['db.example.com', '1522', 'sid', 'KEEP'], '포트만 붙였으면 접속 대상은 그대로');
  const desc = fm.fillFromHostInput({ ...base, host: '(DESCRIPTION=(A=1))' });
  assert.deepEqual([desc.host, desc.targetKind, desc.target], ['', 'raw', '(DESCRIPTION=(A=1))']);
  // 사용자 이름: 비어 있을 때만 URL 의 것을 쓴다
  assert.equal(fm.fillFromHostInput({ ...base, host: 'jdbc:oracle:thin:scott/tiger@//h:1521/s' }).user, 'scott');
  assert.equal(fm.fillFromHostInput({ ...base, user: 'hr', host: 'jdbc:oracle:thin:scott/tiger@//h:1521/s' }).user, 'hr');
  // 나눠 채울 것이 없으면 그대로 둔다
  assert.equal(fm.fillFromHostInput({ ...base, host: '10.0.0.5' }), undefined);
  assert.equal(fm.fillFromHostInput({ ...base, host: 'db host' }), undefined);
  assert.equal(fm.fillFromHostInput({ ...base, host: '' }), undefined);
});
