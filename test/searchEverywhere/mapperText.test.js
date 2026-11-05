// Mapper 탭 본문 검색의 순수 로직: 검색할 폴더, 화면 순서·중복 제거, 소속 SQL id, 파일당 한도
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { load } = require('../helpers');

const mt = load('mapperText');
const p = (...parts) => path.join(path.sep === '\\' ? 'C:\\ws' : '/ws', ...parts);

test('본문 검색 폴더: mapper XML 이 든 폴더만, 다른 폴더 안의 폴더는 빼고, 이름이 비슷한 폴더는 따로', () => {
  const files = [
    p('back', 'src', 'main', 'resources', 'mapper', 'OrderMapper.xml'),
    p('back', 'src', 'main', 'resources', 'mapper', 'order', 'OrderItemMapper.xml'),
    p('back', 'src', 'main', 'resources', 'mapper2', 'UserMapper.xml'),
    p('batch', 'sql', 'BatchMapper.xml'),
  ];
  assert.deepEqual(mt.mapperSearchRoots(files, [p()]), [
    p('back', 'src', 'main', 'resources', 'mapper'),
    p('back', 'src', 'main', 'resources', 'mapper2'),
    p('batch', 'sql'),
  ]);
});

test('본문 검색 폴더: mapper 가 없거나 폴더가 너무 많으면 워크스페이스 폴더 그대로', () => {
  assert.deepEqual(mt.mapperSearchRoots([], [p()]), [p()]);
  const many = Array.from({ length: 5 }, (_, i) => p(`m${i}`, 'A.xml'));
  assert.deepEqual(mt.mapperSearchRoots(many, [p()], 4), [p()]);
  assert.equal(mt.mapperSearchRoots(many, [p()], 5).length, 5);
});

const hit = (value, line, strong, file = 'A.xml') => ({ value, file, line, strong });
const match = (line, file = 'A.xml') => ({ file, line, text: `t${line}` });

test('화면 순서: 이름에 그대로 든 것 → 본문 → 글자만 맞은 이름', () => {
  const r = mt.arrangeMapperResults([hit('weak1', 1, false), hit('strong1', 2, true), hit('weak2', 3, false), hit('strong2', 4, true)], [match(10), match(11)], 50);
  assert.deepEqual(r.strong, ['strong1', 'strong2']);
  assert.deepEqual(r.text.map((m) => m.line), [10, 11]);
  assert.deepEqual(r.weak, ['weak1', 'weak2']);
  assert.equal(r.total, 6);
});

test('이름으로 나온 줄과 같은 줄의 본문 결과는 빼고 (파일이 다르면 남김), 개수도 한 번만', () => {
  const r = mt.arrangeMapperResults([hit('findOrder', 3, true)], [match(3), match(3, 'B.xml'), match(5)], 50);
  assert.deepEqual(r.text.map((m) => `${m.file}:${m.line}`), ['B.xml:3', 'A.xml:5']);
  assert.equal(r.total, 3);
});

test('이름은 합쳐서 limit 개, 본문도 limit 개까지 — 전체 개수는 그대로', () => {
  const names = [hit('s1', 1, true), hit('w1', 2, false), hit('s2', 3, true), hit('w2', 4, false)];
  const matches = [match(10), match(11), match(12)];
  const r = mt.arrangeMapperResults(names, matches, 2);
  assert.deepEqual([r.strong, r.weak], [['s1'], ['w1']], '점수순으로 앞의 둘만');
  assert.deepEqual(r.text.map((m) => m.line), [10, 11]);
  assert.equal(r.total, 7);
});

test('limit 에 걸려 화면에 못 나온 이름의 줄은 본문 결과로 남기되, 개수는 두 번 세지 않음', () => {
  const r = mt.arrangeMapperResults([hit('s1', 1, true), hit('hidden', 2, false)], [match(2), match(9)], 1);
  assert.deepEqual(r.strong, ['s1']);
  assert.deepEqual(r.weak, []);
  assert.deepEqual(r.text.map((m) => m.line), [2], '본문 한도(1)까지: 못 나온 이름의 줄이 본문으로 나옴');
  assert.equal(r.total, 3, '이름 2 + 본문 2 − 겹친 줄 1');
});

test('소속 SQL id: 그 줄보다 앞(같은 줄 포함)에 나온 마지막 문장', () => {
  const stmts = [{ line: 8, name: 'second' }, { line: 2, name: 'first' }, { line: 20, name: 'third' }];
  assert.equal(mt.ownerStatement(stmts, 5).name, 'first');
  assert.equal(mt.ownerStatement(stmts, 8).name, 'second');
  assert.equal(mt.ownerStatement(stmts, 99).name, 'third');
  assert.equal(mt.ownerStatement(stmts, 1), undefined, '첫 문장보다 앞 (resultMap 등)');
  assert.equal(mt.ownerStatement(undefined, 5), undefined);
});

test('파일당 한도에 닿은 파일이 있으면 "더 있을 수 있음"', () => {
  const three = [match(1), match(2), match(3), match(1, 'B.xml')];
  assert.equal(mt.hitPerFileCap(three, 3), true);
  assert.equal(mt.hitPerFileCap(three, 4), false);
  assert.equal(mt.hitPerFileCap([], 1), false);
});
