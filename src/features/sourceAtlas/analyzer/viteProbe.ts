/**
 * 프로젝트의 Vite 로 설정을 실제로 읽는다 (alias · server.proxy · base).
 * 정규식으로 vite.config 를 긁는 대신, 그 프로젝트의 vite 가 설정 파일을 실행한 결과를 받는다.
 * 프로젝트 코드를 실행하는 일이므로 확장 프로세스가 아니라 자식 node 프로세스에서 한다 (resources/viteProbe.mjs).
 * node 나 vite 가 없거나 실패하면 null → 호출 쪽은 정적 해석으로 폴백.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface ViteAlias {
  find: string;
  regex?: boolean;
  replacement: string;
}
export interface ViteProxy {
  /** 프론트가 부르는 접두어: '/api' */
  prefix: string;
  /** 'http://localhost:8080' */
  target: string;
  /** rewrite 를 거친 뒤의 접두어 ('' 이면 접두어 제거) */
  rewritten: string;
}
export interface ViteInfo {
  configFile: string;
  base: string;
  aliases: ViteAlias[];
  proxies: ViteProxy[];
}

export interface ProbeOptions {
  /** 테스트용: vite 진입 파일을 직접 지정 */
  viteEntry?: string;
  /** 테스트용: 프로브 스크립트 위치 */
  script?: string;
  timeoutMs?: number;
}

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs'];

const cache = new Map<string, { mtime: number; info: ViteInfo | null }>();
export function clearViteProbeCache() {
  cache.clear();
}

export function findViteConfig(projectDir: string): string | null {
  for (const n of CONFIG_NAMES) {
    const f = path.join(projectDir, n);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** node_modules/vite 의 ESM 진입 파일 (projectDir 에서 위로 올라가며 찾는다) */
export function findViteEntry(projectDir: string): string | null {
  let dir = projectDir;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'node_modules', 'vite', 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        const exp = j.exports?.['.'];
        const rel: string | undefined =
          typeof exp === 'string' ? exp
          : exp?.import?.default ?? exp?.import ?? exp?.default ?? j.module ?? j.main;
        if (rel) return path.join(dir, 'node_modules', 'vite', rel);
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function findScript(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', 'resources', 'viteProbe.mjs'), // dist/extension.js 기준
    path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'viteProbe.mjs'), // out/features/sourceAtlas/analyzer 기준
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function probeVite(projectDir: string, opts: ProbeOptions = {}): ViteInfo | null {
  const configFile = findViteConfig(projectDir);
  if (!configFile) return null;
  let mtime = 0;
  try {
    mtime = fs.statSync(configFile).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(configFile);
  if (hit && hit.mtime === mtime) return hit.info;

  let info: ViteInfo | null = null;
  const entry = opts.viteEntry ?? findViteEntry(projectDir);
  const script = opts.script ?? findScript();
  if (entry && script) {
    // PATH 의 node 를 먼저, 없으면(ENOENT) VS Code 자신의 Node(ELECTRON_RUN_AS_NODE) 로
    const run = (cmd: string) => spawnSync(cmd, [script, projectDir, configFile, entry], {
      cwd: projectDir, encoding: 'utf8', timeout: opts.timeoutMs ?? 15000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      windowsHide: true,
    });
    let r = run(process.env.DEVBOOST_NODE ?? 'node');
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT' && process.execPath && !process.env.DEVBOOST_NODE) {
      r = run(process.execPath);
    }
    if (r.status === 0 && r.stdout) {
      try {
        // 플러그인이 stdout 에 로그를 찍어도 마지막 줄의 마커 뒤 JSON 만 읽는다
        const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('__DEVBOOST_VITE__')) ?? '';
        const j = JSON.parse(line.slice('__DEVBOOST_VITE__'.length));
        info = { configFile, base: j.base ?? '/', aliases: j.aliases ?? [], proxies: j.proxies ?? [] };
      } catch {
        info = null;
      }
    }
  }
  cache.set(configFile, { mtime, info });
  return info;
}

/** 프록시 규칙을 적용했을 때 서버에 도착하는 경로. 해당 없으면 null */
export function applyProxy(url: string, proxies: ViteProxy[]): { path: string; target: string } | null {
  const p = url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
  // 긴 접두어 우선 (Vite 도 선언 순서대로 보지만, 긴 것이 더 구체적)
  const sorted = [...proxies].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of sorted) {
    const isRegex = rule.prefix.startsWith('^');
    if (isRegex) {
      // 정규식 키: rewrite 는 접두어 방식으로 알 수 없으므로 경로는 그대로 (대상 서버만)
      try {
        if (new RegExp(rule.prefix).test(p)) return { path: p, target: rule.target };
      } catch {
        /* 잘못된 정규식 */
      }
      continue;
    }
    if (p === rule.prefix || p.startsWith(rule.prefix.endsWith('/') ? rule.prefix : rule.prefix + '/') || (!rule.prefix.startsWith('/') && p.startsWith(rule.prefix))) {
      return { path: (rule.rewritten + p.slice(rule.prefix.length)) || '/', target: rule.target };
    }
  }
  return null;
}
