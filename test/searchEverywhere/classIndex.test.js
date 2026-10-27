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
    'class:Inner:com.acme.order:7',
    'class:OrderService:com.acme.order:4',
    'class:Point:com.acme.order:10',
    'class:Single:com.acme.kt:3',
    'class:Store::0',
    'class:User:com.acme.kt:1',
    'enum:Color:com.acme.kt:2',
    'enum:Mode::2',
    'enum:Status:com.acme.order:8',
    'interface:MyAnn:com.acme.order:9',
    'interface:Props::1',
  ]);
});

test('파일 저장·삭제 시 그 파일만 갱신', { skip }, async () => {
  const idx = new ci.ClassIndex(RG);
  await idx.ensure([root], ['**/target/**']);
  const f = path.join(root, 'web/src/store.ts');
  fs.writeFileSync(f, 'export class Store2 {}\n');
  await idx.updateFile(f, ['**/target/**']);
  assert.ok(idx.entries().some((e) => e.name === 'Store2'));
  assert.ok(!idx.entries().some((e) => e.name === 'Store' || e.name === 'Props'));
  idx.removeFile(path.join(root, 'src/main'));
  assert.ok(!idx.entries().some((e) => e.pkg.startsWith('com.acme')), '폴더 삭제 → 아래 파일 모두 제거');
});

test('rg 출력 파싱: Windows 경로의 ":" 와 패키지 순서', () => {
  const out = ['C:\\w\\A.java\u00001:com.a\t\t\t', 'C:\\w\\A.java\u00003:\t\tclass\tFoo', 'C:\\w\\B.kt\u00002:\tclass\t\tColor', ''].join('\n');
  const m = ci.parseClassOutput(out);
  const all = [...m.values()].flat().map((e) => `${e.kind}:${e.name}:${e.pkg}:${e.line}`);
  assert.deepEqual(all, ['class:Foo:com.a:2', 'enum:Color::1']);
});
