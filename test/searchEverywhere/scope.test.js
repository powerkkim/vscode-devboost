// 범위·파일 타입·포함/제외 경로·텍스트 옵션 (search/scope.ts, search/glob.ts)
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers');

const sc = load('scope');
const { GlobMatcher, globToRegExp } = load('glob');

test('globToRegExp: **, *, ?, {a,b}', () => {
  assert.ok(globToRegExp('**/target/**').test('a/b/target/x.class'));
  assert.ok(globToRegExp('**/target/**').test('target/x.class'));
  assert.ok(!globToRegExp('**/target/**').test('src/targets/x'));
  assert.ok(globToRegExp('**/*.min.{js,css}').test('static/a.min.css'));
  assert.ok(globToRegExp('src/?.java').test('src/A.java'));
});

test('GlobMatcher: Windows 경로와 대소문자 무시', () => {
  const m = new GlobMatcher(['**/vendor/**', '**/*.min.js']);
  assert.ok(m.matches('src\\main\\resources\\static\\vendor\\fontawesome\\all.css'));
  assert.ok(m.matches('web/APP.MIN.JS'));
  assert.ok(!m.matches('src/main/java/com/vendorx/Foo.java'));
});

test('isTestPath: Maven/Gradle, JS, 파일명 규칙', () => {
  for (const p of [
    'src/test/java/com/demo/FooTest.java',
    'src\\test\\java\\Foo.java',
    'src/main/java/com/demo/FooTest.java',
    'src/main/java/com/demo/FooIT.java',
    'web/src/components/Button.spec.ts',
    'web/__tests__/x.js',
  ]) {
    assert.ok(sc.isTestPath(p), p);
  }
  for (const p of ['src/main/java/com/demo/Foo.java', 'src/main/java/com/demo/Latest.java', 'src/main/resources/testdata.sql']) {
    assert.ok(!sc.isTestPath(p), p);
  }
});

test('scopeAccepts: 범위별 판정', () => {
  const f = (relPath, o = {}) => ({ relPath, inProject: true, isLibrary: false, recentlyViewed: false, recentlyChanged: false, ...o });
  assert.ok(sc.scopeAccepts('project', f('src/main/A.java')));
  assert.ok(!sc.scopeAccepts('project', f('static/vendor/x.js', { isLibrary: true })));
  assert.ok(sc.scopeAccepts('projectAndLibs', f('jdt://x', { inProject: false, isLibrary: true })));
  assert.ok(!sc.scopeAccepts('production', f('src/test/A.java')));
  assert.ok(sc.scopeAccepts('test', f('src/test/A.java')));
  assert.ok(!sc.scopeAccepts('test', f('src/main/A.java')));
  assert.ok(sc.scopeAccepts('recentViewed', f('a', { recentlyViewed: true })));
  assert.ok(!sc.scopeAccepts('recentChanged', f('a')));
});

test('fileMaskToGlobs: 쉼표로 여러 패턴, 중간 * 허용', () => {
  assert.deepEqual(sc.fileMaskToGlobs('*.java, *mapper*.xml, *.vue'), ['**/*.java', '**/*mapper*.xml', '**/*.vue']);
  assert.deepEqual(sc.fileMaskToGlobs('java'), ['**/*.java']);
  assert.deepEqual(sc.fileMaskToGlobs('pom.xml'), ['**/pom.xml']);
  assert.deepEqual(sc.fileMaskToGlobs(''), []);
});

test('pathEntryToGlobs: Ctrl+Shift+F 의 files to include 규칙', () => {
  assert.deepEqual(sc.pathEntryToGlobs('src/main/java/com/demo'), ['**/src/main/java/com/demo', '**/src/main/java/com/demo/**']);
  assert.deepEqual(sc.pathEntryToGlobs('./src'), ['src', 'src/**']);
  assert.deepEqual(sc.pathEntryToGlobs('src\\main\\'), ['**/src/main', '**/src/main/**']);
  assert.deepEqual(sc.pathEntryToGlobs('*Test.java'), ['**/*Test.java']);
  assert.deepEqual(sc.pathEntryToGlobs('**/dto/**'), ['**/dto/**']);
  assert.deepEqual(sc.splitPathList('a, **/{x,y}/** ,  ,b'), ['a', '**/{x,y}/**', 'b']);
});

test('포함/제외 경로 매칭', () => {
  const inc = new GlobMatcher(sc.pathListToGlobs('module/order'));
  assert.ok(inc.matches('src/main/java/com/demo/module/order/OrderService.java'));
  assert.ok(inc.matches('src/main/java/com/demo/module/order/dto/OrderDto.java'));
  assert.ok(!inc.matches('src/main/java/com/demo/module/common/CommonUtil.java'));
  assert.ok(!inc.matches('src/main/java/com/demo/module/orderx/A.java'), '폴더명 앞부분만 같은 경우는 제외');

  const exc = new GlobMatcher(sc.pathListToGlobs('**/dto/**, *Util.java'));
  assert.ok(exc.matches('src/main/java/com/demo/module/order/dto/OrderDto.java'));
  assert.ok(exc.matches('src/main/java/com/demo/module/common/CommonUtil.java'));
  assert.ok(!exc.matches('src/main/java/com/demo/module/order/OrderService.java'));

  const rooted = new GlobMatcher(sc.pathListToGlobs('./src/test'));
  assert.ok(rooted.matches('src/test/java/A.java'));
  assert.ok(!rooted.matches('sub/src/test/java/A.java'));

  assert.ok(sc.hasPathFilter({ include: ' x', exclude: '' }));
  assert.ok(!sc.hasPathFilter({ include: ' ', exclude: '' }));
});

test('buildTextRegExp: 예비 검색용 정규식 (Cc / W / .*)', () => {
  assert.ok(sc.buildTextRegExp('run(', { regex: false, caseSensitive: false, wholeWord: false }).test('x.run(1)'));
  const word = sc.buildTextRegExp('Args', { regex: false, caseSensitive: true, wholeWord: true });
  assert.ok(!word.test('ApplicationArgs'));
  word.lastIndex = 0;
  assert.ok(word.test('a Args b'));
  word.lastIndex = 0;
  assert.ok(!word.test('a args b'));
  assert.ok(sc.buildTextRegExp('run\\(\\w+', { regex: true, caseSensitive: false, wholeWord: false }).test('run(Application'));
  assert.equal(sc.buildTextRegExp('(', { regex: true, caseSensitive: false, wholeWord: false }), null);
});
