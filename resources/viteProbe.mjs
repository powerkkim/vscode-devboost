// Source Atlas 가 자식 프로세스로 실행하는 Vite 설정 탐색 스크립트.
//   node viteProbe.mjs <projectRoot> <configFile> <viteEntry>
// 프로젝트가 가진 Vite 로 설정 파일을 "실제로 실행"해서 alias · server.proxy · base 를 JSON 으로 stdout 에 낸다.
// 확장 프로세스 안에서 프로젝트 코드를 실행하지 않기 위해 따로 띄운다. 실패하면 비정상 종료 → 확장은 정적 해석으로 폴백.
import { pathToFileURL } from 'node:url';

const [root, configFile, viteEntry] = process.argv.slice(2);
const imported = await import(pathToFileURL(viteEntry).href);
const vite = imported.loadConfigFromFile ? imported : (imported.default ?? imported); // vite 2 (CJS main) 대비
const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, root, 'silent');
const cfg = (loaded && loaded.config) || {};

const aliases = [];
const rawAlias = cfg.resolve && cfg.resolve.alias;
if (Array.isArray(rawAlias)) {
  for (const a of rawAlias) {
    if (!a || typeof a.replacement !== 'string') continue;
    if (typeof a.find === 'string') aliases.push({ find: a.find, replacement: a.replacement });
    else if (a.find instanceof RegExp) aliases.push({ find: a.find.source, regex: true, replacement: a.replacement });
  }
} else if (rawAlias && typeof rawAlias === 'object') {
  for (const [find, replacement] of Object.entries(rawAlias)) {
    if (typeof replacement === 'string') aliases.push({ find, replacement });
  }
}

const proxies = [];
const rawProxy = cfg.server && cfg.server.proxy;
if (rawProxy && typeof rawProxy === 'object') {
  for (const [prefix, rule] of Object.entries(rawProxy)) {
    let target = typeof rule === 'string' ? rule : rule && typeof rule.target === 'string' ? rule.target : '';
    if (!target && rule && rule.target && typeof rule.target === 'object') {
      const t = rule.target; // { protocol, host, port } 형태
      target = `${(t.protocol || 'http:').replace(/:?$/, ':')}//${t.host || 'localhost'}${t.port ? ':' + t.port : ''}`;
    }
    let rewritten = prefix;
    if (rule && typeof rule.rewrite === 'function') {
      // rewrite 는 함수라 그대로 보낼 수 없다 → 표본 경로를 넣어 접두어가 어떻게 바뀌는지 알아낸다
      try {
        const out = rule.rewrite(prefix + '/__devboost_probe__');
        if (typeof out === 'string' && out.endsWith('/__devboost_probe__')) rewritten = out.slice(0, -'/__devboost_probe__'.length);
      } catch { /* 표본으로 알 수 없으면 접두어 유지 */ }
    }
    proxies.push({ prefix, target, rewritten });
  }
}

// 플러그인 로그와 섞이지 않게 마커를 붙여 마지막 줄에 쓴다
process.stdout.write('\n__DEVBOOST_VITE__' + JSON.stringify({ base: typeof cfg.base === 'string' ? cfg.base : '/', aliases, proxies }) + '\n');
