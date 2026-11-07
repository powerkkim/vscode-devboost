// DB 콘솔: 결과 전체를 CSV 로 흘려 쓰기
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { streamCsv } = require(path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole', 'csvExport.js'));

const cols = [{ name: 'NO' }, { name: 'NM' }];
function cursorOf(pages) {
  const c = { closed: false, asked: [] };
  c.next = async (n) => {
    c.asked.push(n);
    return pages.shift();
  };
  c.close = async () => {
    c.closed = true;
  };
  return c;
}
const sink = () => {
  const parts = [];
  return { parts, write: async (t) => void parts.push(t), text: () => parts.join('') };
};

test('첫 묶음 + 커서를 끝까지: BOM 은 맨 앞 한 번, NULL 은 빈 칸, 쉼표·따옴표는 감쌈', async () => {
  const s = sink();
  const cur = cursorOf([{ rows: [['2', 'a,b']], done: false }, { rows: [['3', 'say "hi"']], done: true }]);
  const seen = [];
  const r = await streamCsv(cols, { rows: [['1', null]], done: false }, cur, s, { batch: 1000, progress: (n) => seen.push(n) });
  assert.deepEqual(r, { rows: 3, complete: true });
  assert.equal(s.text(), '﻿NO,NM\r\n1,\r\n2,"a,b"\r\n3,"say ""hi"""\r\n');
  assert.equal(s.text().split('﻿').length, 2);
  assert.deepEqual(cur.asked, [1000, 1000]);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(cur.closed, false, '끝까지 받으면 드라이버가 닫는다');
});

test('다 받은 결과(커서 없음)는 한 번에', async () => {
  const s = sink();
  const r = await streamCsv(cols, { rows: [['1', 'x']], done: true }, undefined, s, { batch: 10 });
  assert.equal(r.rows, 1);
  assert.equal(s.text(), '﻿NO,NM\r\n1,x\r\n');
});

test('취소하면 다음 묶음을 받지 않고 커서를 닫는다', async () => {
  const s = sink();
  const cur = cursorOf([{ rows: [['2', 'b']], done: false }]);
  let stop = false;
  const r = await streamCsv(cols, { rows: [['1', 'a']], done: false }, cur, s, { batch: 5, progress: () => (stop = true), cancelled: () => stop });
  assert.deepEqual(r, { rows: 1, complete: false });
  assert.deepEqual(cur.asked, []);
  assert.equal(cur.closed, true);
});

test('받다가 실패하면 커서를 닫고 오류를 그대로 던진다', async () => {
  const cur = cursorOf([]);
  cur.next = async () => {
    throw new Error('ORA-01555');
  };
  await assert.rejects(streamCsv(cols, { rows: [], done: false }, cur, sink(), { batch: 5 }), /ORA-01555/);
  assert.equal(cur.closed, true);
});
