import * as fs from 'fs';
import * as path from 'path';
import { Resolver } from './resolver';
import { buildAtlasGraph } from './graphBuilder';
import type { FlowEngine } from './flow/engine';
import type { AtlasEdge, AtlasGraph, AtlasNode } from './types';

/**
 * "이 컴포넌트는 어디에 붙어 있나?" — 워크스페이스의 import 를 거꾸로 색인해서
 * 루트 컴포넌트의 부모(상위) 컴포넌트와, 그 컴포넌트를 화면으로 쓰는 라우트까지 올라간다.
 */
interface Importer {
  from: string; // 절대경로
  used: boolean; // template 에서 실제로 쓰였는가 (false 면 import 만 됨)
}
interface RouteEntry {
  file: string;
  line: number;
  path: string;
}
interface ReverseIndex {
  importers: Map<string, Importer[]>;
  routes: Map<string, RouteEntry[]>;
  files: number;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.idea', '.vscode', '.gradle', 'coverage', '.next', '.nuxt']);
const SRC_EXT = /\.(vue|ts|js|mjs|tsx|jsx|mts)$/;
const MAX_FILES = 20000;
const MAX_BYTES = 1_000_000;
const cache = new Map<string, ReverseIndex>();
export function clearReverseCache() {
  cache.clear();
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const IMPORT_RE = /(?:\bimport\s+(?:([\w$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+|[\w$*{}\s,]+?\s+from\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function buildIndex(root: string, aliases?: Record<string, string>): ReverseIndex {
  const resolver = new Resolver({ workspaceRoot: root, aliases });
  const importers = new Map<string, Importer[]>();
  const routes = new Map<string, RouteEntry[]>();
  let files = 0;
  const stack = [root];
  while (stack.length && files < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(abs);
        continue;
      }
      if (!SRC_EXT.test(e.name) || e.name.endsWith('.d.ts')) continue;
      let text: string;
      try {
        if (fs.statSync(abs).size > MAX_BYTES) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      files++;
      const isVue = e.name.endsWith('.vue');
      const locals = new Map<string, string>(); // 로컬 이름 → 해석된 파일
      const resolvedAll: string[] = [];
      for (const m of text.matchAll(IMPORT_RE)) {
        const target = resolver.resolve(m[2], abs);
        if (!target || !target.endsWith('.vue') || target === abs) continue;
        resolvedAll.push(target);
        if (m[1]) locals.set(m[1], target);
      }
      // 라우트 정의: { path: '/x', component: Foo }  /  component: () => import('...')
      if (!isVue && /\bcomponent\b/.test(text) && /\bpath\s*:/.test(text)) {
        for (const r of text.matchAll(/\bpath\s*:\s*['"`]([^'"`]*)['"`][\s\S]{0,300}?\bcomponent\s*:\s*(?:([\w$]+)|\(\s*\)\s*=>\s*import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]([^'"]+)['"]\s*\))/g)) {
          const target = r[3] ? resolver.resolve(r[3], abs) : locals.get(r[2]);
          if (target && target.endsWith('.vue')) {
            const arr = routes.get(target) ?? [];
            arr.push({ file: path.relative(root, abs).split(path.sep).join('/'), line: text.slice(0, r.index).split('\n').length, path: r[1] || '/' });
            routes.set(target, arr);
          }
        }
      }
      if (!isVue) continue; // 컴포넌트 → 컴포넌트 관계만 색인 (라우트는 위에서 처리)
      for (const target of new Set(resolvedAll)) {
        const local = [...locals.entries()].find(([, t]) => t === target)?.[0];
        const used = local
          ? new RegExp(`<(?:${local}|${kebab(local)})[\\s/>]`).test(text)
          : false;
        const arr = importers.get(target) ?? [];
        arr.push({ from: abs, used });
        importers.set(target, arr);
      }
    }
  }
  return { importers, routes, files };
}

export interface AncestorOptions {
  workspaceRoot: string;
  /** 위로 몇 단계까지 (기본 3) */
  maxUp?: number;
  aliases?: Record<string, string>;
  useCache?: boolean;
  engine?: FlowEngine;
}

/** graph 에 상위 컴포넌트·라우트를 추가하고 요약 문자열을 돌려준다 */
export function attachAncestors(graph: AtlasGraph, rootAbs: string, opts: AncestorOptions): string {
  const root = path.resolve(opts.workspaceRoot);
  const maxUp = opts.maxUp ?? 3;
  if (maxUp <= 0) return '';
  let index = opts.useCache === false ? undefined : cache.get(root);
  if (!index) {
    index = buildIndex(root, opts.aliases);
    cache.set(root, index);
  }
  const idOf = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges: AtlasEdge[] = [...graph.edges];
  const seenEdge = new Set(edges.map((e) => `${e.from}|${e.to}|${e.type}`));
  const addEdge = (e: AtlasEdge) => {
    const k = `${e.from}|${e.to}|${e.type}`;
    if (!seenEdge.has(k)) {
      seenEdge.add(k);
      edges.push(e);
    }
  };
  const ancestorNode = (abs: string): AtlasNode => {
    const id = idOf(abs);
    const ex = nodes.get(id);
    if (ex) return ex;
    // 깊이 0 으로 분석하면 그 파일 자신의 props/emits 등 메타만 얻는다 (자식은 펼치지 않음)
    const g = buildAtlasGraph(abs, { workspaceRoot: root, maxDepth: 0, aliases: opts.aliases, engine: opts.engine });
    const n = g.nodes.find((x) => x.id === g.root)!;
    n.meta.relation = 'ancestor';
    delete n.meta.truncated;
    nodes.set(id, n);
    return n;
  };

  let level = [path.resolve(rootAbs)];
  const visited = new Set(level.map(idOf));
  let ancestors = 0, routes = 0;
  const addRoutesFor = (abs: string) => {
    for (const r of index!.routes.get(abs) ?? []) {
      const rid = `route:${r.path}`;
      if (!nodes.has(rid)) {
        nodes.set(rid, { id: rid, kind: 'route', label: r.path, file: r.file, line: r.line, meta: { path: r.path, relation: 'ancestor' } });
        routes++;
      }
      addEdge({ from: rid, to: idOf(abs), type: 'uses', certainty: 'sure', label: 'route' });
    }
  };
  addRoutesFor(level[0]);
  for (let up = 0; up < maxUp && level.length; up++) {
    const next: string[] = [];
    for (const child of level) {
      for (const imp of index.importers.get(child) ?? []) {
        const parent = ancestorNode(imp.from);
        addEdge({ from: parent.id, to: idOf(child), type: imp.used ? 'uses' : 'imports', certainty: imp.used ? 'sure' : 'guess' });
        if (!visited.has(parent.id)) {
          visited.add(parent.id);
          ancestors++;
          addRoutesFor(imp.from);
          next.push(imp.from);
        }
      }
    }
    level = next;
  }
  graph.nodes = [...nodes.values()];
  graph.edges = edges;
  return ancestors || routes ? `상위 ${ancestors}개 컴포넌트${routes ? ` · 라우트 ${routes}` : ''}` : '상위 없음(어디에서도 import 되지 않음)';
}
