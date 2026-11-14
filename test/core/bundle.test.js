// 묶은 확장(dist/extension.js)을 가짜 vscode 로 실제로 켜 본다 — 묶는 과정(따로 묶은 라이브러리, 지연 읽기)에서 생기는 문제를 잡는다.
// (npm test 가 먼저 compile 하면서 dist/ 를 만든다)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVscodeStub, installVscodeStub } = require('../vscodeStub');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));

test('묶은 확장을 켜면 기능이 모두 시작되고, 선언한 명령이 빠짐없이 등록된다', async (t) => {
  const { vscode, state, Uri } = createVscodeStub(ROOT);
  const restore = installVscodeStub(vscode);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'devboost-'));
  const memento = () => ({ get: (_k, d) => d, update: async () => {}, keys: () => [] });
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(ROOT),
    extensionPath: ROOT,
    globalStorageUri: Uri.file(storage),
    storageUri: undefined,
    globalState: memento(),
    workspaceState: memento(),
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
    extension: { packageJSON: pkg },
  };
  const loadedBefore = new Set(Object.keys(require.cache));
  const ext = require(path.join(DIST, 'extension.js'));
  t.after(async () => {
    context.subscriptions.forEach((d) => d.dispose());
    await ext.deactivate();
    restore();
    fs.rmSync(storage, { recursive: true, force: true });
  });

  await ext.activate(context);
  assert.deepStrictEqual(state.errors, [], '시작하지 못한 기능');
  const declared = pkg.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !state.commands.has(c));
  assert.deepStrictEqual(missing, [], '선언했지만 등록되지 않은 명령');

  // 켜기만 했을 때는 무거운 라이브러리 파일을 읽지 않는다
  const libs = () => Object.keys(require.cache).filter((f) => !loadedBefore.has(f) && /[\\/]dist[\\/](libs|drivers)[\\/]/.test(f)).map((f) => path.basename(f));
  assert.deepStrictEqual(libs(), [], '켤 때 읽은 라이브러리');

  // Source Atlas 로 분석하면 그때 분석기 라이브러리를 읽고, 결과가 나온다
  const app = path.join(ROOT, 'test', 'sourceAtlas', 'fixtures', 'app');
  const file = path.join(app, 'src', 'views', 'Basic.vue');
  vscode.window.activeTextEditor = { document: { fileName: file, uri: Uri.file(file) } };
  vscode.workspace.getWorkspaceFolder = () => ({ uri: Uri.file(app) });
  await state.commands.get('devBoost.sourceAtlas.dump')();
  assert.deepStrictEqual(state.errors, []);
  const json = state.output.find((l) => l.trimStart().startsWith('{'));
  assert.ok(json, 'Atlas 분석 결과가 나오지 않음');
  const graph = JSON.parse(json);
  assert.ok(graph.nodes.length > 1 && graph.edges.length > 0, '분석 결과가 비어 있음');
  assert.deepStrictEqual(libs(), ['atlas.js']);
});

test('따로 묶은 라이브러리 파일이 제 모양으로 만들어진다', () => {
  const atlas = require(path.join(DIST, 'libs', 'atlas.js'));
  assert.strictEqual(typeof atlas['@vue/compiler-sfc'].parse, 'function');
  assert.strictEqual(typeof atlas['@babel/parser'].parse, 'function');
  assert.strictEqual(typeof (atlas['@babel/traverse'].default ?? atlas['@babel/traverse']), 'function');
  assert.strictEqual(typeof atlas['@babel/types'].isIdentifier, 'function');
  const oracle = require(path.join(DIST, 'drivers', 'oracle.js'));
  assert.strictEqual(typeof oracle.getConnection, 'function');
  assert.ok(oracle.DB_TYPE_VARCHAR !== undefined);
  // 본체에는 이 라이브러리들이 들어 있지 않다
  const main = fs.readFileSync(path.join(DIST, 'extension.js'), 'utf8');
  assert.ok(main.length < 1_600_000, `본체가 커졌음: ${(main.length / 1024).toFixed(0)}KB`);
  assert.ok(main.includes('./libs/atlas.js') && main.includes('./drivers/oracle.js'));
});
