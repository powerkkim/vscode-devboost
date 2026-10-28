// MyBatis mapper 색인 (search/mapperIndex.ts) — 실제 rg 로
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MapperIndex, parseMapperXmlOutput } = require(path.join(__dirname, '..', '..', 'out', 'features', 'searchEverywhere', 'search', 'mapperIndex.js'));
const { rgCwd } = require(path.join(__dirname, '..', '..', 'out', 'features', 'searchEverywhere', 'search', 'ripgrep.js'));

let rg;
try {
  rg = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
} catch {
  rg = undefined;
}

function write(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

test('parseMapperXmlOutput: namespace·DOCTYPE 가 없는 XML 의 select 는 버림', () => {
  const out = [
    'a.xml\u00002:com.x.AMapper\t\t\t', 'a.xml\u00003:\tselect\tfindAll\t',
    'b.xml\u00005:\tselect\tnotMapper\t',
    'c.xml\u00002:\t\t\tmapper', 'c.xml\u00006:\tupdate\tsave\t',
  ].join('\n');
  const e = parseMapperXmlOutput(out);
  assert.deepEqual(e.map((x) => [x.kind, x.name, x.namespace]), [
    ['xml', 'a.xml', 'com.x.AMapper'],
    ['statement', 'findAll', 'com.x.AMapper'],
    ['xml', 'c.xml', ''],
    ['statement', 'save', ''],
  ]);
});

test('MapperIndex: mapper XML·SQL id·@Mapper, 갱신과 삭제, 상위 폴더 이름이 제외 설정과 같아도', { skip: !rg }, async () => {
  // 프로젝트 상위 폴더 이름이 bin (제외 설정과 같음)
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-')), 'bin', 'demo');
  const xml = write(root, 'src/main/resources/mapper/UserMapper.xml',
    '<?xml version="1.0"?>\r\n<mapper namespace="com.demo.UserMapper">\r\n  <select id="selectUser" resultType="map">\r\n  </select>\r\n  <update\r\n    id="multi">\r\n  </update>\r\n  <insert id="insertUser">\r\n  </insert>\r\n</mapper>\r\n');
  write(root, 'pom.xml', '<project><select id="x"/></project>');
  // namespace 가 다음 줄, 작은따옴표 id
  write(root, 'src/main/resources/mapper/CoinMapper.xml', '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">\n<mapper\n  namespace="com.demo.CoinMapper">\n<select id=\'selectCoin\'></select>\n</mapper>\n');
  write(root, 'src/main/java/com/demo/OrderMapper.java', 'package com.demo;\n@Mapper\npublic interface OrderMapper {}\n');
  write(root, 'target/classes/mapper/UserMapper.xml', '<mapper namespace="com.demo.UserMapper"><select id="dup"></select></mapper>');
  const idx = new MapperIndex(rg);
  await idx.ensure([root], ['**/target/**', '**/bin/**']);
  const names = idx.entries().map((e) => `${e.kind}:${e.name}`).sort();
  assert.deepEqual(names, ['statement:insertUser', 'statement:selectCoin', 'statement:selectUser', 'xml:CoinMapper.xml', 'xml:UserMapper.xml']);
  assert.ok(idx.namespaces().has('com.demo.UserMapper'));
  assert.ok(idx.isAnnotated(path.join(root, 'src/main/java/com/demo/OrderMapper.java')));

  fs.writeFileSync(xml, '<mapper namespace="com.demo.UserMapper">\n<delete id="deleteUser"></delete>\n</mapper>\n');
  idx.queueUpdate(xml);
  await idx.flush();
  assert.deepEqual(idx.entries().map((e) => e.name).sort(), ['CoinMapper.xml', 'UserMapper.xml', 'deleteUser', 'selectCoin']);

  idx.removeFile(path.join(root, 'src/main/resources'));
  assert.equal(idx.entries().length, 0);
});

test('rgCwd: 공통 상위 폴더, 파일이면 그 폴더', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  fs.mkdirSync(path.join(base, 'a', 'x'), { recursive: true });
  fs.mkdirSync(path.join(base, 'b'), { recursive: true });
  fs.writeFileSync(path.join(base, 'a', 'f.txt'), '');
  assert.equal(rgCwd([path.join(base, 'a')]), path.join(base, 'a'));
  assert.equal(rgCwd([path.join(base, 'a', 'x'), path.join(base, 'b')]), base);
  assert.equal(rgCwd([path.join(base, 'a', 'f.txt')]), path.join(base, 'a'));
  assert.equal(rgCwd([]), undefined);
});
