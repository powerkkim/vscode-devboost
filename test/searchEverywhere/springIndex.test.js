// Spring 어노테이션 색인 (search/springIndex.ts) — 공통 틀 FileIndex 위
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, findRg, makeProject, removeProject } = require('../helpers');

const sp = load('springIndex');
const RG = findRg();
const skip = RG ? false : 'ripgrep(rg)을 찾지 못해 건너뜀';

test('Spring 어노테이션: 빈 클래스·@Bean·매핑(적힌 그대로), 저장·삭제 갱신', { skip }, async () => {
  const dir = makeProject({
    'src/main/java/a/SearchController.java': [
      'package a;',
      '@RestController',
      '@RequestMapping("/api")',
      'public class SearchController {',
      '  @GetMapping("/search")',
      '  public List<X> search(String q) { return null; }',
      '  // @Service 주석 안은 줄 맨 앞이 아니라 빠짐',
      '}',
    ].join('\n'),
    'src/main/java/a/AppConfig.java': 'package a;\n@Configuration\npublic class AppConfig {\n  @Bean\n  public RestTemplate restTemplate() { return null; }\n}\n',
  });
  try {
    const idx = sp.createSpringIndex(RG);
    await idx.ensure([dir], []);
    const got = idx.entries().map((e) => `${e.kind}:${e.text}:${e.line + 1}`).sort();
    assert.deepEqual(got, [
      'bean-class:@Configuration:2',
      'bean-class:@RestController:2',
      'bean-method:@Bean:4',
      'mapping:@GetMapping("/search"):5',
      'mapping:@RequestMapping("/api"):3',
    ]);
    const f = path.join(dir, 'src/main/java/a/AppConfig.java');
    fs.writeFileSync(f, 'package a;\n@Service\npublic class AppConfig {}\n');
    idx.queueUpdate(f);
    await idx.flush();
    assert.ok(idx.entries().some((e) => e.text === '@Service') && !idx.entries().some((e) => e.text === '@Bean'));
    idx.removeFile(path.join(dir, 'src'));
    assert.equal(idx.entries().length, 0);
  } finally {
    removeProject(dir);
  }
});
