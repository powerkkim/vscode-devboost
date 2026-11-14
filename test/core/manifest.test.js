// package.json(명령 · 메뉴 · 단축키 · 설정)과 코드가 서로 맞는지. 실제 VS Code 없이 잡을 수 있는 어긋남을 여기서 잡는다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));
const c = pkg.contributes;
const { RENAMED_SETTINGS } = require(path.join(ROOT, 'out', 'core', 'settings.js'));

const sections = [].concat(c.configuration);
const settings = Object.assign({}, ...sections.map((s) => s.properties));
const live = Object.fromEntries(Object.entries(settings).filter(([, v]) => !v.deprecationMessage));
const commands = new Set(c.commands.map((x) => x.command));

/** src 아래 모든 .ts */
function sources(dir = path.join(ROOT, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}
const code = sources().map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

/** when 조건들 */
function whens() {
  const out = [];
  const walk = (x, where) => {
    if (Array.isArray(x)) x.forEach((y) => walk(y, where));
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) (k === 'when' && typeof v === 'string' ? out.push({ when: v, where, item: x }) : walk(v, where));
  };
  for (const k of ['menus', 'keybindings', 'views', 'viewsWelcome']) walk(c[k], k);
  return out;
}

test('메뉴 · 단축키가 가리키는 명령은 모두 선언돼 있고, 선언한 명령은 명령 팔레트 조건이 있다', () => {
  for (const [menu, items] of Object.entries(c.menus)) for (const m of items) if (m.command) assert.ok(commands.has(m.command), `${menu}: ${m.command}`);
  for (const k of c.keybindings) assert.ok(commands.has(k.command), `단축키: ${k.command}`);
  const palette = new Set(c.menus.commandPalette.map((m) => m.command));
  for (const cmd of commands) assert.ok(palette.has(cmd), `명령 팔레트 조건 없음: ${cmd}`);
});

test('코드가 등록하는 명령과 선언한 명령이 같다', () => {
  const registered = new Set();
  for (const { text } of code) {
    for (const m of text.matchAll(/registerCommand\(\s*['"`](devBoost\.[\w.]+)['"`]/g)) registered.add(m[1]);
  }
  // 이름을 조립해 한꺼번에 등록하는 곳: registerCommand(`devBoost.<기능>.${이름}`, …) → 그 접두어의 명령은 등록되는 것으로 본다
  const prefixes = code.flatMap(({ text }) => [...text.matchAll(/registerCommand\(\s*`(devBoost\.[\w.]+\.)\$\{/g)].map((m) => m[1]));
  const missing = [...commands].filter((x) => !registered.has(x) && !prefixes.some((pre) => x.startsWith(pre)));
  assert.deepStrictEqual(missing, [], '선언했지만 등록하지 않는 명령');
});

test('when 조건의 설정은 모두 있는 boolean 설정이고, 묶음 안 기능의 조건에는 묶음 스위치도 있다', () => {
  for (const { when, where, item } of whens()) {
    const keys = [...when.matchAll(/config\.(devBoost\.[\w.]+)/g)].map((m) => m[1]);
    for (const k of keys) {
      assert.ok(live[k], `${where} ${item.command ?? item.id ?? ''}: 없는 설정 ${k}`);
      assert.strictEqual(live[k].type, 'boolean', k);
      const parts = k.split('.'); // devBoost.<묶음>.<기능>.enabled → 묶음 스위치도 함께
      if (parts.length === 4 && parts[3] === 'enabled' && live[`devBoost.${parts[1]}.enabled`]) {
        assert.ok(keys.includes(`devBoost.${parts[1]}.enabled`), `${where} ${item.command ?? ''}: ${k} 만 있고 묶음 스위치가 없음 — ${when}`);
      }
    }
  }
});

test('기능의 스위치(switches)는 모두 선언된 설정이고, 켜기/끄기 구획에는 묶음 스위치만 있다', () => {
  const used = new Set();
  for (const { text, file } of code) {
    for (const m of text.matchAll(/switches:\s*\[([^\]]*)\]/g)) {
      const keys = [...m[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
      assert.ok(keys.length, file);
      for (const k of keys) {
        assert.strictEqual(live['devBoost.' + k]?.type, 'boolean', `${file}: 스위치 ${k}`);
        used.add(k);
      }
    }
  }
  const top = Object.keys(sections[0].properties).map((k) => k.replace('devBoost.', ''));
  assert.deepStrictEqual(top.sort(), ['apiConsole.enabled', 'codeTools.enabled', 'dbConsole.enabled', 'searchEverywhere.enabled', 'sourceAtlas.enabled']);
  for (const k of top) assert.ok(used.has(k) || k === 'codeTools.enabled', k);
  assert.ok(used.has('codeTools.enabled'));
});

test('코드가 읽는 설정 구획(getConfiguration)에는 선언된 설정이 있고, 읽는 이름도 선언돼 있다', () => {
  for (const { text, file } of code) {
    const secs = [...text.matchAll(/getConfiguration\(\s*'(devBoost[\w.]*)'\s*\)/g)].map((m) => m[1]);
    for (const sec of secs) assert.ok(Object.keys(live).some((k) => k.startsWith(sec + '.')), `${file}: ${sec} 아래에 설정이 없음`);
    // 구획을 한 가지만 읽는 파일에서는 .get('이름') 도 맞는지 본다
    const uniq = [...new Set(secs)];
    if (uniq.length !== 1) continue;
    for (const m of text.matchAll(/\b(?:cfg\(\)|cfg|config|conf)\s*\.get(?:<[^>]*>)?\(\s*'([\w.]+)'/g)) {
      assert.ok(live[`${uniq[0]}.${m[1]}`], `${file}: 없는 설정 ${uniq[0]}.${m[1]}`);
    }
  }
});

test('이전 설정 이름: 표(core/settings.ts)와 package.json 이 같고, 새 이름과 종류 · 기본값이 같다', () => {
  const deprecated = Object.keys(settings).filter((k) => settings[k].deprecationMessage).map((k) => k.replace('devBoost.', ''));
  assert.deepStrictEqual(deprecated.sort(), Object.keys(RENAMED_SETTINGS).sort());
  for (const [o, n] of Object.entries(RENAMED_SETTINGS)) {
    const a = settings['devBoost.' + o];
    const b = live['devBoost.' + n];
    assert.ok(b, `새 이름이 없음: ${n}`);
    assert.strictEqual(a.type, b.type, o);
    assert.deepStrictEqual(a.default, b.default, o);
    assert.ok(a.deprecationMessage.includes('devBoost.' + n), o);
  }
});

test('명령 분류는 "DevBoost · 묶음 이름" 다섯 가지 중 하나', () => {
  const allowed = new Set(['DevBoost · Search Everywhere', 'DevBoost · DB 콘솔', 'DevBoost · API 콘솔', 'DevBoost · Source Atlas', 'DevBoost · 코드 도구']);
  for (const cmd of c.commands) {
    if (!cmd.category) {
      assert.match(cmd.title, /^DevBoost: /, `분류 없는 명령은 제목에 DevBoost 표시: ${cmd.command}`);
      continue;
    }
    assert.ok(allowed.has(cmd.category), `${cmd.command}: ${cmd.category}`);
  }
});

test('화면이 쓰는 media 파일이 실제로 있다 (빌드로 생기는 것은 빼고)', () => {
  const built = new Set(['media/dbConsole/console.js', 'media/dbConsole/results.js', 'media/dbConsole/queryBook/book.js', 'media/sourceAtlas/app.js', 'media/sourceAtlas/app.css']);
  for (const { text, file } of code) {
    for (const m of text.matchAll(/joinPath\([^()]*?extensionUri,\s*((?:'[\w.-]+',?\s*)+)\)/g)) {
      const segs = [...m[1].matchAll(/'([\w.-]+)'/g)].map((x) => x[1]);
      if (segs[0] !== 'media') continue;
      const rel = segs.join('/');
      if (built.has(rel)) continue;
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${file}: ${rel} 이 없음`);
    }
  }
});
