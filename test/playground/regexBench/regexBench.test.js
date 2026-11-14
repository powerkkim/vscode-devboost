// 정규식 작업대: 패턴 만들기(직접 · 질문 · 예시) · 코드 글 · 자주 쓰는 정규식 · 계산(작업 스레드, 시간 제한)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'out', 'features', 'playground', 'regexBench');
const { compose, ask, guess, problem, toCode, javaReplacement, parsePresets, words, pieceText } = require(path.join(OUT, 'compose.js'));
const { RegexEngine } = require(path.join(OUT, 'engine.js'));
const presets = parsePresets(fs.readFileSync(path.join(ROOT, 'media', 'playground', 'regexBench', 'presets.tsv'), 'utf8'));

const P = (o) => Object.assign({ source: 'KINDS', kinds: [], text: '' }, o);

test('직접 만들기: 조각 · 반복 · 꺼내기 · 앞뒤 조건 · 묶음', () => {
  assert.strictEqual(pieceText(P({ kinds: ['DIGIT'], repeating: { repeat: 'EXACTLY', n: 3 } })), '\\d{3}');
  assert.strictEqual(pieceText(P({ kinds: ['KOREAN', 'UPPER'], text: '-_.]' })), '[가-힣A-Z\\-_.\\]]');
  assert.strictEqual(pieceText(P({ source: 'WORDS', text: '010, 011,010' })), '(?:010|011)');
  assert.strictEqual(pieceText(P({ source: 'WORDS', text: 'a.b', repeating: { repeat: 'ONE_OR_MORE' } })), '(?:a\\.b)+');
  assert.strictEqual(pieceText(P({ source: 'EXCEPT', text: ',' })), '[^,]');
  assert.strictEqual(pieceText(P({ source: 'ANY', repeating: { repeat: 'ONE_OR_MORE', lazy: true, capture: true, name: 'v' }, before: '<b>', after: '<' })), '(?<=<b>)(?<v>.+?)(?=<)');
  const tel = compose(
    [P({ source: 'WORDS', text: '010,011', repeating: { repeat: 'ONCE', capture: true } }), P({ text: '-', repeating: { repeat: 'OPTIONAL' } }), { pieces: [P({ kinds: ['DIGIT'], repeating: { repeat: 'RANGE', n: 3, m: 4 } })], repeating: { repeat: 'ONCE', capture: true } }],
    { whole: true, needs: ['DIGIT'] }
  );
  assert.strictEqual(tel, '^(?=.*\\d)((?:010|011))[\\-]?(\\d{3,4})$');
  assert.ok(new RegExp(tel).test('010-1234') && !new RegExp(tel).test('012-1234'));
  assert.strictEqual(compose([P({ kinds: ['KOREAN'], repeating: { repeat: 'ONE_OR_MORE' } })], { wordOnly: true }), '(?<![가-힣A-Za-z0-9_])[가-힣]+(?![가-힣A-Za-z0-9_])');
  assert.strictEqual(compose([], { whole: true, minLength: 8 }), '^(?=.{8,}$).*$');
  assert.strictEqual(compose([], {}), '');
  assert.strictEqual(compose([{ pieces: [P({ source: 'WORDS', text: 'cat' }), P({ source: 'WORDS', text: 'dog' })], anyOf: true }]), '(?:cat|dog)');
});

test('직접 만들기: 고칠 점', () => {
  assert.strictEqual(problem([P({})]), 'NO_KINDS');
  assert.strictEqual(problem([P({ source: 'WORDS', text: ' , ' })]), 'NO_WORDS');
  assert.strictEqual(problem([P({ source: 'EXCEPT' })]), 'NO_EXCEPT');
  assert.strictEqual(problem([P({ kinds: ['DIGIT'], repeating: { repeat: 'RANGE', n: 5, m: 2 } })]), 'RANGE');
  assert.strictEqual(problem([P({ kinds: ['DIGIT'], repeating: { repeat: 'ONCE', capture: true, name: '1a' } })]), 'NAME');
  assert.strictEqual(problem([{ pieces: [] }]), 'EMPTY_GROUP');
  const named = (name) => P({ kinds: ['DIGIT'], repeating: { repeat: 'ONCE', capture: true, name } });
  assert.strictEqual(problem([named('a'), { pieces: [named('a')] }]), 'DUPLICATE_NAME');
  assert.strictEqual(problem([named('a'), named('b')]), undefined);
  assert.deepStrictEqual(words(' a, b ,a,, '), ['a', 'b']);
});

test('질문 따라가기 · 이모지 글자', () => {
  assert.strictEqual(ask(true, ['KOREAN'], '', { repeat: 'RANGE', n: 2, m: 5 }, true, []), '^[가-힣]{2,5}(?:\\s[가-힣]{2,5})*$');
  assert.strictEqual(ask(false, ['DIGIT'], '', { repeat: 'ONE_OR_MORE' }, false, ['DIGIT']), '\\d+');
  assert.strictEqual(ask(true, [], '', { repeat: 'ONCE' }, false, []), undefined);
  const emoji = pieceText(P({ kinds: ['DIGIT'], text: '😀' }));
  assert.strictEqual(emoji, '(?:[0-9]|😀)');
  assert.ok(new RegExp('^' + emoji + '$').test('😀'));
  const except = new RegExp('^' + pieceText(P({ source: 'EXCEPT', text: '😀,' })) + '+$');
  assert.ok(except.test('ab😎') && !except.test('a😀') && !except.test('a,b'));
});

test('예시로 만들기', () => {
  const g = guess(['010-1234-5678', '011-987-6543'], ['02-123-4567']);
  assert.deepStrictEqual(g, { pattern: '^\\d{3}[\\-]\\d{3,4}[\\-]\\d{4}$', rejectsAll: true });
  const names = guess(['홍길동', '김 철수'], ['홍길동1']);
  assert.ok(names.rejectsAll && ['홍길동', '김 철수'].every((t) => new RegExp(names.pattern).test(t)), names.pattern);
  const loose = guess(['abc'], ['abc']);
  assert.strictEqual(loose.rejectsAll, false);
  assert.strictEqual(guess(['', ''], []), undefined);
});

test('코드 글: JavaScript 리터럴 · Java Pattern.compile · 바꿀 글', () => {
  assert.strictEqual(toCode('js', 'a/b\\/c', 'mgi'), '/a\\/b\\/c/gim');
  assert.strictEqual(toCode('js', '', ''), '/(?:)/');
  assert.strictEqual(toCode('java', '"\\d+"\n', 'gims'), 'Pattern.compile("\\"\\\\d+\\"\\n", Pattern.CASE_INSENSITIVE | Pattern.MULTILINE | Pattern.DOTALL)');
  assert.strictEqual(toCode('java', '\\w', 'gu'), 'Pattern.compile("\\\\w")');
  assert.strictEqual(javaReplacement('$<y>-$1 $&'), '${y}-$1 $0');
});

test('자주 쓰는 정규식: 모두 읽히고, JavaScript 에서 돌고, 예시 글에 맞는 것이 있다', () => {
  assert.ok(presets.length >= 60, String(presets.length));
  for (const p of presets) {
    assert.ok(p.category && p.name, JSON.stringify(p));
    const re = new RegExp(p.pattern, p.flags);
    assert.ok(re.test(p.sample), `${p.name}: 예시 글에 맞지 않음`);
  }
  assert.throws(() => parsePresets('이름\t패턴'), /1번째 줄/);
});

test('계산: 일치 · 그룹 · 이름 그룹 · 바꾸기 · 확인할 글, 문법 오류', async () => {
  const e = new RegexEngine();
  try {
    const r = await e.run({ pattern: '(?<y>\\d{4})-(\\d\\d)|(x)', flags: 'g', text: '2026-11 x', replacement: '$<y>/$2', check: '2026-11' }, 2000);
    assert.strictEqual(r.problem, 'NONE');
    assert.strictEqual(r.count, 2);
    assert.deepStrictEqual(r.matches[0].groups.map((g) => [g.index, g.name, g.value, g.start, g.end]), [[0, null, '2026-11', 0, 7], [1, 'y', '2026', 0, 4], [2, null, '11', 5, 7], [3, null, null, -1, -1]]);
    assert.strictEqual(r.replaced, '2026/11 /');
    assert.deepStrictEqual(r.check, { verdict: 'FULL' });
    const part = await e.run({ pattern: '\\d+', flags: 'gm', text: '', replacement: '', check: 'ab12c' }, 2000);
    assert.deepStrictEqual(part.check, { verdict: 'PARTIAL', part: '12' });
    // m 플래그여도 확인할 글은 글 전체가 맞아야 FULL
    const lines = await e.run({ pattern: '^\\d+$', flags: 'gm', text: '', replacement: '', check: '12\nab' }, 2000);
    assert.strictEqual(lines.check.verdict, 'PARTIAL');
    const bad = await e.run({ pattern: '(', flags: 'g', text: 'a', replacement: '', check: '' }, 2000);
    assert.deepStrictEqual([bad.problem, bad.detail], ['SYNTAX', 'Unterminated group']);
    const empty = await e.run({ pattern: '', flags: 'gu', text: 'a😀', replacement: '-', check: '' }, 2000);
    assert.deepStrictEqual([empty.count, empty.replaced], [3, '-a-😀-']);
    const many = await e.run({ pattern: '.', flags: 'g', text: 'x'.repeat(5000), replacement: '', check: '' }, 5000);
    assert.deepStrictEqual([many.count, many.matches.length], [5000, 1000]);
  } finally {
    e.dispose();
  }
});

test('계산: 끝나지 않는 패턴은 시간 제한으로 끊고, 다음 계산은 새 스레드로 된다', async () => {
  const e = new RegexEngine();
  try {
    const start = Date.now();
    const r = await e.run({ pattern: '(a+)+$', flags: '', text: 'a'.repeat(40) + 'b', replacement: '', check: '' }, 300);
    assert.strictEqual(r.problem, 'TIMEOUT');
    assert.ok(Date.now() - start < 2000);
    const next = await e.run({ pattern: 'a', flags: 'g', text: 'aa', replacement: 'b', check: '' }, 2000);
    assert.deepStrictEqual([next.problem, next.replaced], ['NONE', 'bb']);
    // 끊길 계산 뒤에 줄 선 계산은 끊기지 않고 새 스레드에서 끝난다
    const slow = e.run({ pattern: '(a+)+$', flags: '', text: 'a'.repeat(40) + 'b', replacement: '', check: '' }, 300);
    const queued = e.run({ pattern: 'a+', flags: '', text: 'aab', replacement: '', check: '' }, 2000);
    assert.strictEqual((await slow).problem, 'TIMEOUT');
    assert.deepStrictEqual([(await queued).problem, (await queued).count], ['NONE', 1]);
  } finally {
    e.dispose();
  }
});
