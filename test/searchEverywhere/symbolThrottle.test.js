// 언어 서버 요청 1초 단위 장치 (search/symbolThrottle.ts). 시간은 1/10 로 줄여서 (100ms = 1초)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SymbolThrottle } = require(path.join(__dirname, '..', '..', 'out', 'features', 'searchEverywhere', 'search', 'symbolThrottle.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 응답에 lsMs 걸리는 가짜 언어 서버. 보낸 검색어를 기록 */
function fakeLs(lsMs) {
  const sent = [];
  return { sent, fetch: (q) => { sent.push(q); return sleep(lsMs).then(() => `결과:${q}`); } };
}
/** text 를 gap ms 간격으로 한 글자씩 입력 */
async function type(th, text, gap, got) {
  for (let i = 1; i <= text.length; i++) {
    const q = text.slice(0, i);
    th.want(q, q, (query, key, r) => got.push(r));
    if (i < text.length) await sleep(gap);
  }
}

test('붙여넣기(한 번에 입력): 1초 뒤 한 번만 요청', async () => {
  const ls = fakeLs(20); const got = [];
  const th = new SymbolThrottle(ls.fetch, 100);
  th.want('Order', 'Order', (q, k, r) => got.push(r));
  await sleep(50);
  assert.deepEqual(ls.sent, [], '1초 전에는 보내지 않음');
  await sleep(300);
  assert.deepEqual(ls.sent, ['Order']);
  assert.deepEqual(got, ['결과:Order']);
});

test('2.5초 동안 입력: 1초·2초·3초 시점에 그때 검색어로, 응답은 마지막 것만', async () => {
  const ls = fakeLs(150); const got = [];
  const th = new SymbolThrottle(ls.fetch, 100);
  await type(th, 'OrderServ', 30, got); // 9글자 × 30ms ≈ 240ms 입력
  await sleep(600);
  assert.ok(ls.sent.length >= 2 && ls.sent.length <= 4, ls.sent.join(','));
  assert.equal(ls.sent[ls.sent.length - 1], 'OrderServ', '마지막 요청은 최종 검색어');
  assert.deepEqual(got, ['결과:OrderServ'], '앞 요청 응답은 버림');
});

test('검색어가 그대로면 다시 보내지 않고 멈춤', async () => {
  const ls = fakeLs(10); const got = [];
  const th = new SymbolThrottle(ls.fetch, 50);
  th.want('A', 'Abc', (q, k, r) => got.push(r));
  await sleep(300);
  th.want('A', 'Abc', (q, k, r) => got.push(r)); // 탭 전환 등 같은 검색어
  await sleep(300);
  assert.deepEqual(ls.sent, ['Abc']);
});

test('창 닫기(stop): 보낸 요청의 응답도 버리고 이후 요청 없음', async () => {
  const ls = fakeLs(100); const got = [];
  const th = new SymbolThrottle(ls.fetch, 50);
  th.want('x', 'xy', (q, k, r) => got.push(r));
  await sleep(70); // 요청은 나갔고 응답 대기 중
  th.stop();
  await sleep(300);
  assert.deepEqual(ls.sent, ['xy']);
  assert.deepEqual(got, []);
});

test('언어 서버 오류·조건 변경 거부: 결과는 버리고 fail 로 알림', async () => {
  const got = []; let failed = 0;
  const th = new SymbolThrottle(() => Promise.reject(new Error('x')), 30);
  th.want('a', 'ab', (q, k, r) => got.push(r), () => failed++);
  await sleep(150);
  assert.deepEqual(got, []);
  assert.equal(failed, 1);
});

test('fetch 는 요청을 만든 키를 받음 (조건 확인용)', async () => {
  const seen = [];
  const th = new SymbolThrottle((q, k) => { seen.push([q, k]); return Promise.resolve(q); }, 30);
  th.want('Order\u0000project', 'Order', () => {});
  await sleep(100);
  assert.deepEqual(seen, [['Order', 'Order\u0000project']]);
});
