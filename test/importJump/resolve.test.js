// import 따라가기: import 읽기 · 별칭 풀기 · export 찾기. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const R = require(path.join(__dirname, '..', '..', 'out', 'features', 'importJump', 'resolve.js'));

/** 메모리 파일 */
function mem(map) {
  const dirs = new Set();
  for (const f of Object.keys(map)) {
    let d = R.dirname(f);
    while (d && d !== '/' && !dirs.has(d)) {
      dirs.add(d);
      d = R.dirname(d);
    }
  }
  return { read: (p) => map[p], exists: (p) => p in map || dirs.has(p), isDirectory: (p) => dirs.has(p) };
}
const resolverOf = (files, aliases, root) => ({
  module: (spec, from) => {
    const base = /^\.{1,2}(\/|$)/.test(spec) ? R.joinPath(R.dirname(from), spec) : R.applyAlias(spec, aliases, root);
    return base === undefined ? undefined : R.resolveFile(base, files);
  },
});
/** 찾은 자리의 글 */
const at = (files, t) => files.read(t.file).slice(t.start, t.end);
const decl = (files, t) => files.read(t.file).slice(t.declStart, t.declEnd);

test('import 문 읽기: 이름·별명·기본·통째·type·여러 줄, 주석 안은 무시', () => {
  const text = [
    "import { ref, computed as c } from 'vue'",
    "import type { UserType, RoleType } from '@/types/user'",
    "import api, { type ApiOptions } from '@/api'",
    "import * as utils from '~/utils'",
    'import {',
    '  fetchUser,',
    '  saveUser, // 저장',
    "} from '@/api/user';",
    "// import { Nope } from '@/nope'",
    "import './style.css'",
  ].join('\n');
  const got = R.parseImports(text);
  assert.deepStrictEqual(
    got.map((s) => [s.module, s.bindings.map((b) => (b.local === b.imported ? b.local : `${b.imported}→${b.local}`)).join(',')]),
    [
      ['vue', 'ref,computed→c'],
      ['@/types/user', 'UserType,RoleType'],
      ['@/api', 'default→api,ApiOptions'],
      ['~/utils', '*→utils'],
      ['@/api/user', 'fetchUser,saveUser'],
    ]
  );
  assert.strictEqual(text.slice(got[1].moduleStart, got[1].moduleEnd), '@/types/user');
  assert.ok(text.slice(got[4].start, got[4].end).startsWith('import {\n  fetchUser'));
});

test('Vue 파일: <script setup> 안의 import 도 읽는다', () => {
  const got = R.parseImports("<template><UserCard :user=\"u\" /></template>\n<script setup lang=\"ts\">import UserCard from '@/components/UserCard.vue'\nimport type { UserType } from '@/types/user'\n</script>");
  assert.deepStrictEqual(got.map((s) => s.module), ['@/components/UserCard.vue', '@/types/user']);
});

test('vite.config 의 별칭 읽기 (흔한 모양들)', () => {
  assert.deepStrictEqual(
    R.parseViteAliases("export default defineConfig({\n  resolve: {\n    alias: {\n      '@': fileURLToPath(new URL('./src', import.meta.url)),\n      '~': path.resolve(__dirname, 'src/assets'),\n      comp: resolve(__dirname, './src/components'), // 컴포넌트\n      '#': '/types',\n    },\n  },\n})"),
    { '@': './src', '~': 'src/assets', comp: './src/components', '#': './types' }
  );
  assert.deepStrictEqual(
    R.parseViteAliases("resolve: { alias: [{ find: '@', replacement: path.resolve(__dirname, 'src') }, { find: '@img', replacement: resolve(__dirname, './src/img') }] }"),
    { '@': 'src', '@img': './src/img' }
  );
  assert.deepStrictEqual(R.parseViteAliases('export default defineConfig({ plugins: [vue()] })'), {});
});

test('tsconfig paths 읽기', () => {
  assert.deepStrictEqual(R.parseTsconfigAliases('{ // 주석\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "#types": ["./types/index.ts"], } } }'), {
    '@': './src',
    '#types': './types/index.ts',
  });
  assert.deepStrictEqual(R.parseTsconfigAliases('{'), {});
});

test('별칭 풀기: 긴 것부터, 별칭이 아니면 undefined', () => {
  const a = { '@': 'src', '@img': 'src/assets/img' };
  assert.strictEqual(R.applyAlias('@/types/user', a, '/p'), '/p/src/types/user');
  assert.strictEqual(R.applyAlias('@img/a.png', a, '/p'), '/p/src/assets/img/a.png');
  assert.strictEqual(R.applyAlias('@', a, '/p'), '/p/src');
  assert.strictEqual(R.applyAlias('@vue/shared', a, '/p'), undefined);
  assert.strictEqual(R.applyAlias('vue', a, '/p'), undefined);
  assert.strictEqual(R.joinPath('C:/work/p', '../q/./r'), 'C:/work/q/r');
});

test('파일 찾기: 확장자·index·.js 로 적은 .ts', () => {
  const files = mem({ '/p/src/types/user.ts': '', '/p/src/api/index.ts': '', '/p/src/c/UserCard.vue': '', '/p/src/u.d.ts': '' });
  assert.strictEqual(R.resolveFile('/p/src/types/user', files), '/p/src/types/user.ts');
  assert.strictEqual(R.resolveFile('/p/src/types/user.js', files), '/p/src/types/user.ts');
  assert.strictEqual(R.resolveFile('/p/src/api', files), '/p/src/api/index.ts');
  assert.strictEqual(R.resolveFile('/p/src/c/UserCard.vue', files), '/p/src/c/UserCard.vue');
  assert.strictEqual(R.resolveFile('/p/src/u', files), '/p/src/u.d.ts');
  assert.strictEqual(R.resolveFile('/p/src/none', files), undefined);
});

test('export 찾기: 선언 종류별 이름 위치와 본문 범위', () => {
  const src = [
    '// export interface UserType { no: 1 }',
    'export interface UserType {',
    '  id: string;',
    '  role: { code: string };',
    '}',
    "export type RoleType = 'ADMIN' | 'USER';",
    'export type Long =',
    "  | 'A'",
    "  | 'B'",
    'export const MAX_USERS = 10',
    'export const COLS = [',
    "  { key: 'id' },",
    '] as const;',
    'export async function fetchUser(id: string): Promise<UserType> {',
    "  return api.get('/user/' + id);",
    '}',
    'export enum Status { ON, OFF }',
    'export default class UserService {}',
  ].join('\n');
  const files = mem({ '/p/src/types/user.ts': src });
  const rs = resolverOf(files, {}, '/p');
  const find = (n) => R.findExport('/p/src/types/user.ts', n, files, rs);
  assert.strictEqual(at(files, find('UserType')), 'UserType');
  assert.strictEqual(decl(files, find('UserType')), 'export interface UserType {\n  id: string;\n  role: { code: string };\n}');
  assert.strictEqual(decl(files, find('RoleType')), "export type RoleType = 'ADMIN' | 'USER';");
  assert.strictEqual(decl(files, find('Long')), "export type Long =\n  | 'A'\n  | 'B'");
  assert.strictEqual(decl(files, find('MAX_USERS')), 'export const MAX_USERS = 10');
  assert.strictEqual(decl(files, find('COLS')), "export const COLS = [\n  { key: 'id' },\n] as const;");
  assert.strictEqual(decl(files, find('fetchUser')), "export async function fetchUser(id: string): Promise<UserType> {\n  return api.get('/user/' + id);\n}");
  assert.strictEqual(at(files, find('Status')), 'Status');
  assert.strictEqual(at(files, find('default')), 'UserService');
  // 없는 이름: 파일은 맞으므로 맨 위
  assert.deepStrictEqual(find('Nope'), { file: '/p/src/types/user.ts', start: 0, end: 0, declStart: 0, declEnd: 0 });
});

test('export 찾기: export { } · 다시 내보내기(index.ts) · export * · export default 이름 · .vue', () => {
  const files = mem({
    '/p/src/types/index.ts': "export * from './user'\nexport { RoleCode as Role } from '@/types/role'\nexport * as codes from './codes'\n",
    '/p/src/types/user.ts': 'interface UserType { id: string }\nconst helper = 1;\nexport { UserType, helper as userHelper };\n',
    '/p/src/types/role.ts': "export type RoleCode = 'A' | 'B';\n",
    '/p/src/types/codes.ts': 'export const X = 1;\n',
    '/p/src/api/index.ts': 'const api = { get() {} };\nexport default api;\n',
    '/p/src/c/UserCard.vue': '<template><div/></template>\n<script lang="ts">\nexport interface CardProps { id: string }\n</script>\n<script setup lang="ts">\nconst x = 1\n</script>',
  });
  const rs = resolverOf(files, { '@': 'src' }, '/p');
  const idx = '/p/src/types/index.ts';
  let t = R.findExport(idx, 'UserType', files, rs);
  assert.deepStrictEqual([t.file, at(files, t), decl(files, t)], ['/p/src/types/user.ts', 'UserType', 'interface UserType { id: string }']);
  t = R.findExport(idx, 'userHelper', files, rs);
  assert.deepStrictEqual([t.file, at(files, t)], ['/p/src/types/user.ts', 'helper']);
  t = R.findExport(idx, 'Role', files, rs);
  assert.deepStrictEqual([t.file, at(files, t)], ['/p/src/types/role.ts', 'RoleCode']);
  assert.strictEqual(R.findExport(idx, 'codes', files, rs).file, '/p/src/types/codes.ts');
  t = R.findExport('/p/src/api/index.ts', 'default', files, rs);
  assert.deepStrictEqual([at(files, t), decl(files, t)], ['api', 'const api = { get() {} };']);
  assert.strictEqual(R.findExport('/p/src/c/UserCard.vue', 'default', files, rs).start, 0);
  t = R.findExport('/p/src/c/UserCard.vue', 'CardProps', files, rs);
  assert.strictEqual(at(files, t), 'CardProps');
  // 서로를 다시 내보내도 멈춘다
  const loop = mem({ '/a.ts': "export * from './b'", '/b.ts': "export * from './a'" });
  assert.deepStrictEqual(R.findExport('/a.ts', 'X', loop, resolverOf(loop, {}, '/')), { file: '/a.ts', start: 0, end: 0, declStart: 0, declEnd: 0 });
});

test('누른 자리 판단: 쓰는 곳 · import 줄의 이름 · 경로 글 · 템플릿 태그', () => {
  const text = [
    '<template>',
    '  <UserCard :user="user" /><user-card /><div>{{ total - used }}</div>',
    '</template>',
    '<script setup lang="ts">',
    "import UserCard from '@/components/UserCard.vue'",
    "import { fetchUser as load, type UserType } from '@/api/user'",
    'const user = ref<UserType>()',
    'const used = obj.load + load(1)',
    '</script>',
  ].join('\n');
  const imports = R.parseImports(text);
  const hit = (needle, nth = 0, delta = 1) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
    const h = R.hitAt(text, i + delta, imports);
    return h && [h.statement.module, h.binding ? `${h.binding.imported}→${h.binding.local}` : '(파일)', text.slice(h.start, h.end)];
  };
  assert.deepStrictEqual(hit('UserType', 1), ['@/api/user', 'UserType→UserType', 'UserType']); // 쓰는 곳
  assert.deepStrictEqual(hit('UserType', 0), ['@/api/user', 'UserType→UserType', 'UserType']); // import 줄
  assert.deepStrictEqual(hit('fetchUser'), ['@/api/user', 'fetchUser→load', 'fetchUser']); // as 앞의 원래 이름
  assert.deepStrictEqual(hit('load(1)'), ['@/api/user', 'fetchUser→load', 'load']);
  assert.strictEqual(hit('obj.load', 0, 5), undefined); // obj.load 의 load 는 다른 것
  assert.deepStrictEqual(hit('@/api/user', 0, 3), ['@/api/user', '(파일)', '@/api/user']);
  assert.deepStrictEqual(hit('<UserCard', 0, 3), ['@/components/UserCard.vue', 'default→UserCard', 'UserCard']);
  assert.deepStrictEqual(hit('<user-card', 0, 3), ['@/components/UserCard.vue', 'default→UserCard', 'user-card']);
  assert.strictEqual(hit('total - used', 0, 9), undefined); // used 는 가져온 이름이 아님 (그리고 빼기는 한 낱말이 아님)
  assert.strictEqual(hit('ref<'), undefined);
});
