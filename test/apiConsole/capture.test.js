// API 콘솔: 브라우저 캡처 (네트워크 이벤트 모으기, HAR, 캡처 → 요청, 인증 이어받기, WebSocket). vscode 모듈 없이 Node 만으로 동작한다.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const out = (f) => path.join(__dirname, '..', '..', 'out', 'features', 'apiConsole', f);
const C = require(out('capture.js'));
const M = require(out('model.js'));
const W = require(out('ws.js'));
const B = require(out('browser.js'));

test('네트워크 이벤트 → 호출 한 건: XHR · fetch 만, 실제로 나간 헤더, 응답, 걸린 시간', () => {
  const s = new C.CaptureStore();
  // 실제 헤더(쿠키 포함)가 먼저 오는 경우
  s.onEvent('Network.requestWillBeSentExtraInfo', { requestId: '1', headers: { ':method': 'GET', Cookie: 'JSESSIONID=abc', Authorization: 'Bearer T1' } }, 'S');
  const a = s.onEvent('Network.requestWillBeSent', { requestId: '1', type: 'Fetch', timestamp: 10, wallTime: 1700000000, request: { url: 'http://localhost:5173/api/users?page=1', method: 'get', headers: { Accept: 'application/json', Authorization: 'Bearer OLD' } } }, 'S');
  assert.ok(a.changed);
  s.onEvent('Network.requestWillBeSent', { requestId: '2', type: 'Script', request: { url: 'http://localhost:5173/app.js', method: 'GET', headers: {} } }, 'S');
  s.onEvent('Network.requestWillBeSent', { requestId: '3', type: 'Preflight', request: { url: 'http://localhost:5173/api/x', method: 'OPTIONS', headers: {} } }, 'S');
  s.onEvent('Network.responseReceived', { requestId: '1', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Content-Type': 'application/json' } } }, 'S');
  s.onEvent('Network.responseReceivedExtraInfo', { requestId: '1', headers: { 'Set-Cookie': 'a=1' } }, 'S');
  const done = s.onEvent('Network.loadingFinished', { requestId: '1', timestamp: 10.25, encodedDataLength: 321 }, 'S');
  assert.deepStrictEqual(done.finished, { id: a.changed, requestId: '1', sessionId: 'S' });
  assert.strictEqual(s.rows().length, 1);
  const c = s.get(a.changed);
  assert.strictEqual(c.method, 'GET');
  assert.strictEqual(c.type, 'fetch');
  assert.strictEqual(c.at, 1700000000000);
  assert.strictEqual(C.headerOf(c.reqHeaders, 'authorization'), 'Bearer T1');
  assert.strictEqual(C.headerOf(c.reqHeaders, 'cookie'), 'JSESSIONID=abc');
  assert.strictEqual(C.headerOf(c.reqHeaders, ':method'), undefined);
  assert.strictEqual(C.headerOf(c.resHeaders, 'set-cookie'), 'a=1');
  assert.deepStrictEqual([c.status, c.ms, c.size, c.done], [200, 250, 321, true]);
  // 같은 requestId 라도 다른 탭(세션)의 것은 별개
  assert.deepStrictEqual(s.onEvent('Network.loadingFinished', { requestId: '1', timestamp: 11 }, 'OTHER'), {});
});

test('본문을 따로 받아야 하는 요청, 실패, 리다이렉트, 최대 개수', () => {
  const s = new C.CaptureStore(3);
  const p = s.onEvent('Network.requestWillBeSent', { requestId: 'p', type: 'XHR', timestamp: 1, request: { url: 'http://h/api/a', method: 'POST', headers: {}, hasPostData: true } });
  assert.deepStrictEqual(p.needPostData, { id: p.changed, requestId: 'p', sessionId: undefined });
  const q = s.onEvent('Network.requestWillBeSent', { requestId: 'q', type: 'XHR', timestamp: 1, request: { url: 'http://h/api/b', method: 'POST', headers: {}, hasPostData: true, postData: '{"a":1}' } });
  assert.strictEqual(q.needPostData, undefined);
  assert.strictEqual(s.get(q.changed).reqBody, '{"a":1}');
  s.onEvent('Network.loadingFailed', { requestId: 'q', errorText: 'net::ERR_CONNECTION_REFUSED' });
  assert.strictEqual(s.get(q.changed).failed, 'net::ERR_CONNECTION_REFUSED');
  // 리다이렉트: 같은 requestId 로 다시 오면 앞의 것은 3xx 로 끝난다
  const r1 = s.onEvent('Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', timestamp: 2, request: { url: 'http://h/api/old', method: 'GET', headers: {} } });
  const r2 = s.onEvent('Network.requestWillBeSent', { requestId: 'r', type: 'Fetch', timestamp: 3, request: { url: 'http://h/api/new', method: 'GET', headers: {} }, redirectResponse: { status: 302, statusText: 'Found', headers: { Location: '/api/new' } } });
  assert.deepStrictEqual([s.get(r1.changed)?.status, s.get(r1.changed)?.done], [302, true]);
  assert.strictEqual(s.rows().length, 3); // 4건 중 최근 3건
  assert.strictEqual(s.rows()[0].id, r2.changed);
  assert.strictEqual(s.get(p.changed), undefined);
  s.clear();
  assert.strictEqual(s.rows().length, 0);
});

test('HAR 가져오기: XHR · fetch 만, 최근 것이 앞, 본문 · 헤더', () => {
  const har = {
    log: {
      entries: [
        { startedDateTime: '2026-11-14T01:00:00.000Z', time: 12.4, _resourceType: 'document', request: { method: 'GET', url: 'http://localhost:5173/', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'text/html', text: '<html>' } } },
        { startedDateTime: '2026-11-14T01:00:01.000Z', time: 30.6, _resourceType: 'xhr', request: { method: 'POST', url: 'http://localhost:5173/api/users', headers: [{ name: ':authority', value: 'x' }, { name: 'Authorization', value: 'Bearer H1' }, { name: 'Content-Type', value: 'application/json' }], postData: { mimeType: 'application/json', text: '{"name":"kim"}' } }, response: { status: 201, statusText: 'Created', headers: [{ name: 'Content-Type', value: 'application/json' }], content: { mimeType: 'application/json', size: 9, text: '{"id":7}' } } },
        { startedDateTime: '2026-11-14T01:00:02.000Z', time: 5, _resourceType: 'fetch', request: { method: 'GET', url: 'http://localhost:5173/api/users/7', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: 'eyJpZCI6N30=', encoding: 'base64' } } },
      ],
    },
  };
  const got = C.parseHar(JSON.stringify(har));
  assert.deepStrictEqual(got.map((e) => `${e.method} ${e.url}`), ['GET http://localhost:5173/api/users/7', 'POST http://localhost:5173/api/users']);
  assert.strictEqual(got[0].resBase64, true);
  assert.deepStrictEqual([got[1].status, got[1].ms, got[1].reqBody, got[1].resBody], [201, 31, '{"name":"kim"}', '{"id":7}']);
  assert.deepStrictEqual(got[1].reqHeaders, [['Authorization', 'Bearer H1'], ['Content-Type', 'application/json']]);
  assert.strictEqual(C.parseHar('{"x":1}'), undefined);
  assert.strictEqual(C.parseHar('nope'), undefined);
  assert.strictEqual(C.parseHar(JSON.stringify(har), false).length, 3);
});

test('캡처 → 요청: {{baseUrl}}, 파라미터 표, 브라우저 헤더 빼기, 본문 종류', () => {
  const c = {
    id: 'x', at: 0, method: 'POST', type: 'xhr', done: true, status: 200, ms: 5,
    url: 'http://localhost:5173/api/users?dept=A&q=%EA%B9%80',
    reqHeaders: [['Host', 'localhost:5173'], ['Accept', 'application/json, text/plain, */*'], ['Authorization', 'Bearer T'], ['X-XSRF-TOKEN', 'x1'], ['Cookie', 'a=1'], ['sec-ch-ua', 'x'], ['User-Agent', 'x'], ['Content-Type', 'application/json'], ['X-Menu', 'M01'], ['Content-Length', '10']],
    reqBody: '{"name":"kim"}',
  };
  const kept = C.capturedToRequest(c, { baseUrl: 'http://localhost:5173/' });
  assert.strictEqual(kept.url, '{{baseUrl}}/api/users');
  assert.deepStrictEqual(kept.params.map((p) => `${p.key}=${p.value}`), ['dept=A', 'q=김']);
  assert.deepStrictEqual(kept.auth, { type: 'bearer', token: 'T' });
  assert.deepStrictEqual(kept.headers.map((h) => h.key), ['Accept', 'X-XSRF-TOKEN', 'X-Menu']);
  assert.deepStrictEqual([kept.bodyMode, JSON.parse(kept.bodyText)], ['json', { name: 'kim' }]);
  assert.strictEqual(kept.name, '/api/users');
  // 이어받기가 켜져 있으면 인증 헤더는 적지 않는다 (보낼 때 최신 것이 붙는다)
  const dropped = C.capturedToRequest(c, { dropAuth: true });
  assert.strictEqual(dropped.url, 'http://localhost:5173/api/users');
  assert.deepStrictEqual(dropped.auth, { type: 'none' });
  assert.deepStrictEqual(dropped.headers.map((h) => h.key), ['Accept', 'X-Menu']);
  const form = C.capturedToRequest({ ...c, reqHeaders: [['Content-Type', 'application/x-www-form-urlencoded']], reqBody: 'a=1&b=x+y' });
  assert.deepStrictEqual([form.bodyMode, form.bodyForm.map((r) => `${r.key}=${r.value}`), form.headers.length], ['form', ['a=1', 'b=x y'], 0]);
  assert.strictEqual(C.capturedToRequest({ ...c, method: 'GET', reqBody: undefined, reqHeaders: [['Accept', '*/*']] }).headers.length, 0);
});

test('인증 이어받기: 토큰 헤더 · 쿠키를 호스트별로 기억 (포트는 가리지 않음), 최신 값으로', () => {
  assert.deepStrictEqual(['Authorization', 'X-Auth-Token', 'x-xsrf-token', 'X-API-KEY', 'Cookie', 'sec-fetch-site', 'Accept', 'Content-Type'].map(C.isAuthHeader), [true, true, true, true, false, false, false, false]);
  const f = new C.AuthFollow();
  assert.strictEqual(f.learn('http://localhost:5173/api/a', [['Accept', '*/*']]), false);
  assert.strictEqual(f.learn('http://localhost:5173/api/a', [['Authorization', 'Bearer T1'], ['Cookie', 'JSESSIONID=abc; x=1']], 1000), true);
  assert.strictEqual(f.learn('http://localhost:5173/api/b', [['Authorization', 'Bearer T1'], ['Cookie', 'JSESSIONID=abc; x=1']], 2000), false);
  assert.strictEqual(f.learn('http://localhost:5173/api/b', [['authorization', 'Bearer T2'], ['X-XSRF-TOKEN', 'xs']], 3000), true);
  assert.deepStrictEqual(f.headersFor('http://localhost:8080/api/users'), [['Authorization', 'Bearer T2'], ['X-XSRF-TOKEN', 'xs']]);
  assert.deepStrictEqual(f.headersFor('http://other.example/api'), []);
  assert.deepStrictEqual(f.summary(), [{ host: 'localhost', headers: ['Authorization', 'X-XSRF-TOKEN'], cookies: 2, at: 3000 }]);
  const again = new C.AuthFollow();
  again.load(f.toJSON());
  assert.deepStrictEqual(again.summary(), f.summary());
  again.load('깨진 글');
  again.clear();
  assert.deepStrictEqual(again.summary(), []);
});

test('쿠키 이어받기 · 경로 값', () => {
  const jar = new M.CookieJar();
  assert.strictEqual(jar.absorb('http://localhost:5173/app', 'JSESSIONID=abc; theme=dark'), 2);
  assert.strictEqual(jar.absorb('http://localhost:5173/app', 'JSESSIONID=abc; theme=light'), 1);
  assert.strictEqual(jar.header('http://localhost:8080/api/users'), 'JSESSIONID=abc; theme=light');
  assert.strictEqual(jar.header('http://127.0.0.1:8080/api/users'), '');
  // 서버가 새로 내려 준 쿠키가 이어받은 것을 바꾼다
  jar.store('http://localhost:8080/api/login', ['JSESSIONID=new; Path=/']);
  assert.strictEqual(jar.header('http://localhost:8080/api/users'), 'theme=light; JSESSIONID=new');

  assert.deepStrictEqual(M.pathNames('{{baseUrl}}/api/{deptId}/users/{id:[0-9]+}?x={no}'), ['deptId', 'id']);
  const r = { ...M.emptyRequest('t'), url: '{{baseUrl}}/api/{deptId}/users/{id}', pathVars: [{ key: 'id', value: '7 a', enabled: true }, { key: 'deptId', value: '{{dept}}', enabled: true }], params: [{ key: 'q', value: '1', enabled: true }] };
  const b = M.buildRequest(r, { baseUrl: 'http://h', dept: 'D1' }, () => Buffer.alloc(0));
  assert.strictEqual(b.url, 'http://h/api/D1/users/7%20a?q=1');
  assert.deepStrictEqual([b.missing, b.missingPath], [[], []]);
  const m = M.buildRequest({ ...r, pathVars: [{ key: 'id', value: '', enabled: true }] }, { baseUrl: 'http://h' }, () => Buffer.alloc(0));
  assert.deepStrictEqual(m.missingPath, ['deptId', 'id']);
  assert.deepStrictEqual(M.syncPathVars('/a/{x}/{y}', [{ key: 'y', value: '2', enabled: true }, { key: 'z', value: '9', enabled: true }]), [{ key: 'x', value: '', enabled: true }, { key: 'y', value: '2', enabled: true }]);
  // 저장 파일을 읽을 때도 남는다
  const kept = M.normalizeData({ collections: [{ kind: 'request', ...r, origin: 'A#b()' }] }).collections[0];
  assert.deepStrictEqual([kept.pathVars.length, kept.origin], [2, 'A#b()']);
});

test('응답에서 값 꺼내기 · 주소 틀 맞추기', () => {
  const j = { data: { accessToken: 'T', items: [{ id: 7 }, { id: 8 }], 'a.b': 1, obj: { x: 1 }, zero: 0, none: null }, ok: true };
  const pick = (w, json = j) => M.pickValue(json, [['X-Token', 'hh']], w);
  assert.deepStrictEqual(
    ['data.accessToken', 'data.items[1].id', 'data["a.b"]', 'data.obj', 'ok', 'data.zero', ' data.accessToken '].map((w) => pick(w)),
    ['T', '8', '1', '{"x":1}', 'true', '0', 'T']
  );
  assert.deepStrictEqual(['data.nope', 'data.none', 'data..x', 'data.items[9].id', 'data.accessToken.x', '', '[0]'].map((w) => pick(w)), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.strictEqual(pick('[0].id', [{ id: 3 }]), '3');
  assert.strictEqual(pick('@header.x-token'), 'hh');
  assert.strictEqual(pick('@header.none'), undefined);
  assert.strictEqual(pick('@header.x-token', undefined), 'hh'); // JSON 이 아닌 응답에서도 헤더는

  assert.deepStrictEqual(M.matchTemplate('{{baseUrl}}/plm/api/base/users/{userId}', 'http://localhost:5173/plm/api/base/users/7?x=1'), { vars: { userId: '7' }, fixed: 4 });
  // 프록시 · context-path 차이: 뒤에서부터 맞춘다
  assert.deepStrictEqual(M.matchTemplate('{{baseUrl}}/api/base/users/{userId:[0-9]+}', 'http://h/proxy/api/base/users/a%20b'), { vars: { userId: 'a b' }, fixed: 3 });
  assert.deepStrictEqual(M.matchTemplate('http://localhost:8080/api/users', 'http://localhost:5173/api/users'), { vars: {}, fixed: 2 });
  assert.strictEqual(M.matchTemplate('{{baseUrl}}/api/base/users', 'http://h/api/base/users/7'), undefined);
  assert.strictEqual(M.matchTemplate('{{baseUrl}}/api/base/users/{id}', 'http://h/api/base/users'), undefined);
  assert.strictEqual(M.matchTemplate('{{baseUrl}}/{a}/{b}', 'http://h/x/y'), undefined); // 글자가 하나도 안 맞으면 아니다
  assert.deepStrictEqual(M.normalizeData({ collections: [{ kind: 'request', name: 'x', extract: [{ key: 'id', value: 'data.id' }] }] }).collections[0].extract, [{ key: 'id', value: 'data.id', enabled: true }]);
});

/** 시험용 WebSocket 서버: 받은 글을 되돌려 주고, 'big' 이면 큰 글을 조각으로 나눠 보낸다 */
function wsServer() {
  const frame = (opcode, payload, fin = true) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    return Buffer.concat([head, payload]);
  };
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        const opcode = buf[0] & 0x0f;
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x8) return socket.end();
        if (opcode === 0xa) { setTimeout(() => socket.write(frame(0x1, Buffer.from('pong:' + payload.toString()))), 60); continue; } // 보내던 조각이 끝난 뒤에
        const text = payload.toString('utf8');
        if (text === 'big') {
          const big = Buffer.from('한글'.repeat(60000));
          socket.write(frame(0x1, big.subarray(0, 70000), false));
          socket.write(frame(0x9, Buffer.from('p'))); // 조각 사이의 ping
          const rest = frame(0x0, big.subarray(70000), true);
          socket.write(rest.subarray(0, 5)); // 머리가 잘려서 도착
          setTimeout(() => socket.write(rest.subarray(5)), 10);
        } else socket.write(frame(0x1, Buffer.from('echo:' + text)));
      }
    });
    socket.on('error', () => undefined);
  });
  return server;
}

test('WebSocket 클라이언트: 주고받기, 긴 글, 조각난 글, ping', async () => {
  const server = wsServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = await W.WsClient.connect(`ws://127.0.0.1:${server.address().port}/x`);
  const got = [];
  let wake;
  ws.onMessage = (t) => { got.push(t); wake?.(); };
  const next = async (n) => { while (got.length < n) await new Promise((r) => (wake = r)); };
  ws.send('안녕');
  await next(1);
  assert.strictEqual(got[0], 'echo:안녕');
  const long = 'x'.repeat(70000);
  ws.send(long);
  await next(2);
  assert.strictEqual(got[1], 'echo:' + long);
  ws.send('big');
  await next(4);
  assert.strictEqual(got[2], '한글'.repeat(60000));
  assert.strictEqual(got[3], 'pong:p');
  let closed = false;
  ws.onClose = () => (closed = true);
  ws.close();
  assert.strictEqual(closed, true);
  await assert.rejects(W.WsClient.connect(`ws://127.0.0.1:1/x`, 500));
  server.close();
});

// 실제 브라우저로 확인: DEVBOOST_BROWSER_TEST=1 npm test (Chrome · Edge 가 있어야 한다)
test('실제 브라우저 캡처', { skip: !process.env.DEVBOOST_BROWSER_TEST || !B.findBrowser() }, async () => {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
  (async () => {
    await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'kim' }) });
    await fetch('/api/users?page=1', { headers: { Authorization: 'Bearer TOKEN-1', 'X-XSRF-TOKEN': 'xs1' } });
    const x = new XMLHttpRequest(); x.open('PUT', '/api/users/7'); x.setRequestHeader('Authorization', 'Bearer TOKEN-2'); x.setRequestHeader('Content-Type', 'application/json'); x.send('{"name":"한글"}');
    await fetch('/api/big');
  })();
  </script></body></html>`;
  const server = http.createServer((q, s) => {
    let body = '';
    q.on('data', (d) => (body += d));
    q.on('end', () => {
      if (q.url === '/') return s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
      if (q.url === '/api/login') return s.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'JSESSIONID=abc; Path=/; HttpOnly' }).end('{"ok":true}');
      if (q.url === '/api/big') return s.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ x: 'y'.repeat(300000) }));
      s.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ url: q.url, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = new C.CaptureStore();
  const follow = new C.AuthFollow();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devboost-cap-'));
  let closed = false;
  const cap = await B.BrowserCapture.start({ executable: B.findBrowser(), profileDir: dir, startUrl: base + '/', maxBodyBytes: 200000, extraArgs: ['--headless=new', '--no-sandbox', '--disable-gpu'], store, onChange: () => undefined, onRequest: (c) => follow.learn(c.url, c.reqHeaders), onClose: () => (closed = true) });
  try {
    for (let i = 0; i < 100 && !(store.all().length >= 4 && store.all().every((c) => c.done) && store.all().filter((c) => c.resBody !== undefined).length >= 3 && store.all().some((c) => C.headerOf(c.resHeaders, 'set-cookie'))); i++) await new Promise((r) => setTimeout(r, 100));
    const calls = store.all().slice().reverse();
    assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.url.slice(base.length)} ${c.status}`), ['POST /api/login 200', 'GET /api/users?page=1 200', 'PUT /api/users/7 200', 'GET /api/big 200']);
    assert.strictEqual(calls[0].reqBody, '{"id":"kim"}');
    assert.match(C.headerOf(calls[0].resHeaders, 'set-cookie'), /JSESSIONID=abc/);
    assert.strictEqual(C.headerOf(calls[1].reqHeaders, 'cookie'), 'JSESSIONID=abc'); // HttpOnly 쿠키도 보인다
    assert.strictEqual(calls[2].reqBody, '{"name":"한글"}');
    assert.deepStrictEqual(JSON.parse(calls[2].resBody), { url: '/api/users/7', body: '{"name":"한글"}' });
    assert.strictEqual(calls[3].resSkipped, true);
    assert.deepStrictEqual(follow.headersFor('http://127.0.0.1:9/x'), [['Authorization', 'Bearer TOKEN-2'], ['X-XSRF-TOKEN', 'xs1']]);
    assert.strictEqual(follow.summary()[0].cookies, 1);
  } finally {
    cap.stop();
    for (let i = 0; i < 40 && !closed; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 2200));
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(closed, true);
});
