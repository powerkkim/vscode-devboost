// 테스트 공통 도구. vscode 모듈 없이 Node만으로 도는 순수 로직(out/…/search/*)을 테스트한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'out', 'features', 'searchEverywhere', 'search');

/** 컴파일된 모듈 불러오기 (npm test 가 먼저 compile 한다) */
function load(name) {
  return require(path.join(OUT, `${name}.js`));
}

/**
 * ripgrep 실행 파일 찾기
 *  1) 환경변수 RG_PATH  2) PATH 의 rg  3) VS Code 설치 폴더 안의 rg
 * 없으면 undefined → ripgrep 테스트는 건너뛴다
 */
function findRg() {
  if (process.env.RG_PATH && fs.existsSync(process.env.RG_PATH)) {
    return process.env.RG_PATH;
  }
  const onPath = spawnSync('rg', ['--version'], { encoding: 'utf8' });
  if (onPath.status === 0) {
    return 'rg';
  }
  const { findRipgrep } = load('ripgrep');
  const appRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app'),
    'C:\\Program Files\\Microsoft VS Code\\resources\\app',
    '/usr/share/code/resources/app',
    '/Applications/Visual Studio Code.app/Contents/Resources/app',
  ].filter(Boolean);
  for (const root of appRoots) {
    const p = findRipgrep(root);
    if (p) return p;
  }
  return undefined;
}

/**
 * 임시 폴더에 작은 Spring + Vue 프로젝트를 만든다.
 * files: { '상대경로': '내용' }
 */
function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devboost-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

function removeProject(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** 결과 파일 경로를 root 기준 '/' 상대 경로로 */
function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

const SAMPLE_PROJECT = {
  'src/main/java/com/demo/DemoApplication.java': [
    'package com.demo;',
    'import org.springframework.boot.ApplicationArguments;',
    '// 한글 주석 ApplicationArguments 위치 테스트',
    'public class DemoApplication {',
    '  public void run(ApplicationArguments args) throws Exception {}',
    '}',
    '',
  ].join('\n'),
  'src/main/java/com/demo/module/order/OrderService.java': 'class OrderService { ApplicationArguments a; }\n',
  'src/main/java/com/demo/module/order/dto/OrderDto.java': 'class OrderDto { ApplicationArguments a; }\n',
  'src/main/java/com/demo/module/common/CommonUtil.java': 'class CommonUtil { ApplicationArguments a; }\n',
  'src/test/java/com/demo/DemoApplicationTest.java': 'class DemoApplicationTest { void run(ApplicationArguments a) {} }\n',
  'src/main/resources/mapper/OrderMapper.xml': '<mapper>ApplicationArguments</mapper>\n',
  'src/main/resources/applicationContext.xml': '<beans>ApplicationArguments</beans>\n',
  'src/main/resources/case.txt': 'applicationarguments lower\nApplicationArguments Upper\nxApplicationArgumentsx inside\n',
  'src/main/resources/static/vendor/bootstrap/bootstrap.js': 'function commonOffsetParent(){ /* ApplicationArguments */ }\n',
  'web/src/components/Order.vue': '<template>ApplicationArguments</template>\n',
  'web/src/api.ts': 'export const ApplicationArguments = 1\n',
  'node_modules/x/a.js': 'ApplicationArguments in node_modules\n',
  'target/b.txt': 'ApplicationArguments in target\n',
};

module.exports = { load, findRg, makeProject, removeProject, rel, SAMPLE_PROJECT };
