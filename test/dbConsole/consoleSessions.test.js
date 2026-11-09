// DB 콘솔 여러 개: 콘솔마다 따로 접속할 때 서버에 접속이 남지 않는지 (가짜 접속으로)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole');
const { Sessions, ConnectAborted, sessionKey, connectionOfKey, isConsoleKey } = require(path.join(OUT, 'sessions.js'));
const { DbSession } = require(path.join(OUT, 'driver', 'session.js'));
const { oracleDriver } = require(path.join(OUT, 'drivers', 'oracle', 'index.js'));

const cfg = (id) => ({ id, name: id, host: 'h', port: 1521, targetKind: 'service', target: 's', user: 'u', readOnly: false, production: false, savePassword: false });

/**
 * 가짜 서버: 연 접속·닫은 접속을 센다. alive() = 지금 서버에 남아 있는 접속 수.
 * hold 를 true 로 두면 접속이 열리기를 release() 할 때까지 기다린다 (접속하는 사이에 닫는 경우)
 */
function fakeServer() {
  const server = { opened: 0, closed: 0, hold: false, pending: [], byKey: {} };
  server.alive = () => server.opened - server.closed;
  server.release = () => server.pending.splice(0).forEach((r) => r());
  server.open = async (c, _pw, key) => {
    if (server.hold) await new Promise((r) => server.pending.push(r));
    server.opened++;
    let closed = false;
    const conn = {
      isHealthy: () => !closed,
      ping: async () => {},
      close: async () => {
        if (!closed) {
          closed = true;
          server.closed++;
        }
      },
      cancel: async () => {},
      extras: {},
    };
    server.byKey[key] = conn;
    return new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 });
  };
  return server;
}

const make = (opts = {}) => {
  const server = fakeServer();
  const sessions = new Sessions({ checkEveryMs: 0, idleCloseMs: 1000, ...opts, open: server.open });
  return { server, sessions };
};

test('접속 키: 콘솔 1 은 연결 id 그대로(기본 접속), 2부터 "id#N"', () => {
  assert.equal(sessionKey('A', 1), 'A');
  assert.equal(sessionKey('A', 3), 'A#3');
  assert.equal(connectionOfKey('A#3'), 'A');
  assert.equal(connectionOfKey('A'), 'A');
  assert.equal(isConsoleKey('A'), false);
  assert.equal(isConsoleKey('A#2'), true);
});

test('콘솔마다 따로 접속하고, 끊기는 그 연결의 접속을 모두 닫는다 (다른 연결은 그대로)', async () => {
  const { server, sessions } = make();
  const a1 = await sessions.connect(cfg('A'), 'pw');
  const a2 = await sessions.connect(cfg('A'), 'pw', 'A#2');
  await sessions.connect(cfg('A'), 'pw', 'A#3');
  await sessions.connect(cfg('B'), 'pw');
  assert.notEqual(a1, a2, '콘솔 2 는 다른 접속');
  assert.equal(await sessions.connect(cfg('A'), 'pw', 'A#2'), a2, '같은 키는 같은 접속');
  assert.equal(sessions.countOf('A'), 3);
  assert.deepEqual(sessions.keysOf('A').sort(), ['A', 'A#2', 'A#3']);
  assert.equal(server.alive(), 4);

  await sessions.disconnectAll('A');
  assert.equal(sessions.countOf('A'), 0);
  assert.equal(sessions.isConnected('B'), true);
  assert.equal(server.alive(), 1);
  sessions.dispose();
  assert.equal(server.alive(), 0, '끄면 남은 접속도 닫는다');
});

test('같은 콘솔에서 접속을 두 번 눌러도 접속은 하나만 연다', async () => {
  const { server, sessions } = make();
  server.hold = true;
  const p1 = sessions.connect(cfg('A'), 'pw', 'A#2');
  const p2 = sessions.connect(cfg('A'), 'pw', 'A#2');
  server.release();
  await new Promise((r) => setImmediate(r));
  server.release();
  assert.equal(await p1, await p2);
  assert.equal(server.opened, 1);
  sessions.dispose();
});

test('접속하는 사이에 닫으면(콘솔을 닫음) 열린 접속을 바로 닫고, 쓰는 쪽에는 ConnectAborted', async () => {
  const { server, sessions } = make();
  server.hold = true;
  const p = sessions.connect(cfg('A'), 'pw', 'A#2');
  assert.equal(sessions.isConnecting('A#2'), true);
  assert.deepEqual(sessions.keysOf('A'), ['A#2'], '여는 중인 접속도 끊기 대상');
  await sessions.disconnect('A#2');
  server.release();
  await assert.rejects(p, (e) => e instanceof ConnectAborted);
  assert.equal(sessions.isConnected('A#2'), false);
  assert.equal(server.alive(), 0, '서버에 남지 않는다');
  sessions.dispose();
});

test('접속하는 사이에 기능을 끄면(VS Code 닫기) 열린 접속을 바로 닫는다', async () => {
  const { server, sessions } = make();
  server.hold = true;
  const p = sessions.connect(cfg('A'), 'pw', 'A#2');
  sessions.dispose();
  server.release();
  await assert.rejects(p, (e) => e instanceof ConnectAborted);
  assert.equal(server.alive(), 0);
  await assert.rejects(sessions.connect(cfg('A'), 'pw', 'A#3'), (e) => e instanceof ConnectAborted, '끈 뒤에는 새로 열지 않는다');
  assert.equal(server.opened, 1);
});

test('오래 안 쓴 콘솔 접속만 닫는다: 기본 접속·실행 중·커밋 안 한 변경이 있는 접속은 둔다', async () => {
  const { server, sessions } = make({ idleCloseMs: 1000 });
  const dirty = new Set(['A#3']);
  sessions.setKeepOpen((k) => dirty.has(k));
  const closedIdle = [];
  sessions.onDidCloseIdle((k) => closedIdle.push(k));
  const main = await sessions.connect(cfg('A'), 'pw');
  const c2 = await sessions.connect(cfg('A'), 'pw', 'A#2');
  await sessions.connect(cfg('A'), 'pw', 'A#3');
  const c4 = await sessions.connect(cfg('A'), 'pw', 'A#4');
  const c5 = await sessions.connect(cfg('A'), 'pw', 'A#5');

  const now = Date.now();
  // A#4: 실행 중 (긴 쿼리)
  let finish;
  const running = c4.use(() => new Promise((r) => (finish = r)));
  // A#5: 방금 썼다
  await c5.use(async () => undefined);
  c5.lastUsed = now + 5000;
  main.lastUsed = now - 60_000;
  c2.lastUsed = now - 60_000;
  c4.lastUsed = now - 60_000;
  sessions.get('A#3').lastUsed = now - 60_000;

  assert.deepEqual(sessions.closeIdle(now), ['A#2']);
  assert.deepEqual(closedIdle, ['A#2']);
  assert.equal(sessions.isConnected('A'), true, '기본 접속은 사용자가 끊을 때까지');
  assert.equal(sessions.isConnected('A#3'), true, '커밋하지 않은 변경이 있으면 닫지 않는다 (롤백되지 않게)');
  assert.equal(sessions.isConnected('A#4'), true, '실행 중이면 닫지 않는다');
  assert.equal(server.byKey['A#2'].isHealthy(), false, '닫은 접속은 서버에서도 닫힘');

  finish();
  await running;
  dirty.clear();
  assert.deepEqual(sessions.closeIdle(Date.now() + 10_000).sort(), ['A#3', 'A#4', 'A#5']);
  assert.equal(server.alive(), 1, '기본 접속만 남는다');

  // 닫은 뒤 다시 쓰면 새로 접속한다
  const again = await sessions.connect(cfg('A'), 'pw', 'A#2');
  assert.notEqual(again, c2);
  sessions.dispose();
  assert.equal(server.alive(), 0);
});

test('안 쓰는 시간을 0 으로 두면 닫지 않는다', async () => {
  const { sessions } = make({ idleCloseMs: 0 });
  const c2 = await sessions.connect(cfg('A'), 'pw', 'A#2');
  c2.lastUsed = 0;
  assert.deepEqual(sessions.closeIdle(Date.now()), []);
  sessions.setIdleClose(1000);
  assert.deepEqual(sessions.closeIdle(Date.now()), ['A#2']);
  sessions.dispose();
});

test('use() 는 쓴 시각을 남긴다 (쓰는 동안은 안 쓴 것으로 보지 않는다)', async () => {
  const { sessions } = make();
  const s = await sessions.connect(cfg('A'), 'pw', 'A#2');
  s.lastUsed = 0;
  await s.use(async () => undefined);
  assert.ok(Date.now() - s.lastUsed < 1000);
  sessions.dispose();
});

test('콘솔 접속이 끊기면 onDidLose 에 접속 키와 연결 id 를 함께 준다', async () => {
  const { server, sessions } = make();
  const lost = [];
  sessions.onDidLose((l) => lost.push(l));
  await sessions.connect(cfg('A'), 'pw', 'A#2');
  await server.byKey['A#2'].close(); // 서버가 끊음
  await sessions.checkNow();
  assert.equal(lost.length, 1);
  assert.equal(lost[0].id, 'A#2');
  assert.equal(lost[0].connectionId, 'A');
  sessions.dispose();
});

test('여러 번 열고 닫아도 서버에 남는 접속이 없다', async () => {
  const { server, sessions } = make();
  for (let round = 0; round < 20; round++) {
    const keys = [2, 3, 4].map((n) => sessionKey('A', n));
    await Promise.all(keys.map((k) => sessions.connect(cfg('A'), 'pw', k)));
    if (round % 2) await sessions.disconnectAll('A');
    else await Promise.all(keys.map((k) => sessions.disconnect(k)));
  }
  assert.equal(server.opened, 60);
  assert.equal(server.alive(), 0);
  assert.equal(sessions.size, 0);
  sessions.dispose();
});

test('실행 중에 닫으면 먼저 서버에서 멈추고(cancel) 끝난 뒤 닫는다 (서버에 일하는 세션이 남지 않게)', async () => {
  const order = [];
  let stop;
  const conn = {
    isHealthy: () => true,
    cancel: async () => {
      order.push('cancel');
      stop(new Error('cancelled'));
    },
    close: async () => void order.push('close'),
    extras: {},
  };
  const s = new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 });
  const q = s.use(() => new Promise((_, rej) => (stop = rej))).catch(() => order.push('query ended'));
  await new Promise((r) => setImmediate(r)); // 쿼리가 서버에서 도는 중
  await s.close();
  await q;
  assert.deepEqual(order, ['cancel', 'query ended', 'close']);
});

test('멈추지 않는 쿼리도 기다리다 닫는다 (닫기가 실패하면 끝나는 대로 닫음)', async () => {
  const order = [];
  let finish;
  let running = true;
  const conn = {
    isHealthy: () => true,
    cancel: async () => void order.push('cancel'),
    close: async () => {
      if (running) {
        order.push('close refused');
        throw new Error('call in progress');
      }
      order.push('close');
    },
    extras: {},
  };
  const s = new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 });
  const q = s.use(() => new Promise((r) => (finish = r)));
  const closing = s.close(30);
  await new Promise((r) => setTimeout(r, 60));
  running = false;
  finish();
  await q;
  await closing;
  assert.deepEqual(order, ['cancel', 'close refused', 'close']);
});
