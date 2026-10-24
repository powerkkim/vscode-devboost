import { buildAtlasGraph } from './analyzer/graphBuilder';
import { attachAncestors, clearReverseCache } from './analyzer/reverse';
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
}

/** 열린 .vue 한 개 → 아래(자식·API·백엔드)와 위(부모·라우트)를 모두 분석한 AtlasGraph */
export function analyzeSource(rootFile: string, opts: PipelineOptions): { graph: AtlasGraph; notes: string[] } {
  if (opts.fresh) {
    clearReverseCache();
    clearBackendCache();
  }
  const graph = buildAtlasGraph(rootFile, { workspaceRoot: opts.workspaceRoot, maxDepth: opts.maxDepth, aliases: opts.aliases });
  const notes: string[] = [];
  const up = attachAncestors(graph, rootFile, { workspaceRoot: opts.workspaceRoot, maxUp: opts.maxUp, aliases: opts.aliases });
  if (up) notes.push(up);
  if (opts.backend !== false) {
    const be = attachBackend(graph, opts.workspaceRoot, { maxDepth: opts.backendDepth });
    notes.push(be || '백엔드 소스 없음 → UI·API 호출까지만 분석');
  }
  return { graph, notes };
}
