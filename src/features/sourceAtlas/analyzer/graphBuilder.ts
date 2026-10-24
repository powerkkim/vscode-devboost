import * as fs from 'fs';
import * as path from 'path';
import { parseSfc } from './sfcParser';
import { extractTemplate, looksLikeComponent, normalizeName } from './templateExtractor';
import {
  extractScript, mergeScriptInfo, emptyScriptInfo, ScriptInfo,
} from './scriptExtractor';
import { Resolver } from './resolver';
import type { AtlasEdge, AtlasGraph, AtlasNode } from './types';

export interface BuildOptions {
  workspaceRoot: string;
  /** 루트 파일에서 몇 단계 아래까지 따라갈지 (기본 3) */
  maxDepth?: number;
  aliases?: Record<string, string>;
}

const posix = (p: string) => p.split(path.sep).join('/');

/** 열려 있는 .vue 파일을 루트로 import 를 따라가며 AtlasGraph 를 만든다. */
export function buildAtlasGraph(rootFile: string, opts: BuildOptions): AtlasGraph {
  const root = path.resolve(opts.workspaceRoot);
  const maxDepth = opts.maxDepth ?? 3;
  const resolver = new Resolver({ workspaceRoot: root, aliases: opts.aliases });

  const nodes = new Map<string, AtlasNode>();
  const edges = new Map<string, AtlasEdge>();

  const idOf = (abs: string) => posix(path.relative(root, abs));
  const addEdge = (e: AtlasEdge) => {
    const key = `${e.from}|${e.to}|${e.type}|${e.label ?? ''}`;
    const prev = edges.get(key);
    if (!prev || (prev.certainty === 'guess' && e.certainty === 'sure')) {
      edges.set(key, e);
    }
  };
  const warn = (n: AtlasNode, msg: string) => {
    (n.warnings ??= []);
    if (!n.warnings.includes(msg)) {
      n.warnings.push(msg);
    }
  };

  /** 파일 하나를 분석해 노드를 만들고, 자식 파일은 depth 제한 안에서 재귀한다. */
  function analyze(abs: string, kind: 'component' | 'composable' | 'store', label: string | undefined, depth: number): string {
    const id = idOf(abs);
    if (nodes.has(id)) {
      return id; // 이미 있음(중복 사용·순환): 노드는 하나, 엣지만 늘어남
    }
    const node: AtlasNode = {
      id, kind, label: label ?? path.basename(abs).replace(/\.[^.]+$/, ''), file: id, line: 1, meta: {},
    };
    nodes.set(id, node);

    if (depth > maxDepth) {
      node.meta.truncated = true; // 깊이 제한: 노드만 만들고 펼치지 않음
      return id;
    }

    let source: string;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      warn(node, `파일을 읽지 못함: ${(e as Error).message}`);
      return id;
    }

    let script: ScriptInfo = emptyScriptInfo('js');
    let tags = new Set<string>();
    let staticIs: string[] = [];
    let tplLocs: Record<string, { line: number; col: number }> = {};

    if (abs.endsWith('.vue')) {
      const { descriptor, errors } = parseSfc(source, abs);
      errors.forEach((m) => warn(node, `SFC 파싱 오류: ${m}`));
      const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean) as NonNullable<typeof descriptor.script>[];
      for (const b of blocks) {
        const lang: 'ts' | 'js' = b.lang === 'ts' || b.lang === 'tsx' ? 'ts' : 'js';
        const info = extractScript(b.content, {
          lang, isSetup: b === descriptor.scriptSetup, lineOffset: b.loc.start.line - 1, jsx: b.lang === 'tsx' || b.lang === 'jsx',
        });
        script = blocks.indexOf(b) === 0 ? info : mergeScriptInfo(script, info);
      }
      if (descriptor.template) {
        if (descriptor.template.ast) {
          const t = extractTemplate(descriptor.template.ast);
          tags = t.tags;
          staticIs = t.staticIs;
          tplLocs = t.locs;
          node.meta.slots = t.slots;
          if (t.dynamicComponent) {
            warn(node, '동적 컴포넌트(<component :is>)가 있어 일부 관계를 정적으로 알 수 없음');
          }
        } else {
          warn(node, 'template 을 파싱하지 못함 (pug 등 비표준 언어 또는 src 참조)');
        }
      }
    } else {
      const lang = /\.(ts|mts|tsx)$/.test(abs) ? 'ts' : 'js';
      script = extractScript(source, { lang, isModule: true, jsx: abs.endsWith('x') });
    }

    script.warnings.forEach((m) => warn(node, m));
    if (script.storeDefs.length) {
      node.kind = 'store';
      node.meta.storeId = script.storeDefs[0];
      node.meta.storeKind = 'pinia';
    }

    if (node.kind === 'component') {
      Object.assign(node.meta, {
        style: script.style, lang: script.lang, props: script.props, emits: script.emits,
        refs: script.refs, computed: script.computed, watchers: script.watchers,
      });
    } else if (node.kind === 'composable') {
      Object.assign(node.meta, { lang: script.lang, refs: script.refs, computed: script.computed, watchers: script.watchers });
    }

    // ── 템플릿에서 쓰인 컴포넌트 ↔ import / components 옵션 매칭
    const usedLocals = new Set<string>();
    const wanted = [...tags, ...staticIs];
    const localFor = (tag: string): string | undefined => {
      const n = normalizeName(tag);
      const regKey = Object.keys(script.registered).find((k) => normalizeName(k) === n);
      if (regKey) {
        return script.registered[regKey];
      }
      return script.imports.find((i) => normalizeName(i.local) === n)?.local;
    };
    wanted.forEach((t) => {
      const l = localFor(t);
      if (l) {
        usedLocals.add(l);
      }
    });
    const matchedTags = new Set(wanted.filter((t) => localFor(t)));
    const unresolvedTags = [...tags].filter((t) => looksLikeComponent(t) && !matchedTags.has(t));
    if (node.kind === 'component' && unresolvedTags.length) {
      node.meta.unresolvedTags = unresolvedTags; // 전역 등록(예: app.use(ElementPlus)) 추정
    }
    // 상세 패널에서 심볼을 클릭하면 이동할 위치
    const locs: Record<string, { line: number; col: number }> = { ...script.locs };
    for (const [k, v] of Object.entries(tplLocs)) {
      if (k.startsWith('slots:')) locs[k] = v;
      else if (k.startsWith('tag:') && unresolvedTags.includes(k.slice(4))) locs[`unresolvedTags:${k.slice(4)}`] = v;
    }
    node.meta.locs = locs;

    // ── import 순회
    const seenDirect = new Set<string>();
    for (const imp of script.imports) {
      const target = resolver.resolve(imp.source, abs);
      if (target && target.endsWith('.vue')) {
        const childId = analyze(target, 'component', undefined, depth + 1);
        const used = usedLocals.has(imp.local);
        addEdge({ from: id, to: childId, type: used ? 'uses' : 'imports', certainty: used ? 'sure' : 'guess' });
        seenDirect.add(target);
      } else if (!target && usedLocals.has(imp.local) && !imp.source.startsWith('.')) {
        const ext = `external:${imp.source}`;
        if (!nodes.has(ext)) {
          nodes.set(ext, { id: ext, kind: 'external', label: imp.source, meta: { package: imp.source } });
        }
        addEdge({ from: id, to: ext, type: 'uses', certainty: 'sure', label: imp.local });
      }
    }

    // ── composable / store
    for (const u of script.uses) {
      const imp = script.imports.find((i) => i.local === u.name);
      const target = imp ? resolver.resolve(imp.source, abs) : null;
      if (target && !target.endsWith('.vue')) {
        const isStore = /Store$/.test(u.name);
        const childId = analyze(target, isStore ? 'store' : 'composable', u.name, depth + 1);
        addEdge({ from: id, to: childId, type: 'uses', certainty: 'sure', label: u.name });
      }
    }

    // ── 동적 import
    for (const d of script.dynamicImports) {
      if (d.source === null) {
        warn(node, `변수로 지정된 동적 import (${node.file}:${d.line}) 는 정적으로 추적할 수 없음`);
        continue;
      }
      const target = resolver.resolve(d.source, abs);
      if (target && target.endsWith('.vue') && !seenDirect.has(target)) {
        const childId = analyze(target, 'component', undefined, depth + 1);
        addEdge({ from: id, to: childId, type: 'imports', certainty: 'sure', label: 'dynamic import' });
      }
    }

    // ── API 호출: 같은 URL 은 노드 하나, 호출한 위치(파일·줄·함수)는 callers 에 모두 기록
    for (const a of script.apis) {
      const apiId = `api:${a.method} ${a.url}`;
      if (!nodes.has(apiId)) {
        nodes.set(apiId, {
          id: apiId, kind: 'api-call', label: `${a.method} ${a.url}`, file: id, line: a.line,
          meta: { method: a.method, url: a.url, via: a.via, callers: [] },
        });
      }
      const an = nodes.get(apiId)!;
      const callers = an.meta.callers as { file: string; line: number; col: number; fn?: string; from: string }[];
      if (!callers.some((c) => c.file === id && c.line === a.line)) {
        callers.push({ file: id, line: a.line, col: a.col, fn: a.fn, from: node.label });
      }
      addEdge({ from: id, to: apiId, type: 'calls', certainty: a.certainty, label: a.fn ? `${a.fn}()` : undefined });
      if (a.certainty === 'guess' && !an.warnings) {
        an.warnings = ['커스텀 래퍼 호출로 추정 (이름이 api/http 등으로 보임)'];
      }
    }
    return id;
  }

  const rootAbs = path.resolve(rootFile);
  const rootId = analyze(rootAbs, 'component', undefined, 0);
  return {
    version: 1,
    root: rootId,
    analyzer: 'vue3',
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}
