import * as fs from 'fs';
import * as path from 'path';

export interface ResolverOptions {
  workspaceRoot: string;
  /** 설정(devBoost.sourceAtlas.aliases)으로 직접 지정한 alias: { '@': 'src' } (workspaceRoot 기준 상대경로 또는 절대경로) */
  aliases?: Record<string, string>;
}

interface AliasRule {
  prefix: string;
  targets: string[]; // 절대경로
}

const EXTS = ['.vue', '.ts', '.js', '.tsx', '.jsx', '.mjs', '.mts'];
const PROJECT_MARKERS = [
  'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vue.config.js',
  'jsconfig.json', 'tsconfig.json', 'package.json',
];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 확장자 생략 · 폴더의 index 파일을 지원하는 파일 찾기 */
export function tryFile(p: string): string | null {
  if (isFile(p)) {
    return p;
  }
  for (const e of EXTS) {
    if (isFile(p + e)) {
      return p + e;
    }
  }
  if (isDir(p)) {
    for (const e of EXTS) {
      const idx = path.join(p, 'index' + e);
      if (isFile(idx)) {
        return idx;
      }
    }
  }
  return null;
}

/** JSON 안의 주석·후행 쉼표를 제거 (tsconfig 는 JSONC) */
function parseJsonc(text: string): any {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

export class Resolver {
  private projectCache = new Map<string, AliasRule[]>();
  private manual: AliasRule[];

  constructor(private opts: ResolverOptions) {
    this.manual = Object.entries(opts.aliases ?? {}).map(([prefix, target]) => ({
      prefix: prefix.replace(/\/$/, ''),
      targets: [path.isAbsolute(target) ? target : path.join(opts.workspaceRoot, target)],
    }));
  }

  /** import 문자열 → 실제 파일 절대경로. 못 찾으면 null (패키지 import 도 null) */
  resolve(source: string, fromFile: string): string | null {
    if (source.startsWith('.')) {
      return tryFile(path.resolve(path.dirname(fromFile), source));
    }
    if (path.isAbsolute(source) && !source.startsWith('/@')) {
      const r = tryFile(source);
      if (r) {
        return r;
      }
    }
    const rules = [...this.manual, ...this.aliasesFor(this.findProjectDir(fromFile))];
    rules.sort((a, b) => b.prefix.length - a.prefix.length);
    for (const rule of rules) {
      if (source === rule.prefix || source.startsWith(rule.prefix + '/')) {
        const rest = source.slice(rule.prefix.length).replace(/^\//, '');
        for (const t of rule.targets) {
          const r = tryFile(path.join(t, rest));
          if (r) {
            return r;
          }
        }
      }
    }
    return null;
  }

  /** 가장 가까운 상위 프로젝트 폴더 (vite.config / tsconfig / package.json 이 있는 곳) */
  findProjectDir(fromFile: string): string {
    const root = path.resolve(this.opts.workspaceRoot);
    let dir = path.dirname(fromFile);
    for (;;) {
      if (PROJECT_MARKERS.some((m) => isFile(path.join(dir, m)))) {
        return dir;
      }
      if (dir === root || path.dirname(dir) === dir) {
        return root;
      }
      dir = path.dirname(dir);
    }
  }

  private aliasesFor(projectDir: string): AliasRule[] {
    const cached = this.projectCache.get(projectDir);
    if (cached) {
      return cached;
    }
    const rules: AliasRule[] = [];
    // 1) tsconfig / jsconfig 의 paths
    for (const name of ['jsconfig.json', 'tsconfig.json']) {
      const f = path.join(projectDir, name);
      if (!isFile(f)) {
        continue;
      }
      try {
        const co = parseJsonc(fs.readFileSync(f, 'utf8')).compilerOptions ?? {};
        const base = path.resolve(projectDir, co.baseUrl ?? '.');
        for (const [key, vals] of Object.entries<string[]>(co.paths ?? {})) {
          rules.push({
            prefix: key.replace(/\/\*$/, ''),
            targets: vals.map((v) => path.resolve(base, v.replace(/\/\*$/, ''))),
          });
        }
      } catch {
        /* 해석 실패는 무시: 다음 방법으로 */
      }
    }
    // 2) vite.config / vue.config 의 resolve.alias (파일을 실행하지 않고 텍스트에서 패턴 추출)
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vue.config.js']) {
      const f = path.join(projectDir, name);
      if (isFile(f)) {
        rules.push(...parseViteAliases(fs.readFileSync(f, 'utf8'), projectDir));
      }
    }
    // 3) 관례: '@' 가 아직 없고 src 폴더가 있으면 '@' → src
    if (!rules.some((r) => r.prefix === '@') && isDir(path.join(projectDir, 'src'))) {
      rules.push({ prefix: '@', targets: [path.join(projectDir, 'src')] });
    }
    this.projectCache.set(projectDir, rules);
    return rules;
  }
}

/** vite.config 텍스트에서 alias 항목을 뽑는다. 완벽한 파서가 아니라 흔한 패턴만 대응. */
export function parseViteAliases(text: string, projectDir: string): AliasRule[] {
  const rules: AliasRule[] = [];
  const toTarget = (expr: string): string | null => {
    const strs = Array.from(expr.matchAll(/['"`]([^'"`]*)['"`]/g)).map((m) => m[1]);
    if (!strs.length) {
      return null;
    }
    const parts = strs.map((s) => s.replace(/^\.?\//, ''));
    return path.join(projectDir, ...parts);
  };
  // 배열 형태: { find: '@', replacement: ... }
  for (const m of text.matchAll(/find:\s*['"]([^'"]+)['"]\s*,\s*replacement:\s*([^}]+)\}/g)) {
    const t = toTarget(m[2]);
    if (t) {
      rules.push({ prefix: m[1], targets: [t] });
    }
  }
  // 객체 형태: alias: { '@': path.resolve(__dirname, 'src'), ... }
  const block = text.match(/alias\s*:\s*\{([\s\S]*?)\n?\s*\}/);
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*['"]?([^'":\s]+)['"]?\s*:\s*(.+?),?\s*$/);
      if (m) {
        const t = toTarget(m[2]);
        if (t) {
          rules.push({ prefix: m[1], targets: [t] });
        }
      }
    }
  }
  return rules;
}
