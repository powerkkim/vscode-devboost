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

/** 분석 단계 (화면에 진행 상황으로 보인다) */
export interface AnalysisStep {
  /** 1부터 */
  index: number;
  total: number;
  label: string;
}
export type ProgressFn = (step: AnalysisStep) => void;

interface Phase {
  label: string;
  run: () => void;
}

/** 분석을 단계로 나눈다. 동기/비동기 실행이 같은 단계를 쓴다 */
function phases(rootFile: string, opts: PipelineOptions, out: { graph?: AtlasGraph; notes: string[] }): Phase[] {
  let vite: ViteInfo | null = null;
  let projectDir = '';
  let aliases: Record<string, string> = {};
  let engine: FlowEngine;
  const list: Phase[] = [
    {
      label: 'Vite 설정 읽는 중',
      run: () => {
        if (opts.fresh) clearAtlasCaches();
        // Vite 설정을 프로젝트의 vite 로 실제로 읽어 alias·proxy 를 얻는다 (못 읽으면 정적 해석)
        const probeResolver = new Resolver({ workspaceRoot: opts.workspaceRoot, aliases: opts.aliases });
        projectDir = probeResolver.findProjectDir(path.resolve(rootFile));
        if (opts.vite !== false) vite = probeVite(projectDir, opts.vite ?? {});
        aliases = { ...(opts.aliases ?? {}) };
        for (const a of vite?.aliases ?? []) {
          if (a.regex || aliases[a.find]) continue;
          let target = a.replacement;
          if (!path.isAbsolute(target) || !fs.existsSync(target)) {
            const inProject = path.join(projectDir, target.replace(/^\/+/, ''));
            if (fs.existsSync(inProject)) target = inProject;
          }
          aliases[a.find] = target;
        }
      },
    },
    {
      label: '컴포넌트·API 호출 분석 중',
      run: () => {
        // 호출 전파 엔진은 한 번의 분석 동안 모듈 요약을 공유한다 (상위 컴포넌트 분석에서도 재사용)
        engine = new FlowEngine({ resolver: new Resolver({ workspaceRoot: opts.workspaceRoot, aliases }) });
        out.graph = buildAtlasGraph(rootFile, { workspaceRoot: opts.workspaceRoot, maxDepth: opts.maxDepth, aliases, engine });
      },
    },
    {
      label: '상위 컴포넌트·라우트 찾는 중',
      run: () => {
        const up = attachAncestors(out.graph!, rootFile, { workspaceRoot: opts.workspaceRoot, maxUp: opts.maxUp, aliases, engine });
        if (up) out.notes.push(up);
      },
    },
  ];
  if (opts.backend !== false) {
    list.push({
      label: '백엔드(Controller·SQL) 색인·매칭 중',
      run: () => {
        const contextPath = opts.contextPath ?? findContextPath(opts.workspaceRoot);
        const be = attachBackend(out.graph!, opts.workspaceRoot, { maxDepth: opts.backendDepth, proxies: vite?.proxies, contextPath });
        out.notes.push(be || '백엔드 소스 없음 → UI·API 호출까지만 분석');
        if (be && contextPath) out.notes.push(`context-path ${contextPath}`);
      },
    });
  }
  list.push({
    label: '정리 중',
    run: () => {
      const v = vite as ViteInfo | null;
      if (v) out.notes.push(`Vite 설정 읽음 (alias ${v.aliases.length} · proxy ${v.proxies.length})`);
      out.graph!.meta = { ...(out.graph!.meta ?? {}), vite: v ? { proxies: v.proxies, base: v.base } : undefined, projectDir: path.relative(opts.workspaceRoot, projectDir) || '.' };
    },
  });
  return list;
}

/** 열린 .vue 한 개 → 아래(자식·API·백엔드)와 위(부모·라우트)를 모두 분석한 AtlasGraph */
export function analyzeSource(rootFile: string, opts: PipelineOptions, onProgress?: ProgressFn): { graph: AtlasGraph; notes: string[] } {
  const out: { graph?: AtlasGraph; notes: string[] } = { notes: [] };
  const list = phases(rootFile, opts, out);
  list.forEach((ph, i) => {
    onProgress?.({ index: i + 1, total: list.length, label: ph.label });
    ph.run();
  });
  return { graph: out.graph!, notes: out.notes };
}

/**
 * 같은 분석을 단계 사이마다 이벤트 루프에 양보하며 실행한다.
 * 분석 자체는 동기 코드라, 양보하지 않으면 확장 호스트가 막혀 화면에 "분석 중" 메시지가 늦게 도착한다.
 * isCancelled() 가 true 가 되면 남은 단계를 건너뛰고 null.
 */
export async function analyzeSourceAsync(
  rootFile: string,
  opts: PipelineOptions,
  onProgress?: ProgressFn,
  isCancelled?: () => boolean,
): Promise<{ graph: AtlasGraph; notes: string[] } | null> {
  const out: { graph?: AtlasGraph; notes: string[] } = { notes: [] };
  const list = phases(rootFile, opts, out);
  for (let i = 0; i < list.length; i++) {
    if (isCancelled?.()) return null;
    onProgress?.({ index: i + 1, total: list.length, label: list[i].label });
    // 진행 메시지가 웹뷰로 실제로 나가도록 잠깐 양보 (setImmediate 만으로는 IPC 전송이 밀릴 수 있어 짧은 타이머)
    await new Promise((r) => setTimeout(r, 15));
    list[i].run();
  }
  return isCancelled?.() ? null : { graph: out.graph!, notes: out.notes };
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
