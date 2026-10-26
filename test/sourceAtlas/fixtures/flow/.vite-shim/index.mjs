// 테스트용 가짜 vite: loadConfigFromFile 만 흉내 낸다.
// 진짜 vite 는 설정 파일을 esbuild 로 번들해 실행하지만, 여기서는 TS 설정을 아주 단순히 변환해서 import 한다.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadConfigFromFile(_env, configFile) {
  let code = readFileSync(configFile, 'utf8');
  code = code.replace(/^import .*from 'vite';?\s*$/m, '').replace(/defineConfig\(/, '(');
  const dir = mkdtempSync(join(tmpdir(), 'vite-shim-'));
  const f = join(dir, 'config.mjs');
  writeFileSync(f, code);
  const mod = await import(pathToFileURL(f).href);
  return { config: mod.default, path: configFile };
}
