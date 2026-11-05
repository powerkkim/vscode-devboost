// DB 콘솔: 접속 목록과 끊김 감지 (가짜 접속으로 — 실제 DB 없이 도는 범위)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole');
const { Sessions } = require(path.join(OUT, 'sessions.js'));
const { OracleSession } = require(path.join(OUT, 'connection', 'oracleClient.js'));
const health = require(path.join(OUT, 'connection', 'health.js'));

const cfg = (id) => ({ id, name: id, host: 'h', port: 1521, targetKind: 'service', target: 's', user: 'u', readOnly: false, production: false, savePassword: false });
const err = (code, msg = 'x') => Object.assign(new Error(`${code}: ${msg}`), { code });
const never = () => new Promise(() => {});

/** 가짜 드라이버 접속: healthy·ping 을 테스트에서 바꾼다 */
function fakeConnection() {
  const c = { healthy: true, ping: async () => {}, closed: 0, pings: 0 };
  return {
    state: c,
    isHealthy: () => c.healthy,
    ping: () => (c.pings++, c.ping()),
    close: async () => void c.closed++,
    execute: async () => ({ rows: [] }),
    oracleServerVersionString: '19.0.0.0.0',
  };
}

/** 가짜 접속을 여는 Sessions. conns[id] 로 그 접속을 조작한다 */
function make(options = {}) {
  const conns = {};
  const sessions = new Sessions({
    checkEveryMs: 0,
    pingTimeoutMs: 50,
    ...options,
    open: async (c) => {
      conns[c.id] = fakeConnection();
      return new OracleSession(conns[c.id], { version: '19', schema: 'U', dbName: 'D', ms: 1 });
    },
  });
  const lost = [];
  let changes = 0;
  sessions.onDidLose((l) => lost.push(l));
  sessions.onDidChange(() => changes++);
  return { sessions, conns, lost, changes: () => changes };
}

test('checkAlive: 소켓이 닫혔으면 서버에 다녀오지 않고 끊김', async () => {
  const c = fakeConnection();
  c.state.healthy = false;
  const r = await health.checkAlive(c, 50);
  assert.equal(r.alive, false);
  assert.equal(c.state.pings, 0);
});

test('checkAlive: 답이 오면 살아 있음, 오류면 그 이유, 시간 안에 답이 없으면 끊김', async () => {
  const c = fakeConnection();
  assert.deepEqual(await health.checkAlive(c, 50), { alive: true });
  c.state.ping = async () => {
    throw err('NJS-500', 'connection to the Oracle Database was broken');
  };
  const broken = await health.checkAlive(c, 50);
  assert.equal(broken.alive, false);
  assert.match(broken.reason, /^접속이 끊겼습니다 — NJS-500/);
  c.state.ping = never; // 방화벽이 말없이 끊은 접속: 요청에 답이 없다
  const t0 = Date.now();
  const silent = await health.checkAlive(c, 60);
  assert.equal(silent.alive, false);
  assert.match(silent.reason, /답이 없습니다/);
  assert.ok(Date.now() - t0 < 1000, '기다리는 시간은 정한 만큼만');
});

test('isConnectionLost: 접속이 끊겨서 난 오류만 (쿼리 오류는 아님)', () => {
  for (const code of ['NJS-500', 'NJS-501', 'NJS-521', 'NJS-003', 'ORA-03113', 'ORA-03114', 'ORA-03135', 'ORA-00028', 'ORA-02396', 'ORA-01012']) {
    assert.equal(health.isConnectionLost(err(code)), true, code);
  }
  for (const code of ['ORA-00942', 'ORA-00001', 'ORA-01017', 'NJS-123']) assert.equal(health.isConnectionLost(err(code)), false, code);
  assert.equal(health.isConnectionLost(new Error('ORA-03113: end-of-file on communication channel')), true, 'code 속성이 없어도');
  assert.equal(health.isConnectionLost('그냥 글자'), false);
});

test('주기 확인: 끊긴 접속만 목록에서 빼고 알린다, 살아 있는 접속은 그대로', async () => {
  const { sessions, conns, lost } = make();
  await sessions.connect(cfg('a'), 'pw');
  await sessions.connect(cfg('b'), 'pw');
  assert.deepEqual(await sessions.checkNow(), [], '둘 다 살아 있음');
  conns.a.state.ping = never;
  assert.deepEqual(await sessions.checkNow(), ['a']);
  assert.equal(sessions.isConnected('a'), false);
  assert.equal(sessions.isConnected('b'), true);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].id, 'a');
  assert.match(lost[0].reason, /답이 없습니다/);
  assert.equal(conns.a.state.closed, 1, '끊긴 접속도 드라이버 쪽은 닫아 정리');
  assert.deepEqual(await sessions.checkNow(), [], '이미 뺀 접속은 다시 알리지 않음');
  assert.equal(lost.length, 1);
  sessions.dispose();
});

test('쿼리를 실행하는 중인 접속은 확인을 건너뛴다 (긴 쿼리를 끊김으로 오인하지 않게)', async () => {
  const { sessions, conns, lost } = make();
  const s = await sessions.connect(cfg('a'), 'pw');
  conns.a.state.ping = never; // 실행 중에는 확인이 쿼리 뒤에 줄을 서서 답이 없다
  let finish;
  const running = s.use(() => new Promise((r) => (finish = r)));
  assert.equal(s.busy, true);
  assert.deepEqual(await sessions.checkNow(), []);
  assert.equal(conns.a.state.pings, 0, '서버에 다녀오지도 않음');
  finish();
  await running;
  assert.equal(s.busy, false);
  assert.deepEqual(await sessions.checkNow(), ['a'], '실행이 끝난 뒤에는 확인한다');
  assert.equal(lost.length, 1);
  sessions.dispose();
});

test('확인하는 사이에 쿼리가 시작됐거나 사용자가 끊었으면 판정하지 않는다', async () => {
  const { sessions, conns, lost } = make();
  const s = await sessions.connect(cfg('a'), 'pw');
  let finish;
  conns.a.state.ping = never;
  const check = sessions.checkNow();
  const running = s.use(() => new Promise((r) => (finish = r))); // 확인 도중 쿼리 시작
  assert.deepEqual(await check, []);
  assert.equal(sessions.isConnected('a'), true);
  finish();
  await running;

  const check2 = sessions.checkNow();
  await sessions.disconnect('a'); // 확인 도중 사용자가 끊음
  assert.deepEqual(await check2, []);
  assert.equal(lost.length, 0, '사용자가 끊은 것은 "끊겼습니다"로 알리지 않는다');
  sessions.dispose();
});

test('쓰다가 난 오류: 접속이 끊겨서 난 것이면 목록에서 빼고 알린다', async () => {
  const { sessions, lost } = make();
  await sessions.connect(cfg('a'), 'pw');
  assert.equal(sessions.reportError('a', err('ORA-00942', 'table or view does not exist')), false);
  assert.equal(sessions.isConnected('a'), true, '쿼리 오류는 접속과 관계없다');
  assert.equal(sessions.reportError('a', err('NJS-500', 'connection to the Oracle Database was broken')), true);
  assert.equal(sessions.isConnected('a'), false);
  assert.match(lost[0].reason, /NJS-500/);
  assert.equal(sessions.reportError('a', err('NJS-500')), false, '이미 빠진 접속');
  sessions.dispose();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('소켓 확인: 서버에 다녀오지 않고 닫힌 연결을 알아챈다 (서버 확인을 꺼도 동작)', async () => {
  const { sessions, conns, lost } = make({ checkEveryMs: 0, localCheckMs: 20 });
  await sessions.connect(cfg('a'), 'pw');
  await wait(80);
  assert.equal(sessions.isConnected('a'), true, '멀쩡한 접속은 그대로');
  conns.a.state.healthy = false;
  await wait(100);
  assert.equal(sessions.isConnected('a'), false);
  assert.equal(lost.length, 1);
  assert.equal(conns.a.state.pings, 0, '서버에는 한 번도 다녀오지 않음');
  sessions.dispose();
});

test('서버 확인: 정한 간격이 찼을 때만 다녀온다 (소켓 확인 때마다 다녀오지 않음)', async () => {
  const { sessions, conns, lost } = make({ checkEveryMs: 150, localCheckMs: 20, pingTimeoutMs: 30 });
  await sessions.connect(cfg('a'), 'pw');
  await wait(100);
  assert.equal(conns.a.state.pings, 0, '간격이 차기 전에는 다녀오지 않음 (소켓 확인만 여러 번 돌았음)');
  await wait(150);
  assert.ok(conns.a.state.pings >= 1 && conns.a.state.pings <= 2, `간격마다 한 번: ${conns.a.state.pings}`);
  assert.equal(sessions.isConnected('a'), true);

  conns.a.state.ping = never; // 방화벽이 말없이 끊음: 소켓은 멀쩡해 보이고 답이 없다
  await wait(300);
  assert.equal(sessions.isConnected('a'), false, '서버 확인이 알아챔');
  assert.match(lost[0].reason, /답이 없습니다/);
  sessions.dispose();
});

test('서버 확인을 끄면(0) 말없이 끊긴 접속은 스스로 알아채지 못하고, 직접 확인하거나 쓸 때 안다', async () => {
  const { sessions, conns } = make({ checkEveryMs: 150, localCheckMs: 20, pingTimeoutMs: 30 });
  await sessions.connect(cfg('b'), 'pw');
  sessions.setCheckInterval(0);
  conns.b.state.ping = never;
  await wait(250);
  assert.equal(sessions.isConnected('b'), true);
  assert.equal(conns.b.state.pings, 0);
  assert.deepEqual(await sessions.checkNow(), ['b']);
  sessions.dispose();
});

test('접속·끊기 기본 동작과 정리', async () => {
  const { sessions, conns, changes } = make();
  const [s1, s2] = await Promise.all([sessions.connect(cfg('a'), 'pw'), sessions.connect(cfg('a'), 'pw')]);
  assert.equal(s1, s2, '같은 연결을 동시에 열어도 접속은 하나');
  assert.equal(sessions.isConnected('a'), true);
  assert.ok(changes() >= 2);
  await sessions.disconnect('a');
  assert.equal(sessions.isConnected('a'), false);
  assert.equal(conns.a.state.closed, 1);
  await sessions.connect(cfg('b'), 'pw');
  sessions.dispose();
  assert.equal(conns.b.state.closed, 1, '기능을 끄면 열린 접속을 모두 닫는다');
});
