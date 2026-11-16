// DB 콘솔: 커밋할 것이 있는지를 서버의 실제 상태에 맞추는지 (가짜 VS Code + 가짜 접속)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out', 'features', 'dbConsole');
const { createVscodeStub, installVscodeStub } = require('../vscodeStub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 콘솔 하나를 가짜 화면 · 가짜 서버에 붙인다. server.tx = 서버에 열린 트랜잭션이 있는가 */
function setup() {
  const { vscode } = createVscodeStub(ROOT);
  const base = Object.getPrototypeOf(vscode);
  const asked = [];
  const answers = [];
  const panels = [];
  const win = new Proxy(base.window, {
    get: (t, k) => {
      if (k === 'showWarningMessage')
        return (m, ...rest) => {
          asked.push(String(m));
          const a = answers.shift();
          return Promise.resolve(rest.includes(a) ? a : undefined);
        };
      if (k === 'createWebviewPanel')
        return () => {
          const listeners = [];
          const disposers = [];
          const posted = [];
          const p = {
            title: '',
            active: true,
            webview: { html: '', cspSource: 'x', asWebviewUri: (u) => u, postMessage: async (m) => (posted.push(m), true), onDidReceiveMessage: (fn) => (listeners.push(fn), { dispose() {} }) },
            reveal() {},
            onDidDispose: (fn) => (disposers.push(fn), { dispose() {} }),
            onDidChangeViewState: () => ({ dispose() {} }),
            dispose: () => disposers.forEach((f) => f()),
            send: (m) => listeners.forEach((f) => f(m)),
            posted,
          };
          panels.push(p);
          return p;
        };
      return t[k];
    },
  });
  const restore = installVscodeStub(new Proxy(base, { get: (t, k) => (k === 'window' ? win : t[k]) }));
  for (const f of ['console.js', 'sessions.js']) delete require.cache[require.resolve(path.join(OUT, f))];
  const { Sessions } = require(path.join(OUT, 'sessions.js'));
  const { DbConsole } = require(path.join(OUT, 'console.js'));
  const { DbSession } = require(path.join(OUT, 'driver', 'session.js'));
  const { oracleDriver } = require(path.join(OUT, 'drivers', 'oracle', 'index.js'));

  // 가짜 서버: 접속 키마다 트랜잭션 상태. onExecute 로 문장이 서버 상태를 어떻게 바꾸는지 정한다
  const server = { tx: {}, asks: 0, log: [], closed: [], onExecute: () => {} };
  const open = async (_c, _pw, key) => {
    let alive = true;
    const conn = {
      execute: async (sql) => {
        server.log.push(`${key}: ${sql}`);
        const r = server.onExecute(key, sql);
        return r ?? { kind: 'ok', ms: 1 };
      },
      commit: async () => void ((server.tx[key] = false), server.log.push(`${key}: <commit>`)),
      rollback: async () => void ((server.tx[key] = false), server.log.push(`${key}: <rollback>`)),
      hasOpenTransaction: async () => (server.asks++, !!server.tx[key]),
      cancel: async () => {},
      isHealthy: () => alive,
      ping: async () => {},
      close: async () => void ((alive = false), server.closed.push(key)),
      extras: {},
    };
    return new DbSession(oracleDriver, conn, { product: 'Oracle', version: '19', schema: 'U', dbName: 'D', ms: 1 });
  };
  const cfg = { id: 'X', name: '개발DB', host: 'h', port: 1521, targetKind: 'service', target: 's', user: 'u' };
  const sessions = new Sessions({ checkEveryMs: 0, idleCloseMs: 1000, open });
  const ev = () => ({ dispose() {} });
  let rid = 0;
  const con = new DbConsole({
    context: { extensionUri: base.Uri.file(ROOT) },
    store: { get: (id) => (id === 'X' ? cfg : undefined), onDidChange: ev },
    consoles: { load: async () => undefined, save: async () => {} },
    history: { add: async () => {} },
    sessions,
    results: { fetchMore: null, setLimits() {}, maxRows: 10000, beginRun() {}, dropConnection() {}, addLog() {}, addRows: () => ++rid, onDidAppend: ev, onDidDrop: ev },
    formActions: {},
    ensureSession: async (c, key = c.id) => {
      if (!sessions.isConnected(key)) await sessions.connect(c, 'pw', key);
      return sessions.get(key);
    },
    pickConnection: async () => cfg,
    tableNames: () => [],
    columnNames: async () => [],
  });
  let seq = 0;
  const openTab = async () => {
    const n = panels.length;
    con.openNew(cfg);
    await sleep(20);
    panels[n].send({ type: 'ready' });
    await sleep(20);
    return panels[n];
  };
  const run = async (p, sql) => {
    const key = 'k' + ++seq;
    p.send({ type: 'run', statements: [{ key, sql, start: 0, end: sql.length, line: 1 }], params: {} });
    await sleep(60);
    return p.posted.filter((m) => m.type === 'inline' && m.key === key).pop()?.result;
  };
  const status = (p) => p.posted.filter((m) => m.type === 'status').pop();
  const done = async () => {
    con.dispose();
    await sessions.dispose();
    restore();
  };
  return { server, sessions, con, asked, answers, openTab, run, status, done };
}

const DML = (server, key) => ((server.tx[key] = true), { kind: 'count', rowsAffected: 1, ms: 1 });

test('조회만 하는 동안은 서버에 트랜잭션 상태를 묻지 않는다', async () => {
  const t = setup();
  t.server.onExecute = () => ({ kind: 'rows', columns: [], page: { rows: [], done: true }, ms: 1 });
  const p = await t.openTab();
  await t.run(p, 'select 1 from dual');
  await t.run(p, 'select 2 from dual');
  assert.equal(t.server.asks, 0);
  await t.done();
});

test('PL/SQL 안에서 커밋했으면: 센 것이 있어도 서버에 트랜잭션이 없으니 "커밋 전" 표시를 푼다', async () => {
  const t = setup();
  const p = await t.openTab();
  t.server.onExecute = (key, sql) => (/^update/i.test(sql) ? DML(t.server, key) : void (t.server.tx[key] = false)); // 블록은 안에서 커밋한다
  const r1 = await t.run(p, 'update t set v = 1 where id = 1');
  assert.equal(r1.pending, true);
  assert.equal(t.status(p).dirty, 1);
  await t.run(p, 'begin pkg.save_all; end;');
  assert.equal(t.status(p).dirty, 0, '커밋 안 한 변경 표시가 사라진다');
  assert.equal(p.posted.filter((m) => m.type === 'txEnd').pop().what, 'ended');
  await t.done();
});

test('블록이 커밋하지 않았으면 커밋 전으로 남는다', async () => {
  const t = setup();
  const p = await t.openTab();
  t.server.onExecute = (key) => void (t.server.tx[key] = true);
  const r = await t.run(p, 'begin pkg.change_only; end;');
  assert.equal(r.pending, true);
  assert.equal(t.status(p).dirty, 1);
  assert.equal(p.posted.some((m) => m.type === 'txEnd'), false);
  await t.done();
});

test('ROLLBACK TO SAVEPOINT 는 트랜잭션을 끝내지 않는다 (앞의 변경 · 잠금은 그대로)', async () => {
  const t = setup();
  const p = await t.openTab();
  t.server.onExecute = (key, sql) => (/^update/i.test(sql) ? DML(t.server, key) : undefined);
  await t.run(p, 'update t set v = 1 where id = 1');
  await t.run(p, 'savepoint sp1');
  await t.run(p, 'update t set v = 2 where id = 2');
  await t.run(p, 'rollback to savepoint sp1');
  assert.equal(t.status(p).dirty > 0, true, '커밋 전으로 남는다');
  assert.equal(p.posted.some((m) => m.type === 'txEnd'), false);
  t.server.onExecute = (key) => void (t.server.tx[key] = false);
  await t.run(p, 'rollback');
  assert.equal(t.status(p).dirty, 0);
  assert.equal(p.posted.filter((m) => m.type === 'txEnd').pop().what, 'rollback');
  await t.done();
});

test('조회처럼 보인 문장이 트랜잭션을 열었으면(DB 링크 등): 콘솔을 닫을 때 묻지 않고 롤백하지 않는다 — 묻는다', async () => {
  const t = setup();
  await t.openTab(); // 콘솔 1 (기본 접속)
  const p = await t.openTab(); // 콘솔 2 (따로 접속)
  t.server.onExecute = (key) => ((t.server.tx[key] = true), { kind: 'rows', columns: [], page: { rows: [], done: true }, ms: 1 });
  await t.run(p, 'select * from t@remote_link');
  assert.equal(t.status(p).dirty, 0, '실행 직후에는 모른다 (조회는 묻지 않는다)');
  t.answers.push('커밋');
  p.dispose();
  await sleep(80);
  assert.match(t.asked.join('\n'), /콘솔 2 에 커밋하지 않은 변경/);
  assert.ok(t.server.log.includes('X#2: <commit>'), '고른 대로 커밋한다');
  assert.ok(t.server.closed.includes('X#2'), '그 뒤 접속을 닫는다');
  await t.done();
});

test('쉬는 접속을 닫기 직전에 서버에 묻는다: 열린 트랜잭션이 있으면 닫지 않고 커밋 전으로 보인다', async () => {
  const t = setup();
  await t.openTab();
  const p2 = await t.openTab();
  const p3 = await t.openTab();
  t.server.onExecute = (key) => ((t.server.tx[key] = key === 'X#2'), { kind: 'rows', columns: [], page: { rows: [], done: true }, ms: 1 });
  await t.run(p2, 'select f_with_dml(1) from dual'); // 함수 안에서 변경 → 트랜잭션이 열렸다
  await t.run(p3, 'select 1 from dual');
  const later = Date.now() + 5000;
  assert.deepEqual(t.sessions.closeIdle(later), [], '바로 닫지 않고 먼저 묻는다');
  await sleep(60);
  assert.equal(t.sessions.isConnected('X#2'), true, '트랜잭션이 열린 접속은 둔다');
  assert.equal(t.sessions.isConnected('X#3'), false, '아무것도 없는 접속은 닫는다');
  assert.equal(t.status(p2).dirty, 1, '커밋 전으로 보인다 (10분 알림 · 30분 롤백 대상)');
  const used = t.sessions.get('X#2').lastUsed;
  await t.sessions.get('X#2').openTransaction();
  assert.equal(t.sessions.get('X#2').lastUsed, used, '상태 확인은 "쓴 시각"을 바꾸지 않는다');
  await t.done();
});

test('드라이버가 상태를 모르면(undefined) 실행한 문장을 센 대로 둔다', async () => {
  const t = setup();
  const p = await t.openTab();
  t.server.onExecute = (key) => DML(t.server, key);
  await t.run(p, 'update t set v = 1 where id = 1');
  const s = t.sessions.get('X');
  s.connection.hasOpenTransaction = async () => undefined;
  await t.run(p, 'begin null; end;');
  assert.equal(t.status(p).dirty, 2);
  await t.done();
});
