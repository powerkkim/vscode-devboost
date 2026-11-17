// 이름이 바뀐 설정 옮기기. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { migrateSettings, RENAMED_SETTINGS } = require(path.join(__dirname, '..', '..', 'out', 'core', 'settings.js'));

/** 가짜 설정 저장소: { global: {...}, workspace: {...} } */
function fake(init, failOn) {
  const data = { global: { ...(init.global ?? {}) }, workspace: { ...(init.workspace ?? {}) } };
  return {
    data,
    explicit: (key, scope) => data[scope][key],
    write: async (key, value, scope) => {
      if (failOn && failOn(key, scope)) throw new Error('쓸 수 없음');
      if (value === undefined) delete data[scope][key];
      else data[scope][key] = value;
    },
  };
}

test('옛 이름에 적어 둔 값을 새 이름으로 옮기고 옛 값은 지운다 (자리별로)', async () => {
  const s = fake({ global: { 'sqlLog.enabled': false, 'sqlLog.loggers': ['SQL_LOG'], 'searchEverywhere.ui': 'panel' }, workspace: { 'caseConverter.ts.optional': 'nullable' } });
  const moved = await migrateSettings(s);
  assert.deepStrictEqual(s.data, {
    global: { 'dbConsole.sqlLog.enabled': false, 'dbConsole.sqlLog.loggers': ['SQL_LOG'], 'searchEverywhere.ui': 'panel' },
    workspace: { 'codeTools.caseConverter.ts.optional': 'nullable' },
  });
  assert.deepStrictEqual(moved.sort(), ['codeTools.caseConverter.ts.optional', 'dbConsole.sqlLog.enabled', 'dbConsole.sqlLog.loggers']);
  // 두 번째부터는 할 일이 없다
  assert.deepStrictEqual(await migrateSettings(s), []);
});

test('새 이름에 이미 값이 있으면 그 값을 두고 옛 것만 지운다', async () => {
  const s = fake({ global: { 'importJump.hover': false, 'codeTools.importJump.hover': true } });
  assert.deepStrictEqual(await migrateSettings(s), []);
  assert.deepStrictEqual(s.data.global, { 'codeTools.importJump.hover': true });
});

test('한 항목을 쓰지 못해도 나머지는 옮긴다 (못 옮긴 것은 그대로 남아 다음에 다시)', async () => {
  const s = fake({ global: { 'mybatisRunner.codeLens': false }, workspace: { 'mybatisRunner.codeLens': true, 'dbSchema.enabled': false } }, (key, scope) => scope === 'workspace' && key.includes('mybatis'));
  await migrateSettings(s);
  assert.deepStrictEqual(s.data, { global: { 'dbConsole.mybatis.codeLens': false }, workspace: { 'mybatisRunner.codeLens': true, 'dbConsole.schema.enabled': false } });
});

test('바뀐 이름 표: 새 이름은 모두 묶음(DB 콘솔 · 코드 도구) 아래', () => {
  // 뜻이 바뀌어 끝 이름까지 바꾼 것 (0.34.0: 최근 쿼리 수 → 최근 요청 수)
  const meaning = new Set(['sqlLog.maxQueries', 'dbConsole.sqlLog.maxQueries']);
  for (const [o, n] of Object.entries(RENAMED_SETTINGS)) {
    assert.match(n, /^(dbConsole|codeTools)\.[a-zA-Z]+\./, `${o} → ${n}`);
    if (meaning.has(o)) assert.strictEqual(n, 'dbConsole.sqlLog.maxRequests');
    else assert.ok(n.endsWith(o.slice(o.indexOf('.'))), `${o} → ${n}: 뒷부분 이름은 그대로`);
  }
});
