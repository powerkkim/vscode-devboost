// 클래스 색인 (search/classIndex.ts) — rg 로 클래스 선언을 모은다. rg 가 없으면 건너뜀
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, findRg, makeProject, removeProject } = require('../helpers');

const ci = load('classIndex');
const RG = findRg();
const skip = RG ? false : 'ripgrep(rg)을 찾지 못해 건너뜀 — RG_PATH 환경변수로 지정하세요';

let root;
test.before(() => {
  root = makeProject({
    'src/main/java/com/acme/order/OrderService.java': [
      'package com.acme.order;',
      '/**',
      ' * class NotThis — 주석 안',
      ' */',
      '@Service("x") public class OrderService<T> implements Y {',
      '  // class AlsoNot',
      '  String s = "class NorThis";',
      '  public static final class Inner {}',
      '  private enum Status { A }',
      '  @interface MyAnn {}',
      '  record Point(int x) {}',
      '}',
    ].join('\n'),
    'src/main/kotlin/User.kt': 'package com.acme.kt\ndata class User(val id: Long)\nenum class Color { RED }\nobject Single\n',
    'web/src/store.ts': 'export default class Store {}\nexport interface Props { a: string }\nexport enum Mode { A }\n',
    'web/src/c.ts': 'export const enum CE { A }\n',
    'src/main/kotlin/F.kt': 'fun interface Fn { fun f() }\nexpect class Ex\n',
    'src/main/java/N.java': '@Foo(value = @Bar("x")) public class Nested {}\n',
    'src/main/scala/P.scala': 'package object util\nclass AfterPkgObj\n',
    'target/Gen.java': 'public class Generated {}\n',
    'README.md': 'class InDocs\n',
  });
});
test.after(() => removeProject(root));

const names = (idx) => idx.entries().map((e) => `${e.kind}:${e.name}:${e.pkg}:${e.line}`).sort();

test('선언만 모으고 주석·문자열·제외 폴더·다른 파일 형식은 뺀다', { skip }, async () => {
  const idx = new ci.ClassIndex(RG);
  await idx.ensure([root], ['**/target/**']);
  assert.deepEqual(names(idx), [
    'class:AfterPkgObj::1',
    'class:Ex::1',
    'class:Inner:com.acme.order:7',
    'class:Nested::0',
    'class:OrderService:com.acme.order:4',
    'class:Point:com.acme.order:10',
    'class:Single:com.acme.kt:3',
    'class:Store::0',
    'class:User:com.acme.kt:1',
    'enum:CE::0',
    'enum:Color:com.acme.kt:2',
    'enum:Mode::2',
    'enum:Status:com.acme.order:8',
    'interface:Fn::0',
    'interface:MyAnn:com.acme.order:9',
    'interface:Props::1',
  ]);
});

test('파일 저장·삭제 시 그 파일만 갱신 (모았다가 처리)', { skip }, async () => {
  const idx = new ci.ClassIndex(RG);
  await idx.ensure([root], ['**/target/**']);
  const f = path.join(root, 'web/src/store.ts');
  fs.writeFileSync(f, 'export class Store2 {}\n');
  idx.queueUpdate(f);
  await idx.flush();
  assert.ok(idx.entries().some((e) => e.name === 'Store2'));
  assert.ok(!idx.entries().some((e) => e.name === 'Store' || e.name === 'Props'));
  idx.removeFile(path.join(root, 'src/main'));
  assert.ok(!idx.entries().some((e) => e.pkg.startsWith('com.acme')), '폴더 삭제 → 아래 파일 모두 제거');
});

test('저장해도 .gitignore·숨김 폴더·제외 설정의 파일은 색인에 넣지 않음', { skip }, async () => {
  require('child_process').spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), 'gen/\n');
  const files = { 'gen/G.java': 'public class Generated {}', '.next/chunk.js': 'class NextJunk {}', 'target/T.java': 'class InTarget {}', 'src/Ok.java': 'class OkClass {}' };
  const idx = new ci.ClassIndex(RG);
  await idx.ensure([root], ['**/target/**']);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text + '\n');
    idx.queueUpdate(path.join(root, rel));
  }
  await idx.flush();
  const names = idx.entries().map((e) => e.name);
  assert.ok(names.includes('OkClass'));
  for (const n of ['Generated', 'NextJunk', 'InTarget']) assert.ok(!names.includes(n), n);
});

test('폴더 이름 변경(삭제 + 새 폴더 생성) 뒤에도 그 아래 클래스가 남음', { skip }, async () => {
  const idx = new ci.ClassIndex(RG);
  await idx.ensure([root], ['**/target/**']);
  fs.mkdirSync(path.join(root, 'pkg/a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg/a/Moved.java'), 'package pkg.a;\npublic class Moved {}\n');
  idx.queueUpdate(path.join(root, 'pkg/a/Moved.java'));
  await idx.flush();
  fs.renameSync(path.join(root, 'pkg/a'), path.join(root, 'pkg/b'));
  idx.removeFile(path.join(root, 'pkg/a'));
  idx.queueUpdate(path.join(root, 'pkg/b'));
  await idx.flush();
  const e = idx.entries().find((x) => x.name === 'Moved');
  assert.ok(e && e.file.endsWith(path.join('pkg', 'b', 'Moved.java')), JSON.stringify(e));
});

test('변경이 너무 많으면(git checkout 등) 전체를 다시 만듦', { skip }, async () => {
  const idx = new ci.ClassIndex(RG);
  await idx.ensure([root], ['**/target/**']);
  const before = idx.entries().length;
  for (let i = 0; i <= ci.ClassIndex.MAX_BATCH; i++) idx.queueUpdate(path.join(root, `x/F${i}.java`));
  await idx.flush();
  assert.equal(idx.ready, true);
  assert.equal(idx.entries().length, before);
});

test('Java 메서드·필드 (2단계): 선언만 잡고 문장(return foo( 등)·지역 변수는 뺌, 소속 클래스 기록', { skip }, async () => {
  const dir = makeProject({
    'src/main/java/a/Svc.java': [
      'package a;',
      'public class Svc {',
      '  private static final Logger log = LoggerFactory.getLogger(Svc.class);',
      '  private final InfluxDBClient influxDBClient;',
      '  @Bean',
      '  public InfluxDBClient influxDBClient() {',
      '    final int local = 1;',
      '    String s = format(x);',
      '    return create(url);',
      '  }',
      '  <T> List<T> load(Class<T> c) throws IOException {',
      '    if (a) { foo(); } else if (b) { bar(); }',
      '    throw fail("x");',
      '  }',
      '  public Svc(Repo r) {}',
      '}',
    ].join('\n'),
    'src/main/java/a/Mapper.java': 'package a;\npublic interface Mapper {\n  List<Order> findAll(Long id);\n}\n',
    'src/main/kotlin/K.kt': 'package k\nclass K {\n  fun hello(): String = ""\n}\n',
    'web/x.ts': 'export class W {\n  public load(a: string) {}\n}\n',
  });
  try {
    const idx = new ci.ClassIndex(RG);
    await idx.ensure([dir], []);
    assert.equal(idx.membersReady, false, '1단계(클래스)만 끝난 시점');
    assert.ok(idx.classes().some((e) => e.name === 'Svc'));
    for (let i = 0; i < 100 && !idx.membersReady; i++) await new Promise((r) => setTimeout(r, 20));
    const m = idx.members().map((e) => `${e.kind}:${e.container}.${e.name}:${e.line}`).sort();
    assert.deepEqual(m, [
      'field:Svc.influxDBClient:3',
      'field:Svc.log:2',
      'method:K.hello:2',
      'method:Mapper.findAll:2',
      'method:Svc.influxDBClient:5',
      'method:Svc.load:10',
    ]);
    assert.ok(idx.hasSymbol(path.join(dir, 'src/main/java/a/Svc.java'), 'influxDBClient'));
  } finally {
    removeProject(dir);
  }
});

test('저장한 기존 파일은 그 파일만 다시 읽음 (메서드 추가 반영)', { skip }, async () => {
  const dir = makeProject({ 'src/A.java': 'public class A {\n  void one() {}\n}\n' });
  try {
    const idx = new ci.ClassIndex(RG);
    await idx.ensure([dir], []);
    for (let i = 0; i < 100 && !idx.membersReady; i++) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, 'src/A.java'), 'public class A {\n  void one() {}\n  void two() {}\n}\n');
    idx.queueUpdate(path.join(dir, 'src/A.java'));
    await idx.flush();
    assert.deepEqual(idx.members().map((e) => e.name).sort(), ['one', 'two']);
  } finally {
    removeProject(dir);
  }
});

test('수식어 뒤 어노테이션(public @Nullable …)도 메서드·필드로 인식, 점 있는 새 폴더도 색인', { skip }, async () => {
  const dir = makeProject({
    'src/N.java': 'public class N {\n  public @Nullable String foo() { return null; }\n  private @Autowired Repo repo;\n}\n',
  });
  try {
    const idx = new ci.ClassIndex(RG);
    await idx.ensure([dir], []);
    await idx.whenMembersDone();
    assert.deepEqual(idx.members().map((e) => `${e.kind}:${e.name}`).sort(), ['field:repo', 'method:foo']);
    fs.mkdirSync(path.join(dir, 'src/v1.2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/v1.2/B.java'), 'class B {\n  void bee() {}\n}\n');
    idx.queueUpdate(path.join(dir, 'src/v1.2'));
    await idx.flush();
    assert.ok(idx.entries().some((e) => e.name === 'bee' && e.container === 'B'));
    fs.rmSync(path.join(dir, 'src/v1.2'), { recursive: true });
    idx.removeFile(path.join(dir, 'src/v1.2'));
    assert.ok(!idx.entries().some((e) => e.name === 'B'));
  } finally {
    removeProject(dir);
  }
});

test('rg 출력 파싱: Windows 경로의 ":" 와 패키지 순서', () => {
  const out = ['C:\\w\\A.java\u00001:com.a\t\t\t', 'C:\\w\\A.java\u00003:\t\tclass\tFoo', 'C:\\w\\B.kt\u00002:\tclass\t\tColor', ''].join('\n');
  const m = ci.parseClassOutput(out);
  const all = [...m.values()].flat().map((e) => `${e.kind}:${e.name}:${e.pkg}:${e.line}`);
  assert.deepEqual(all, ['class:Foo:com.a:2', 'enum:Color::1']);
});
