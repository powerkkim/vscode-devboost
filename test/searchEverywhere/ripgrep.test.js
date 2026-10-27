// ripgrep 실행·파싱과 옵션 조합 (search/ripgrep.ts + scope.ts)
// rg를 찾지 못하면 이 파일의 테스트는 건너뛴다 (RG_PATH 환경변수로 지정 가능)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { load, findRg, makeProject, removeProject, rel, SAMPLE_PROJECT } = require('../helpers');

const rg = load('ripgrep');
const sc = load('scope');
const { GlobMatcher } = load('glob');

const RG = findRg();
const skip = RG ? false : 'ripgrep(rg)을 찾지 못해 건너뜀 — RG_PATH 환경변수로 지정하세요';
const EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/target/**'];

let root;
test.before(() => {
  root = makeProject({ ...SAMPLE_PROJECT, 'ignored/c.txt': 'ApplicationArguments ignored\n', '.gitignore': 'ignored/\n' });
  // .gitignore 반영은 git 저장소 안에서만 동작
  spawnSync('git', ['init', '-q'], { cwd: root });
});
test.after(() => removeProject(root));

const run = (o) => rg.runRipgrep(RG, { query: 'ApplicationArguments', roots: [root], limit: 300, ...o });
const files = (matches) => [...new Set(matches.map((m) => rel(root, m.file)))].sort();

test('splitGlobs: 중괄호 안의 쉼표는 나누지 않음', () => {
  assert.deepEqual(rg.splitGlobs('**/{node_modules,.git}/**'), ['**/{node_modules,.git}/**']);
  assert.deepEqual(rg.splitGlobs('**/a/**, **/*.min.js'), ['**/a/**', '**/*.min.js']);
});

test('parseJsonLine: 한글 줄에서 바이트 → 문자 위치 변환', () => {
  const text = '// 한글 주석 ApplicationArguments 위치\n';
  const start = Buffer.byteLength('// 한글 주석 ');
  const line = JSON.stringify({
    type: 'match',
    data: { path: { text: '/a.java' }, lines: { text }, line_number: 3, submatches: [{ start, end: start + 20 }] },
  });
  const [m] = rg.parseJsonLine(line);
  assert.equal(m.line, 2);
  assert.equal(m.text.substr(m.column, m.length), 'ApplicationArguments');
});

test('기본 검색: exclude 와 .gitignore 반영', { skip }, async () => {
  const f = files(await run({ excludeGlobs: EXCLUDE }));
  assert.ok(f.includes('src/main/java/com/demo/DemoApplication.java'));
  assert.ok(!f.some((p) => p.startsWith('node_modules') || p.startsWith('target')), f.join());
  assert.ok(!f.some((p) => p.startsWith('ignored')), '.gitignore');
});

test('limit 과 중단(isStale)', { skip }, async () => {
  assert.equal((await run({ limit: 3 })).length, 3);
  assert.equal((await run({ isStale: () => true })).length, 0);
});

test('특수문자는 그대로(fixed strings), 잘못된 정규식은 오류', { skip }, async () => {
  const m = await rg.runRipgrep(RG, { query: 'run(Application', roots: [root], excludeGlobs: EXCLUDE, limit: 10 });
  assert.equal(m.length, 2);
  await assert.rejects(rg.runRipgrep(RG, { query: '(', roots: [root], regex: true, limit: 10 }));
});

test('Cc / W / .*', { skip }, async () => {
  const caseFile = [path.join(root, 'src/main/resources/case.txt')];
  assert.equal((await run({ roots: caseFile, caseSensitive: true })).length, 2);
  assert.equal((await run({ roots: caseFile, caseSensitive: true, wholeWord: true })).length, 1);
  assert.equal((await run({ roots: caseFile, query: 'Application\\w+ (lower|Upper)', regex: true })).length, 2);
});

test('파일 타입: *.java, *mapper*.xml, *.vue, *.ts (대소문자 무시)', { skip }, async () => {
  const f = files(await run({ excludeGlobs: EXCLUDE, includeGlobs: sc.fileMaskToGlobs('*.java, *mapper*.xml, *.vue, *.ts') }));
  assert.ok(f.includes('src/main/resources/mapper/OrderMapper.xml'), 'OrderMapper.xml (대문자 M)');
  assert.ok(!f.includes('src/main/resources/applicationContext.xml'), 'mapper 아닌 xml');
  assert.ok(f.includes('web/src/components/Order.vue') && f.includes('web/src/api.ts'));
  assert.ok(!f.some((p) => p.endsWith('.txt')));
});

test('포함 폴더를 시작 경로로 + 하위 폴더에서도 제외 패턴 동작', { skip }, async () => {
  const orderDir = path.join(root, 'src/main/java/com/demo/module/order');
  assert.deepEqual(files(await run({ roots: [orderDir] })), [
    'src/main/java/com/demo/module/order/OrderService.java',
    'src/main/java/com/demo/module/order/dto/OrderDto.java',
  ]);
  const noDto = await run({ roots: [orderDir], excludeGlobs: sc.pathListToGlobs('**/dto/**') });
  assert.deepEqual(files(noDto), ['src/main/java/com/demo/module/order/OrderService.java']);
});

test('범위: 프로덕션(테스트 제외) / 테스트 + 파일 타입은 AND', { skip }, async () => {
  const prod = files(await run({ excludeGlobs: [...EXCLUDE, ...sc.TEST_GLOBS], includeGlobs: ['**/*.java'] }));
  assert.ok(!prod.some((p) => p.includes('src/test/')));

  // 파일 타입은 rg에, 테스트 범위는 결과에서 거른다 (rg 양 조건끼리는 OR라서)
  const javaOnly = await run({ excludeGlobs: EXCLUDE, includeGlobs: sc.fileMaskToGlobs('*.java'), limit: 1000 });
  const testOnly = new GlobMatcher(sc.TEST_GLOBS);
  const and = javaOnly.filter((m) => testOnly.matches(rel(root, m.file)));
  assert.deepEqual(files(and), ['src/test/java/com/demo/DemoApplicationTest.java']);
});

test('파일 목록을 직접 넘기기 (최근 본/변경 파일 범위)', { skip }, async () => {
  const list = ['src/main/resources/case.txt', 'src/main/java/com/demo/DemoApplication.java'].map((p) => path.join(root, p));
  assert.equal(files(await run({ roots: list })).length, 2);
});

test('listFiles: 개수 제한 없이 .gitignore 반영, 숨김 파일 포함, .git·제외 폴더 빼기', { skip }, async () => {
  require('fs').writeFileSync(path.join(root, '.env'), 'A=1\n');
  const all = (await rg.listFiles(RG, [root], ['**/target/**'])).map((f) => rel(root, f));
  assert.ok(all.includes('src/main/java/com/demo/DemoApplication.java'));
  assert.ok(all.includes('.env'), '숨김 파일');
  assert.ok(!all.some((p) => p.startsWith('.git/')), '.git 폴더');
  assert.ok(!all.some((p) => p.startsWith('target/')), '제외 설정');
  assert.ok(!all.some((p) => p.startsWith('ignored/')), '.gitignore');
});
