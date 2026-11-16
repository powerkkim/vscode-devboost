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
  await sessions.dispose();
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
  await sessions.dispose();
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
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sessions.isConnected('A#2'), false);
  assert.equal(server.alive(), 0, '서버에 남지 않는다');
  await sessions.dispose();
});

test('접속하는 사이에 기능을 끄면(VS Code 닫기) 열린 접속을 바로 닫는다', async () => {
  const { server, sessions } = make();
  server.hold = true;
  const p = sessions.connect(cfg('A'), 'pw', 'A#2');
  await sessions.dispose();
  server.release();
  await assert.rejects(p, (e) => e instanceof ConnectAborted);
  await new Promise((r) => setTimeout(r, 5));
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

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(closedIdle, ['A#2']);
  assert.equal(sessions.isConnected('A'), true, '기본 접속은 사용자가 끊을 때까지');
  assert.equal(sessions.isConnected('A#3'), true, '커밋하지 않은 변경이 있으면 닫지 않는다 (롤백되지 않게)');
  assert.equal(sessions.isConnected('A#4'), true, '실행 중이면 닫지 않는다');
  assert.equal(server.byKey['A#2'].isHealthy(), false, '닫은 접속은 서버에서도 닫힘');

  finish();
  await running;
  dirty.clear();
  assert.deepEqual(sessions.closeIdle(Date.now() + 10_000).sort(), ['A#3', 'A#4', 'A#5']);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(server.alive(), 1, '기본 접속만 남는다');

  // 닫은 뒤 다시 쓰면 새로 접속한다
  const again = await sessions.connect(cfg('A'), 'pw', 'A#2');
  assert.notEqual(again, c2);
  await sessions.dispose();
  assert.equal(server.alive(), 0);
});

test('안 쓰는 시간을 0 으로 두면 닫지 않는다', async () => {
  const { sessions } = make({ idleCloseMs: 0 });
  const c2 = await sessions.connect(cfg('A'), 'pw', 'A#2');
  c2.lastUsed = 0;
  assert.deepEqual(sessions.closeIdle(Date.now()), []);
  await new Promise((r) => setTimeout(r, 5));
  sessions.setIdleClose(1000);
  assert.deepEqual(sessions.closeIdle(Date.now()), ['A#2']);
  await new Promise((r) => setTimeout(r, 5));
  await sessions.dispose();
});

test('use() 는 쓴 시각을 남긴다 (쓰는 동안은 안 쓴 것으로 보지 않는다)', async () => {
  const { sessions } = make();
  const s = await sessions.connect(cfg('A'), 'pw', 'A#2');
  s.lastUsed = 0;
  await s.use(async () => undefined);
  assert.ok(Date.now() - s.lastUsed < 1000);
  await sessions.dispose();
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
  await sessions.dispose();
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
  await sessions.dispose();
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
  assert.deepEqual(order, ['cancel', 'query ended', 'close']); // rollback 이 없는 접속
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

// ── 0.33.0: 닫기 전 롤백 · 커밋 안 한 채 방치 · 접속 수 상한 ──
const { idleAction, roomFor, UNCOMMITTED_WARN_MS } = require(path.join(OUT, 'txGuard.js'));

test('접속을 닫기 전에 ROLLBACK 을 직접 보낸다 (커밋하지 않은 변경 · 잠금을 닫기 동작에 맡기지 않는다)', async () => {
  const order = [];
  const conn = { isHealthy: () => true, cancel: async () => {}, rollback: async () => void order.push('rollback'), close: async () => void order.push('close'), extras: {} };
  const s = new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 });
  await s.close();
  assert.deepEqual(order, ['rollback', 'close']);
});

test('실행 중에 닫으면: 멈춤 → 끝남 → ROLLBACK → 닫기', async () => {
  const order = [];
  let stop;
  const conn = {
    isHealthy: () => true,
    cancel: async () => {
      order.push('cancel');
      stop(new Error('cancelled'));
    },
    rollback: async () => void order.push('rollback'),
    close: async () => void order.push('close'),
    extras: {},
  };
  const s = new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 });
  const q = s.use(() => new Promise((_, rej) => (stop = rej))).catch(() => order.push('query ended'));
  await new Promise((r) => setImmediate(r));
  await s.close();
  await q;
  assert.deepEqual(order, ['cancel', 'query ended', 'rollback', 'close']);
});

test('ROLLBACK 이 실패하거나 답이 없어도 접속은 닫는다. 끊긴 접속에는 보내지 않는다', async () => {
  const mk = (rollback, healthy = true) => {
    const order = [];
    const conn = { isHealthy: () => healthy, cancel: async () => {}, rollback: () => (order.push('rollback'), rollback()), close: async () => void order.push('close'), extras: {} };
    return { order, s: new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 }) };
  };
  const failed = mk(async () => { throw new Error('ORA-03113'); });
  await failed.s.close();
  assert.deepEqual(failed.order, ['rollback', 'close']);
  const dead = mk(async () => {}, false);
  await dead.s.close();
  assert.deepEqual(dead.order, ['close']);
});

test('커밋하지 않은 채 쉬면: 10분에 알리고(한 번만), 정한 시간에 롤백. 0 이면 알리기만', () => {
  const M = 60_000;
  assert.equal(UNCOMMITTED_WARN_MS, 10 * M);
  assert.equal(idleAction(9 * M, 30 * M, false), 'none');
  assert.equal(idleAction(10 * M, 30 * M, false), 'warn');
  assert.equal(idleAction(20 * M, 30 * M, true), 'none', '알림은 한 번만');
  assert.equal(idleAction(30 * M, 30 * M, true), 'rollback');
  assert.equal(idleAction(30 * M, 30 * M, false), 'rollback');
  assert.equal(idleAction(500 * M, 0, true), 'none', '자동 롤백을 끄면 롤백하지 않는다');
  assert.equal(idleAction(10 * M, 0, false), 'warn');
  // 롤백 시간이 짧으면 그 절반에서 알린다
  assert.equal(idleAction(3 * M, 5 * M, false), 'warn');
  assert.equal(idleAction(2 * M, 5 * M, false), 'none');
});

test('접속 수 상한: 자리가 있으면 그냥 열고, 없으면 가장 오래 쉰 콘솔 접속을 고른다 (기본 접속 · 커밋 전 · 실행 중은 빼고)', () => {
  const s = (key, o = {}) => ({ key, consoleOnly: key.includes('#'), dirty: false, running: false, lastUsed: 100, ...o });
  assert.deepEqual(roomFor([s('A'), s('A#2')], 5), { ok: true });
  const full = [s('A', { lastUsed: 1 }), s('A#2', { lastUsed: 50 }), s('A#3', { lastUsed: 10, dirty: true }), s('A#4', { lastUsed: 20, running: true }), s('A#5', { lastUsed: 30 })];
  assert.deepEqual(roomFor(full, 5), { ok: false, victim: 'A#5' }, '기본 접속(A) · 커밋 전(A#3) · 실행 중(A#4)은 닫지 않는다');
  const stuck = full.map((x) => (x.consoleOnly ? { ...x, dirty: true } : x));
  assert.deepEqual(roomFor(stuck, 5), { ok: false, victim: undefined }, '닫을 수 있는 접속이 없으면 열지 않는다');
});
