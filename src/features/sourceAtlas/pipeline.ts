import { buildAtlasGraph } from './analyzer/graphBuilder';
import { attachAncestors, clearReverseCache } from './analyzer/reverse';
import { Resolver } from './analyzer/resolver';
import { FlowEngine } from './analyzer/flow/engine';
import { probeVite, clearViteProbeCache, ProbeOptions, ViteInfo } from './analyzer/viteProbe';
import * as fs from 'fs';
import * as path from 'path';
import { attachBackend } from './backend/attach';
import { clearBackendCache } from './backend/indexer';
import type { AtlasGraph } from './analyzer/types';

export interface PipelineOptions {
  workspaceRoot: string;
  maxDepth?: number;
  maxUp?: number;
  backend?: boolean;
  backendDepth?: number;
  aliases?: Record<string, string>;
  /** true 면 색인 캐시를 버리고 다시 만든다 ("다시 분석") */
  fresh?: boolean;
  /** Vite 설정 실행(프로브). false 면 정적 해석만 */
  vite?: ProbeOptions | false;
  /** 백엔드 context-path (설정으로 지정). 없으면 application.yml/properties 에서 찾는다 */
  contextPath?: string;
}

/** 색인 캐시(프론트 import 역색인, 백엔드 색인)를 비운다 */
export function clearAtlasCaches() {
  clearReverseCache();
  clearBackendCache();
  clearViteProbeCache();
}

/** 열린 .vue 한 개 → 아래(자식·API·백엔드)와 위(부모·라우트)를 모두 분석한 AtlasGraph */
export function analyzeSource(rootFile: string, opts: PipelineOptions): { graph: AtlasGraph; notes: string[] } {
  if (opts.fresh) {
    clearAtlasCaches();
  }
  const notes: string[] = [];
  // Vite 설정을 프로젝트의 vite 로 실제로 읽어 alias·proxy 를 얻는다 (못 읽으면 정적 해석)
  let vite: ViteInfo | null = null;
  const probeResolver = new Resolver({ workspaceRoot: opts.workspaceRoot, aliases: opts.aliases });
  const projectDir = probeResolver.findProjectDir(path.resolve(rootFile));
  if (opts.vite !== false) {
    vite = probeVite(projectDir, opts.vite ?? {});
  }
  const aliases: Record<string, string> = { ...(opts.aliases ?? {}) };
  for (const a of vite?.aliases ?? []) {
    if (a.regex || aliases[a.find]) continue;
    let target = a.replacement;
    if (!path.isAbsolute(target) || !fs.existsSync(target)) {
      const inProject = path.join(projectDir, target.replace(/^\/+/, ''));
      if (fs.existsSync(inProject)) target = inProject;
    }
    aliases[a.find] = target;
  }
  // 호출 전파 엔진은 한 번의 분석 동안 모듈 요약을 공유한다 (상위 컴포넌트 분석에서도 재사용)
  const engine = new FlowEngine({ resolver: new Resolver({ workspaceRoot: opts.workspaceRoot, aliases }) });
  const graph = buildAtlasGraph(rootFile, { workspaceRoot: opts.workspaceRoot, maxDepth: opts.maxDepth, aliases, engine });
  const up = attachAncestors(graph, rootFile, { workspaceRoot: opts.workspaceRoot, maxUp: opts.maxUp, aliases, engine });
  if (up) notes.push(up);
  if (opts.backend !== false) {
    const contextPath = opts.contextPath ?? findContextPath(opts.workspaceRoot);
    const be = attachBackend(graph, opts.workspaceRoot, { maxDepth: opts.backendDepth, proxies: vite?.proxies, contextPath });
    notes.push(be || '백엔드 소스 없음 → UI·API 호출까지만 분석');
    if (be && contextPath) notes.push(`context-path ${contextPath}`);
  }
  if (vite) notes.push(`Vite 설정 읽음 (alias ${vite.aliases.length} · proxy ${vite.proxies.length})`);
  graph.meta = { ...(graph.meta ?? {}), vite: vite ? { proxies: vite.proxies, base: vite.base } : undefined, projectDir: path.relative(opts.workspaceRoot, projectDir) || '.' };
  return { graph, notes };
}

/** application.yml / application.properties 에서 server.servlet.context-path 를 찾는다 (첫 번째 것) */
export function findContextPath(workspaceRoot: string): string | undefined {
  const stack = [workspaceRoot];
  const skip = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', 'test']);
  let count = 0;
  while (stack.length && count < 4000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      count++;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(abs);
      } else if (/^application(-\w+)?\.(ya?ml|properties)$/.test(e.name) && abs.includes(`${path.sep}resources${path.sep}`)) {
        try {
          const text = fs.readFileSync(abs, 'utf8');
          const prop = text.match(/^\s*server\.servlet\.context-path\s*[=:]\s*(\S+)/m);
          if (prop) return prop[1].replace(/['"]/g, '');
          const yml = text.match(/^server:\s*\n(?:[ \t]+.*\n)*?[ \t]+servlet:\s*\n(?:[ \t]+.*\n)*?[ \t]+context-path:\s*(\S+)/m);
          if (yml) return yml[1].replace(/['"]/g, '');
        } catch {
          /* 무시 */
        }
      }
    }
  }
  return undefined;
}
