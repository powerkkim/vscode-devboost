// API 콘솔: 변수·URL·본문·cURL·Postman 가져오기·쿠키·보내기. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const M = require(path.join(__dirname, '..', '..', 'out', 'features', 'apiConsole', 'model.js'));
const H = require(path.join(__dirname, '..', '..', 'out', 'features', 'apiConsole', 'http.js'));

const kv = (key, value, extra = {}) => ({ key, value, enabled: true, ...extra });
const req = (over) => ({ ...M.emptyRequest('t'), ...over });
const noFile = () => {
  throw new Error('파일을 읽으면 안 된다');
};

test('변수 채우기: {{이름}}, 값 안의 변수, 없는 변수는 그대로 두고 알려 줌', () => {
  const vars = { baseUrl: 'http://{{host}}:8080', host: 'localhost', token: 'abc', loop: '{{loop}}' };
  const missing = new Set();
  assert.strictEqual(M.fill('{{baseUrl}}/api/{{ id }}?t={{token}}', vars, missing), 'http://localhost:8080/api/{{ id }}?t=abc');
  assert.deepStrictEqual([...missing], ['id']);
  assert.strictEqual(M.fill('{{loop}}', vars), '{{loop}}');
  assert.deepStrictEqual(M.variablesOf({ id: 'e', name: 'e', variables: [kv('a', '1'), { key: 'b', value: '2', enabled: false }, kv(' ', 'x')] }), { a: '1' });
});

test('URL 만들기: 파라미터 붙이기, 이미 있는 ? 뒤에 잇기, 주소에 http 가 없으면 붙임', () => {
  assert.strictEqual(M.buildUrl('localhost:8080/api', [kv('q', '김 철수'), { key: 'off', value: '1', enabled: false }, kv('a&b', '=')], {}), 'http://localhost:8080/api?q=%EA%B9%80%20%EC%B2%A0%EC%88%98&a%26b=%3D');
  assert.strictEqual(M.buildUrl('https://x.io/a?page=1#top', [kv('size', '{{n}}')], { n: '20' }), 'https://x.io/a?page=1&size=20#top');
  assert.strictEqual(M.buildUrl('{{baseUrl}}/a', [], { baseUrl: 'https://dev.example.com' }), 'https://dev.example.com/a');
});

test('요청 만들기: 헤더·인증·본문 종류별', () => {
  let b = M.buildRequest(req({ method: 'post', url: 'http://h/a', headers: [kv('X-A', '{{v}}'), { key: 'X-Off', value: '1', enabled: false }], bodyMode: 'json', bodyText: '{"id":"{{v}}"}', auth: { type: 'bearer', token: 'Bearer {{t}}' } }), { v: '7', t: 'tok' }, noFile);
  assert.deepStrictEqual(b.headers, { 'X-A': '7', Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  assert.strictEqual(b.body.toString(), '{"id":"7"}');
  assert.strictEqual(b.method, 'POST');
  assert.deepStrictEqual(b.missing, []);

  b = M.buildRequest(req({ method: 'POST', url: 'http://h/a', bodyMode: 'form', bodyForm: [kv('name', '김 & 이'), kv('x', '{{none}}')], auth: { type: 'basic', username: 'u', password: 'p:w' } }), {}, noFile);
  assert.strictEqual(b.body.toString(), 'name=%EA%B9%80%20%26%20%EC%9D%B4&x=%7B%7Bnone%7D%7D');
  assert.strictEqual(b.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.strictEqual(b.headers.Authorization, 'Basic ' + Buffer.from('u:p:w').toString('base64'));
  assert.deepStrictEqual(b.missing, ['none']);

  // 직접 적은 Authorization · Content-Type 이 우선, GET 은 본문을 보내지 않는다
  b = M.buildRequest(req({ method: 'GET', url: 'http://h/a', headers: [kv('authorization', 'Key 1')], bodyMode: 'json', bodyText: '{}', auth: { type: 'bearer', token: 't' } }), {}, noFile);
  assert.deepStrictEqual([b.headers, b.body], [{ authorization: 'Key 1' }, undefined]);
  b = M.buildRequest(req({ method: 'PUT', url: 'http://h/a', headers: [kv('content-type', 'application/vnd.x+json')], bodyMode: 'json', bodyText: '[]' }), {}, noFile);
  assert.deepStrictEqual(b.headers, { 'content-type': 'application/vnd.x+json' });
});

test('multipart: 글 칸과 파일 칸, 경계가 든 Content-Type', () => {
  const b = M.buildRequest(req({ method: 'POST', url: 'http://h/up', headers: [kv('Content-Type', 'multipart/form-data')], bodyMode: 'multipart', bodyForm: [kv('title', '보고서'), kv('file', 'C:\\tmp\\a b.txt', { file: true })] }), {}, (p) => Buffer.from('내용:' + p), 'BND');
  assert.strictEqual(b.headers['Content-Type'], 'multipart/form-data; boundary=BND');
  assert.strictEqual(Object.keys(b.headers).length, 1);
  assert.strictEqual(
    b.body.toString(),
    '--BND\r\nContent-Disposition: form-data; name="title"\r\n\r\n보고서\r\n' +
      '--BND\r\nContent-Disposition: form-data; name="file"; filename="a b.txt"\r\nContent-Type: application/octet-stream\r\n\r\n내용:C:\\tmp\\a b.txt\r\n--BND--\r\n'
  );
});

test('cURL 읽기: 브라우저의 Copy as cURL (bash · cmd), 줄 이어 쓰기', () => {
  const bash = `curl 'https://dev.example.com/api/user/list?page=1&q=%EA%B9%80' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc.def' \\
  -H 'content-type: application/json' \\
  -b 'JSESSIONID=1234; lang=ko' \\
  --data-raw '{"deptCd":"D001","note":"it'\\''s"}' \\
  --compressed`;
  let r = M.parseCurl(bash);
  assert.deepStrictEqual([r.method, r.url, r.bodyMode, r.name], ['POST', 'https://dev.example.com/api/user/list', 'json', '/api/user/list']);
  assert.deepStrictEqual(r.params.map((p) => [p.key, p.value]), [['page', '1'], ['q', '김']]);
  assert.deepStrictEqual(r.auth, { type: 'bearer', token: 'abc.def' });
  assert.deepStrictEqual(r.headers.map((h) => h.key), ['accept', 'content-type', 'Cookie']);
  assert.deepStrictEqual(JSON.parse(r.bodyText), { deptCd: 'D001', note: "it's" });

  r = M.parseCurl('curl "http://localhost:8080/api/login" ^\n  -H "Content-Type: application/x-www-form-urlencoded" ^\n  --data-raw "id=kim&pw=a%20b"');
  assert.deepStrictEqual([r.method, r.bodyMode, r.bodyForm.map((p) => [p.key, p.value])], ['POST', 'form', [['id', 'kim'], ['pw', 'a b']]]);

  r = M.parseCurl("curl -XPUT -u admin:pw -F 'title=a' -F 'file=@/tmp/a.png;type=image/png' http://h/up");
  assert.deepStrictEqual([r.method, r.bodyMode, r.auth, r.bodyForm.map((p) => [p.key, p.value, !!p.file])], ['PUT', 'multipart', { type: 'basic', username: 'admin', password: 'pw' }, [['title', 'a', false], ['file', '/tmp/a.png', true]]]);

  r = M.parseCurl('curl -G http://h/s -d q=1 --data-urlencode "name=a b"');
  assert.deepStrictEqual([r.method, r.bodyMode, r.params.map((p) => p.key)], ['GET', 'none', ['q', 'name']]);
  assert.strictEqual(M.parseCurl('curl -I http://h/').method, 'HEAD');
  assert.strictEqual(M.parseCurl('GET http://h/'), undefined);
  assert.strictEqual(M.parseCurl('curl --compressed'), undefined);
});

test('cURL 쓰기 → 다시 읽으면 같은 요청', () => {
  const built = M.buildRequest(req({ method: 'POST', url: 'http://h/a', params: [kv('p', '1')], headers: [kv('X-A', "it's")], bodyMode: 'json', bodyText: '{"a":"b\'c"}' }), {}, noFile);
  const curl = M.toCurl(built);
  assert.match(curl, /^curl -X POST 'http:\/\/h\/a\?p=1' \\\n  -H 'X-A: it'\\''s'/);
  const back = M.parseCurl(curl);
  assert.deepStrictEqual([back.method, back.url, back.params[0].value, back.headers[0].value, JSON.parse(back.bodyText)], ['POST', 'http://h/a', '1', "it's", { a: "b'c" }]);
});

test('가져오기: Postman 모음(v2.1) · Postman 환경 · 내보낸 파일', () => {
  const pm = {
    info: { name: '업무 API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: 'http://localhost:8080' }],
    item: [
      {
        name: '결재',
        item: [
          {
            name: '상신',
            request: {
              method: 'POST',
              header: [{ key: 'X-Trace', value: '1', disabled: true }],
              url: { raw: '{{baseUrl}}/api/approval?dry=1', query: [{ key: 'dry', value: '1' }] },
              body: { mode: 'raw', raw: '{"docId":1}', options: { raw: { language: 'json' } } },
              auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
              description: '결재 문서를 올린다',
            },
          },
        ],
      },
      { name: '메일', request: { method: 'POST', url: 'http://mail/send', body: { mode: 'formdata', formdata: [{ key: 'to', value: 'a@b.c' }, { key: 'att', type: 'file', src: '/tmp/a.pdf' }] } } },
      { name: '핑', request: 'http://h/ping' },
    ],
  };
  const got = M.importJson(JSON.stringify(pm));
  assert.strictEqual(got.collections.length, 1);
  const root = got.collections[0];
  assert.deepStrictEqual([root.kind, root.name, root.items.map((i) => `${i.kind}:${i.name}`)], ['folder', '업무 API', ['folder:결재', 'request:메일', 'request:핑']]);
  const r = root.items[0].items[0];
  assert.deepStrictEqual([r.method, r.url, r.params.map((p) => p.key), r.bodyMode, r.bodyText, r.auth, r.note, r.headers[0].enabled], ['POST', '{{baseUrl}}/api/approval', ['dry'], 'json', '{"docId":1}', { type: 'bearer', token: '{{token}}' }, '결재 문서를 올린다', false]);
  assert.deepStrictEqual(root.items[1].bodyForm.map((f) => [f.key, f.value, !!f.file]), [['to', 'a@b.c', false], ['att', '/tmp/a.pdf', true]]);
  assert.deepStrictEqual(got.environments[0].variables.map((v) => [v.key, v.value]), [['baseUrl', 'http://localhost:8080']]);

  const env = M.importJson(JSON.stringify({ name: '개발', values: [{ key: 'token', value: 'x', enabled: true }] }));
  assert.deepStrictEqual([env.environments[0].name, env.environments[0].variables[0].key], ['개발', 'token']);

  // 내보낸 파일: 환경 변수의 값은 비워서 나가고, 다시 가져오면 id 가 새로 매겨진다
  const out = M.exportJson(got.collections, [{ id: 'e1', name: '운영', variables: [kv('token', '비밀')], confirm: true }]);
  assert.ok(!out.includes('비밀'));
  const back = M.importJson(out);
  assert.deepStrictEqual([back.collections[0].name, back.environments[0].variables[0], back.environments[0].confirm], ['업무 API', kv('token', ''), true]);
  assert.notStrictEqual(back.collections[0].id, root.id);
  assert.strictEqual(M.importJson('{"a":1}'), undefined);
  assert.strictEqual(M.importJson('아님'), undefined);
});

test('저장 파일 모양 맞추기 · 모음 다루기(찾기·복제·옮기기)', () => {
  const d = M.normalizeData({ collections: [{ kind: 'folder', name: 'A', items: [{ kind: 'request', name: 'r1', method: 'post' }, { kind: '?' }, null] }, { kind: 'request', id: 'r2', name: 'r2' }], environments: [{ name: 'e' }], history: [{ request: { name: 'h' }, status: 200 }, {}] });
  assert.deepStrictEqual([d.collections.length, d.collections[0].items.length, d.collections[0].items[0].method, d.environments.length, d.history.length], [2, 1, 'POST', 1, 1]);
  assert.deepStrictEqual(M.normalizeData(undefined), M.emptyData());
  const nodes = d.collections;
  const r1 = nodes[0].items[0].id;
  const copy = M.cloneNode(nodes[0]);
  assert.notStrictEqual(copy.items[0].id, r1);
  assert.strictEqual(M.moveNode(nodes, 'r2', nodes[0].id, true), true); // 폴더 안으로
  assert.deepStrictEqual(nodes[0].items.map((n) => n.name), ['r1', 'r2']);
  assert.strictEqual(M.moveNode(nodes, 'r2', r1, false), true); // r1 앞으로
  assert.deepStrictEqual(nodes[0].items.map((n) => n.name), ['r2', 'r1']);
  assert.strictEqual(M.moveNode(nodes, nodes[0].id, r1, true), false); // 자기 안으로는 안 됨
  assert.strictEqual(M.findNode(nodes, r1).parent, nodes[0].items);
});

test('쿠키 통: 호스트·경로·만료·Secure, 다른 도메인 쿠키는 받지 않음', () => {
  const jar = new M.CookieJar();
  const now = 1_000_000;
  jar.store('http://app.example.com/api/login', ['JSESSIONID=abc; Path=/; HttpOnly', 'pref=ko; Path=/api', 'sec=1; Secure', 'old=1; Max-Age=0', 'evil=1; Domain=other.com', 'wide=1; Domain=example.com; Path=/; Max-Age=60'], now);
  assert.strictEqual(jar.header('http://app.example.com/api/user', now), 'pref=ko; JSESSIONID=abc; wide=1');
  assert.strictEqual(jar.header('http://app.example.com/other', now), 'JSESSIONID=abc; wide=1');
  assert.strictEqual(jar.header('http://www.example.com/', now), 'wide=1');
  assert.strictEqual(jar.header('http://www.example.com/', now + 61_000), '');
  // Path 를 안 적은 쿠키(sec)는 받은 주소의 폴더(/api)에만
  assert.strictEqual(jar.header('https://app.example.com/api/x', now), 'pref=ko; sec=1; JSESSIONID=abc'); // wide 는 위에서 만료돼 치워짐
  jar.store('http://app.example.com/api/logout', ['JSESSIONID=; Path=/; Max-Age=0'], now);
  assert.strictEqual(jar.header('http://app.example.com/other', now), '');
  jar.clear();
  assert.strictEqual(jar.count(), 0);
});

test('보내기: 실제 서버로 — JSON 본문, 압축 풀기, 쿠키 이어 가기, 리다이렉트, 큰 응답 자르기, 오류 말', async () => {
  const seen = [];
  const server = http.createServer((q, s) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: q.method, url: q.url, cookie: q.headers.cookie, auth: q.headers.authorization, ctype: q.headers['content-type'], body });
      if (q.url === '/login') {
        s.writeHead(200, { 'Set-Cookie': ['SID=s1; Path=/', 'lang=ko; Path=/'], 'Content-Type': 'application/json' });
        s.end('{"ok":true}');
      } else if (q.url === '/gzip') {
        s.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' });
        s.end(zlib.gzipSync(JSON.stringify({ name: '김', echo: body })));
      } else if (q.url === '/moved') {
        s.writeHead(302, { Location: '/gzip' });
        s.end();
      } else if (q.url === '/big') {
        s.writeHead(200, { 'Content-Type': 'text/plain' });
        s.end('x'.repeat(5000));
      } else if (q.url === '/euckr') {
        s.writeHead(200, { 'Content-Type': 'text/plain; charset=euc-kr' });
        s.end(Buffer.from([0xb1, 0xe8])); // 김
      } else {
        s.writeHead(404, 'Not Found', { 'Content-Type': 'text/plain' });
        s.end('없음');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new M.CookieJar();
  const opts = { timeoutMs: 5000, insecureTls: false, followRedirects: true, maxBodyBytes: 1000, jar };
  const build = (over) => M.buildRequest(req(over), { base }, noFile);
  try {
    let res = await H.send(build({ method: 'POST', url: '{{base}}/login', bodyMode: 'json', bodyText: '{"id":"kim"}' }), opts);
    assert.deepStrictEqual([res.status, res.body.toString(), seen[0].ctype, seen[0].body, seen[0].cookie], [200, '{"ok":true}', 'application/json', '{"id":"kim"}', undefined]);
    assert.deepStrictEqual(res.headers.filter((h) => h[0] === 'Set-Cookie').length, 2);

    res = await H.send(build({ method: 'POST', url: '{{base}}/moved', bodyMode: 'text', bodyText: 'hi', auth: { type: 'bearer', token: 't' } }), opts);
    // 302 뒤에는 GET 으로, 같은 호스트이므로 인증·쿠키는 그대로
    assert.deepStrictEqual([res.status, res.redirects.length, res.url, JSON.parse(res.body.toString())], [200, 1, base + '/gzip', { name: '김', echo: '' }]);
    assert.deepStrictEqual([seen[1].method, seen[1].cookie, seen[2].method, seen[2].cookie, seen[2].auth], ['POST', 'SID=s1; lang=ko', 'GET', 'SID=s1; lang=ko', 'Bearer t']);
    assert.ok(res.bytes < res.body.length + 40 && res.ms >= 0);
    assert.strictEqual(H.decodeText(res.body, 'application/json; charset=utf-8').includes('김'), true);

    res = await H.send(build({ url: '{{base}}/moved' }), { ...opts, followRedirects: false });
    assert.strictEqual(res.status, 302);

    res = await H.send(build({ url: '{{base}}/big' }), opts);
    assert.deepStrictEqual([res.truncated, res.body.length], [true, 1000]);

    res = await H.send(build({ url: '{{base}}/euckr' }), opts);
    assert.strictEqual(H.decodeText(res.body, 'text/plain; charset=euc-kr'), '김');
    assert.strictEqual(H.isText('text/plain; charset=euc-kr', res.body), true);
    assert.strictEqual(H.isText('image/png', Buffer.from([1, 2])), false);
    assert.strictEqual(H.isText(undefined, Buffer.from([0, 1])), false);

    res = await H.send(build({ url: '{{base}}/nope', headers: [kv('Cookie', 'mine=1')] }), opts);
    assert.deepStrictEqual([res.status, res.statusText, seen[seen.length - 1].cookie], [404, 'Not Found', 'mine=1; SID=s1; lang=ko']);
  } finally {
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(H.send(build({ url: base + '/x' }), opts), (e) => /연결이 거부됐습니다/.test(H.explainError(e)));
  await assert.rejects(H.send({ method: 'GET', url: 'ftp://h/x', headers: {}, missing: [] }, opts), /http, https 주소만/);
});
