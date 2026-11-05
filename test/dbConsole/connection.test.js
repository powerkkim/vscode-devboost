// DB 콘솔: 연결 문자열·입력값 확인·오류 안내 (vscode 모듈 없이 도는 순수 로직)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'connection');
const cs = require(path.join(OUT, 'connectString.js'));
const oc = require(path.join(OUT, 'oracleClient.js'));

const base = { id: '1', name: '개발', host: '10.0.0.5', port: 1521, targetKind: 'service', target: 'ORCLPDB1', user: 'hr', readOnly: false, production: false, savePassword: true };

test('연결 문자열: 서비스 이름은 EZConnect, SID 는 설명자, 직접 입력은 그대로', () => {
  assert.equal(cs.buildConnectString(base), '10.0.0.5:1521/ORCLPDB1');
  assert.equal(
    cs.buildConnectString({ ...base, targetKind: 'sid', target: 'ORCL' }),
    '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.5)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))'
  );
  assert.equal(cs.buildConnectString({ ...base, targetKind: 'raw', target: '  (DESCRIPTION=(X=1))  ' }), '(DESCRIPTION=(X=1))');
  assert.equal(cs.buildConnectString({ ...base, host: ' db.example.com ', target: ' svc ' }), 'db.example.com:1521/svc');
  assert.equal(cs.buildConnectString({ ...base, host: 'fe80::1' }), '[fe80::1]:1521/ORCLPDB1', 'IPv6 는 대괄호');
});

test('목록에 보이는 한 줄', () => {
  assert.equal(cs.describeConnection(base), 'hr@10.0.0.5:1521/ORCLPDB1');
  assert.equal(cs.describeConnection({ ...base, targetKind: 'sid', target: 'ORCL' }), 'hr@10.0.0.5:1521:ORCL');
  const long = cs.describeConnection({ ...base, targetKind: 'raw', target: '(DESCRIPTION=' + 'x'.repeat(100) + ')' });
  assert.ok(long.startsWith('hr@(DESCRIPTION=') && long.endsWith('…') && long.length < 70, long);
});

test('입력값 확인', () => {
  assert.equal(cs.checkName(' 개발 '), undefined);
  assert.ok(cs.checkName('  '));
  assert.equal(cs.checkHost('db.example.com'), undefined);
  assert.ok(cs.checkHost(''));
  assert.ok(cs.checkHost('db example'));
  assert.equal(cs.checkPort('1521'), undefined);
  for (const bad of ['', 'abc', '0', '65536', '15.21', '-1']) assert.ok(cs.checkPort(bad), bad);
  assert.equal(cs.checkTarget('service', 'ORCLPDB1.example.com'), undefined);
  assert.ok(cs.checkTarget('service', ''));
  assert.ok(cs.checkTarget('sid', 'OR CL'));
  assert.ok(cs.checkTarget('service', 'a/b'));
  assert.equal(cs.checkTarget('raw', '(DESCRIPTION=(A=1))'), undefined, '직접 입력은 괄호 허용');
  assert.ok(cs.checkUser(''));
});

test('JDBC URL 붙여 넣기', () => {
  assert.deepEqual(cs.parseJdbcUrl('jdbc:oracle:thin:@//10.0.0.5:1521/ORCLPDB1'), { host: '10.0.0.5', port: 1521, targetKind: 'service', target: 'ORCLPDB1', user: undefined });
  assert.deepEqual(cs.parseJdbcUrl(' jdbc:oracle:thin:@db.example.com:1522/svc.example.com '), { host: 'db.example.com', port: 1522, targetKind: 'service', target: 'svc.example.com', user: undefined });
  assert.deepEqual(cs.parseJdbcUrl('jdbc:oracle:thin:@10.0.0.5:1521:ORCL'), { host: '10.0.0.5', port: 1521, targetKind: 'sid', target: 'ORCL', user: undefined });
  assert.deepEqual(cs.parseJdbcUrl('JDBC:ORACLE:THIN:@//dbhost/svc'), { host: 'dbhost', port: 1521, targetKind: 'service', target: 'svc', user: undefined }, '포트 생략 → 1521');
  assert.deepEqual(cs.parseJdbcUrl('jdbc:oracle:thin:scott/tiger@//h:1521/s'), { host: 'h', port: 1521, targetKind: 'service', target: 's', user: 'scott' }, '사용자 이름만 가져옴');
  assert.deepEqual(cs.parseJdbcUrl('jdbc:oracle:thin:@//[fe80::1]:1521/s'), { host: 'fe80::1', port: 1521, targetKind: 'service', target: 's', user: undefined });
  const desc = '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))';
  assert.deepEqual(cs.parseJdbcUrl(`jdbc:oracle:thin:@${desc}`), { host: '', port: 1521, targetKind: 'raw', target: desc, user: undefined });
  // 붙여 넣은 URL 로 만든 연결 문자열
  const p = cs.parseJdbcUrl('jdbc:oracle:thin:@10.0.0.5:1521:ORCL');
  assert.equal(cs.buildConnectString(p), '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.5)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))');
  for (const no of ['10.0.0.5', 'jdbc:mysql://h/db', 'jdbc:oracle:thin:@', 'jdbc:oracle:thin:@//hostonly']) assert.equal(cs.parseJdbcUrl(no), undefined, no);
});

test('호스트 칸: 주소만 / host:port / host:port/service / host:port:SID / 설명자 / JDBC URL / IPv6', () => {
  assert.deepEqual(cs.parseHostInput(' 10.0.0.5 '), { host: '10.0.0.5', port: undefined });
  assert.deepEqual(cs.parseHostInput('db.example.com:1522'), { host: 'db.example.com', port: 1522 }, '포트를 붙여 써도 IPv6 로 오인하지 않음');
  assert.deepEqual(cs.parseHostInput('db.example.com:1522/svc'), { host: 'db.example.com', port: 1522, targetKind: 'service', target: 'svc' });
  assert.deepEqual(cs.parseHostInput('//dbhost/svc'), { host: 'dbhost', port: 1521, targetKind: 'service', target: 'svc' });
  assert.deepEqual(cs.parseHostInput('10.0.0.5:1521:ORCL'), { host: '10.0.0.5', port: 1521, targetKind: 'sid', target: 'ORCL' });
  assert.deepEqual(cs.parseHostInput('(DESCRIPTION=(A=1))'), { host: '', targetKind: 'raw', target: '(DESCRIPTION=(A=1))' });
  assert.equal(cs.parseHostInput('jdbc:oracle:thin:@//h:1521/s').target, 's');
  assert.deepEqual(cs.parseHostInput('fe80::1'), { host: 'fe80::1' });
  assert.deepEqual(cs.parseHostInput('2001:db8:0:0:0:0:0:1'), { host: '2001:db8:0:0:0:0:0:1' });
  assert.deepEqual(cs.parseHostInput('[fe80::1]:1522/svc'), { host: 'fe80::1', port: 1522, targetKind: 'service', target: 'svc' });
  for (const no of ['', 'db host', 'host:ORCL', 'jdbc:mysql://h/db']) assert.equal(cs.parseHostInput(no), undefined, no);
  // 읽어 낸 값으로 만든 연결 문자열 (예전: host:1522 → [host:1522]:1521/svc 로 깨짐)
  const hp = cs.parseHostInput('db.example.com:1522');
  assert.equal(cs.buildConnectString({ host: hp.host, port: hp.port, targetKind: 'service', target: 'svc' }), 'db.example.com:1522/svc');
});

test('호스트 칸 확인: 읽을 수 없거나 값이 틀리면 이유', () => {
  for (const ok of ['10.0.0.5', 'db.example.com:1522', 'h:1521/svc', 'h:1521:ORCL', '(DESCRIPTION=(A=1))', 'jdbc:oracle:thin:@h:1521:ORCL', 'fe80::1']) {
    assert.equal(cs.checkHostInput(ok), undefined, ok);
  }
  for (const bad of ['', '  ', 'db host', 'host:ORCL', 'h:99999', 'h:99999/svc', 'jdbc:oracle:thin:@', 'jdbc:mysql://h/db', 'a=b']) {
    assert.ok(cs.checkHostInput(bad), bad);
  }
});

test('오류 안내: 코드별 한글 설명 + 원래 메시지 첫 줄', () => {
  const e = Object.assign(new Error('ORA-01017: invalid username/password; logon denied\nHelp: https://docs.oracle.com/error-help/db/ora-01017/'), { code: 'ORA-01017' });
  assert.equal(oc.errorCode(e), 'ORA-01017');
  assert.equal(oc.explainError(e), '사용자 이름 또는 비밀번호가 틀립니다 — ORA-01017: invalid username/password; logon denied');
  // code 속성이 없어도 메시지에서 찾는다
  assert.equal(oc.errorCode(new Error('NJS-503: connection to host 10.0.0.5 port 1521 could not be established.')), 'NJS-503');
  assert.match(oc.explainError(new Error('NJS-138: connections to this database server version are not supported')), /^Oracle 12\.1 보다 낮은 서버/);
  // 모르는 오류는 메시지 그대로
  assert.equal(oc.explainError(new Error('ORA-00942: table or view does not exist')), 'ORA-00942: table or view does not exist');
  assert.equal(oc.explainError('그냥 글자'), '그냥 글자');
});

test('드라이버: Thin 모드로 실제 접속을 시도 (닫힌 포트 → 연결 실패 오류)', async () => {
  // 로컬의 닫힌 포트로 접속 → 드라이버가 실제로 불려 네트워크 오류를 돌려주는지 (DB 없이 확인할 수 있는 범위)
  await assert.rejects(
    oc.testConnection({ ...base, host: '127.0.0.1', port: 1 }, 'x'),
    (e) => {
      assert.match(String(oc.errorCode(e)), /^NJS-5\d\d$/, String(e));
      return true;
    }
  );
  assert.equal(require('oracledb').thin, true);
});
