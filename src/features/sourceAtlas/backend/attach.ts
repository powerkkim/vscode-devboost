import { buildBackendIndex, BackendIndex } from './indexer';
import { JavaClass, JavaMethod, Ann, simpleType } from './javaParser';
import { sqlFromAnnotationArgs } from './mybatisParser';
import { extractTables } from './sqlTables';
import { SqlStatement } from './mybatisParser';
import { joinMapping, matchPaths, pathSegments } from './pathMatch';
import type { AtlasEdge, AtlasGraph, AtlasNode } from '../analyzer/types';

export interface AttachOptions {
  /** 컨트롤러에서 몇 단계 아래까지 따라갈지 (기본 6) */
  maxDepth?: number;
  useCache?: boolean;
}

interface Endpoint {
  cls: JavaClass;
  method: JavaMethod;
  httpMethod: string; // GET.. | ANY
  path: string;
  segs: string[];
}

const MAPPING_ANN: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY',
};
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized', 'super', 'this', 'throw', 'else', 'try', 'do', 'assert']);

/** 어노테이션 인자에서 경로 문자열들과 HTTP 메서드들을 읽는다 */
function readMapping(ann: Ann): { paths: string[]; methods: string[] } {
  const args = ann.args;
  const parts: string[] = [];
  let depth = 0, cur = '', inStr = false;
  for (const c of args) {
    if (c === '"') inStr = !inStr;
    if (!inStr && '({['.includes(c)) depth++;
    if (!inStr && ')}]'.includes(c)) depth--;
    if (c === ',' && depth === 0 && !inStr) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const paths: string[] = [];
  let methods: string[] = [];
  for (const p of parts) {
    const kv = p.match(/^\s*(\w+)\s*=([\s\S]*)$/);
    const key = kv?.[1];
    const val = kv ? kv[2] : p;
    if (!key || key === 'value' || key === 'path') {
      for (const s of val.matchAll(/"((?:[^"\\]|\\.)*)"/g)) paths.push(s[1]);
    } else if (key === 'method') {
      methods = Array.from(val.matchAll(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)).map((m) => m[1]);
    }
  }
  return { paths: paths.length ? paths : [''], methods };
}

function collectEndpoints(index: BackendIndex): Endpoint[] {
  const out: Endpoint[] = [];
  for (const cls of index.classes) {
    if (!cls.annotations.some((a) => a.name === 'RestController' || a.name === 'Controller')) continue;
    const classMap = cls.annotations.find((a) => a.name === 'RequestMapping');
    const base = classMap ? readMapping(classMap).paths : [''];
    for (const method of cls.methods) {
      for (const ann of method.annotations) {
        const dflt = MAPPING_ANN[ann.name];
        if (!dflt) continue;
        const { paths, methods } = readMapping(ann);
        const verbs = dflt === 'ANY' ? (methods.length ? methods : ['ANY']) : [dflt];
        for (const b of base) for (const p of paths) for (const v of verbs) {
          const full = joinMapping(b, p);
          out.push({ cls, method, httpMethod: v, path: full, segs: pathSegments(full) });
        }
      }
    }
  }
  return out;
}

const simple = (t: string) => simpleType(t);

/** 본문에서 `receiver.method(args)` 형태의 호출을 뽑는다 (문자열 내용은 가려진 본문 기준) */
interface Call {
  recv: string | null; // null 이면 같은 클래스의 메서드 호출
  name: string;
  argc: number;
}
function countArgs(body: string, openIdx: number): number {
  let depth = 0, n = 0, any = false;
  for (let i = openIdx; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return any ? n + 1 : 0;
    } else if (c === ',' && depth === 1) n++;
    else if (depth >= 1 && !/\s/.test(c)) any = true;
  }
  return any ? n + 1 : 0;
}
function extractCalls(body: string): Call[] {
  const calls: Call[] = [];
  for (const m of body.matchAll(/(?<![\w.$])(?:this\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)) {
    calls.push({ recv: m[1], name: m[2], argc: countArgs(body, m.index! + m[0].length - 1) });
  }
  for (const m of body.matchAll(/(?<![\w.$])(?:this\s*\.\s*)?([a-z_]\w*)\s*\(/g)) {
    if (KEYWORDS.has(m[1])) continue;
    const before = body.slice(Math.max(0, m.index! - 4), m.index!);
    if (/new\s*$/.test(before) || /\.\s*$/.test(before.replace(/this\s*$/, ''))) continue;
    calls.push({ recv: null, name: m[1], argc: countArgs(body, m.index! + m[0].length - 1) });
  }
  return calls;
}

export function attachBackend(graph: AtlasGraph, workspaceRoot: string, opts: AttachOptions = {}): string {
  const index = buildBackendIndex(workspaceRoot, opts.useCache ?? true);
  if (index.stats.controllers === 0) {
    return '';
  }
  const maxDepth = opts.maxDepth ?? 6;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [`${e.from}|${e.to}|${e.type}|${e.label ?? ''}`, e]));
  const addNode = (n: AtlasNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };
  const addEdge = (e: AtlasEdge) => {
    const k = `${e.from}|${e.to}|${e.type}|${e.label ?? ''}`;
    const prev = edges.get(k);
    if (!prev || (prev.certainty === 'guess' && e.certainty === 'sure')) edges.set(k, e);
  };

  const isMapper = (c: JavaClass) => c.annotations.some((a) => a.name === 'Mapper') || index.mapperNamespaces.has(c.fqcn);
  const stereotype = (c: JavaClass): 'controller' | 'mapper' | 'service' =>
    c.annotations.some((a) => a.name === 'RestController' || a.name === 'Controller') ? 'controller' : isMapper(c) ? 'mapper' : 'service';

  const pickClass = (type: string, from: JavaClass): JavaClass | undefined => {
    const cands = index.bySimple.get(simple(type));
    if (!cands?.length) return undefined;
    if (cands.length === 1) return cands[0];
    return cands.find((c) => from.imports.includes(c.fqcn)) ?? cands.find((c) => c.pkg === from.pkg) ?? cands[0];
  };
  const findMethod = (c: JavaClass, name: string, argc: number, depth = 0): JavaMethod | undefined => {
    const same = c.methods.filter((m) => m.name === name);
    const hit = same.find((m) => m.params.length === argc) ?? same[0];
    if (hit || depth > 3) return hit;
    for (const sup of [...c.extends, ...c.implements]) {
      const sc = pickClass(sup, c);
      const r = sc && sc !== c ? findMethod(sc, name, argc, depth + 1) : undefined;
      if (r) return r;
    }
    return undefined;
  };

  // ── 노드 생성
  const methodNode = (c: JavaClass, m: JavaMethod, ep?: Endpoint): AtlasNode => {
    const st = stereotype(c);
    const id = `java:${c.fqcn}#${m.name}/${m.params.length}`;
    const existing = nodes.get(id);
    if (existing) return existing;
    return addNode({
      id, kind: st, label: `${c.name}.${m.name}`, file: c.file, line: m.line,
      meta: {
        class: c.fqcn, params: m.params.map((p) => `${p.type} ${p.name}`), returns: m.returnType,
        ...(ep ? { httpMethod: ep.httpMethod, path: ep.path } : {}),
      },
    });
  };
  const sqlNode = (stmt: SqlStatement | null, key: string, label: string, fallbackFile: string, fallbackLine: number, annSql?: { type: string; sql: string }): AtlasNode => {
    const id = `sql:${key}`;
    const ex = nodes.get(id);
    if (ex) return ex;
    const sql = stmt?.sql ?? annSql?.sql ?? '';
    const tables = stmt?.tables ?? (annSql ? extractTables(annSql.sql) : { read: [], write: [] });
    const node = addNode({
      id, kind: 'mapper', label, file: stmt?.file ?? fallbackFile, line: stmt?.line ?? fallbackLine,
      meta: {
        sqlType: stmt?.type ?? annSql?.type ?? '?', sql: sql.length > 4000 ? sql.slice(0, 4000) + ' …' : sql,
        tables: { read: tables.read, write: tables.write },
      },
      warnings: sql ? undefined : ['매핑된 SQL(XML/어노테이션)을 찾지 못함'],
    });
    for (const [list, type] of [[tables.read, 'reads'], [tables.write, 'writes']] as const) {
      for (const t of list) {
        const tid = `table:${t.toLowerCase()}`;
        const tn = addNode({ id: tid, kind: 'table', label: t, meta: { name: t } });
        const dyn = t.includes('${');
        if (dyn) (tn.warnings ??= []).push('테이블명이 동적(${})이라 정확하지 않을 수 있음');
        addEdge({ from: id, to: tid, type, certainty: dyn ? 'guess' : 'sure' });
      }
    }
    return node;
  };

  // ── 메서드 본문 따라가기
  const expanded = new Set<string>();
  const annSqlOf = (m: JavaMethod) => {
    const a = m.annotations.find((x) => ['Select', 'Insert', 'Update', 'Delete'].includes(x.name));
    return a ? { type: a.name.toLowerCase(), sql: sqlFromAnnotationArgs(a.args) } : undefined;
  };

  function expand(c: JavaClass, m: JavaMethod, nodeId: string, depth: number, inlineSeen: Set<string>) {
    if (!m.body) return;
    const typeOf = new Map<string, string>();
    c.fields.forEach((f) => typeOf.set(f.name, f.type));
    c.ctorParams.forEach((f) => typeOf.set(f.name, f.type));
    m.params.forEach((p) => typeOf.set(p.name, p.type));
    for (const lv of m.body.matchAll(/\b([A-Z][\w.]*(?:<[^;=()]*>)?)\s+([a-z_]\w*)\s*(?:=|;|:)/g)) typeOf.set(lv[2], simple(lv[1]));

    // 1) sqlSession.selectList("namespace.id") 형태의 문자열 호출
    for (const lit of (m.bodyText ?? '').matchAll(/\.\s*(?:select\w*|insert|update|delete|queryFor\w+)\s*\(\s*"([\w.]+)"/g)) {
      const stmt = index.statements.get(lit[1]);
      if (stmt) {
        const sn = sqlNode(stmt, lit[1], `${stmt.namespace.split('.').pop()}.${stmt.id}`, stmt.file, stmt.line);
        addEdge({ from: nodeId, to: sn.id, type: 'calls', certainty: 'sure', label: 'sqlSession' });
      }
    }
    // 2) 객체 메서드 호출 / 같은 클래스 메서드 호출
    for (const call of extractCalls(m.body)) {
      if (call.recv === null) {
        const own = c.methods.find((x) => x.name === call.name && x.params.length === call.argc);
        const key = `${c.fqcn}#${call.name}/${call.argc}`;
        if (own && own !== m && !inlineSeen.has(key)) {
          inlineSeen.add(key);
          expand(c, own, nodeId, depth, inlineSeen); // private 보조 메서드는 노드를 만들지 않고 호출자에 합쳐서 본다
        }
        continue;
      }
      const t = typeOf.get(call.recv) ?? (/^[A-Z]/.test(call.recv) ? call.recv : undefined);
      if (!t) continue;
      const target = pickClass(t, c);
      if (!target || stereotype(target) === 'controller') continue;
      follow(target, call, nodeId, depth);
    }
  }

  function follow(target: JavaClass, call: Call, fromId: string, depth: number) {
    if (isMapper(target)) {
      const meth = findMethod(target, call.name, call.argc);
      if (!meth) return;
      const key = `${target.fqcn}.${call.name}`;
      const stmt = index.statements.get(key) ?? null;
      const sn = sqlNode(stmt, key, `${target.name}.${call.name}`, target.file, meth.line, annSqlOf(meth));
      addEdge({ from: fromId, to: sn.id, type: 'calls', certainty: 'sure' });
      return;
    }
    let targets: JavaClass[] = [target];
    if (target.kind === 'interface') {
      const impls = (index.implementors.get(target.name) ?? []).filter((x) => x.kind === 'class').slice(0, 3);
      if (impls.length) targets = impls;
    }
    for (const tc of targets) {
      const meth = findMethod(tc, call.name, call.argc);
      if (!meth) continue;
      const node = methodNode(tc, meth);
      if (target !== tc) node.meta.interface = target.name;
      addEdge({ from: fromId, to: node.id, type: 'calls', certainty: targets.length > 1 ? 'guess' : 'sure' });
      if (depth + 1 <= maxDepth && !expanded.has(node.id)) {
        expanded.add(node.id);
        expand(tc, meth, node.id, depth + 1, new Set([`${tc.fqcn}#${meth.name}/${meth.params.length}`]));
      } else if (depth + 1 > maxDepth) {
        node.meta.truncated = true;
      }
    }
  }

  // ── API 호출 노드 ↔ 컨트롤러 엔드포인트 매칭
  const endpoints = collectEndpoints(index);
  let apiTotal = 0, apiMatched = 0;
  for (const api of graph.nodes.filter((n) => n.kind === 'api-call')) {
    apiTotal++;
    const method = String(api.meta.method ?? 'GET').toUpperCase();
    const segs = pathSegments(String(api.meta.url ?? ''));
    const exact: Endpoint[] = [], suffix: Endpoint[] = []; // suffix 에는 loose 도 포함 (둘 다 '추정')
    for (const ep of endpoints) {
      if (ep.httpMethod !== 'ANY' && ep.httpMethod !== method) continue;
      const k = matchPaths(segs, ep.segs);
      if (k === 'exact') exact.push(ep);
      else if (k === 'suffix' || k === 'loose') suffix.push(ep);
    }
    // Spring 은 고정 문자열 경로가 {변수} 경로보다 우선한다 → 고정 세그먼트가 가장 많은 후보만 남긴다
    const literals = (ep: Endpoint) => ep.segs.filter((x) => x !== '{}').length;
    const best = exact.length ? Math.max(...exact.map(literals)) : 0;
    const hits = exact.length ? exact.filter((ep) => literals(ep) === best) : suffix.slice(0, 5);
    if (!hits.length) {
      api.meta.backend = 'unmatched';
      continue;
    }
    apiMatched++;
    api.meta.backend = 'matched';
    if (exact.length) {
      // 래퍼(api.post 등)로 부른 호출도 서버 엔드포인트와 정확히 맞으면 실제 HTTP 호출로 확인된 것 → 확실로 올린다
      api.meta.confirmedBy = 'backend';
      api.warnings = api.warnings?.filter((w) => !w.startsWith('커스텀 래퍼'));
      if (!api.warnings?.length) delete api.warnings;
      for (const e of edges.values()) {
        if (e.to === api.id && e.type === 'calls') e.certainty = 'sure';
      }
    }
    for (const ep of hits) {
      const node = methodNode(ep.cls, ep.method, ep);
      addEdge({ from: api.id, to: node.id, type: 'handles', certainty: exact.length ? 'sure' : 'guess' });
      if (!expanded.has(node.id)) {
        expanded.add(node.id);
        expand(ep.cls, ep.method, node.id, 0, new Set([`${ep.cls.fqcn}#${ep.method.name}/${ep.method.params.length}`]));
      }
    }
  }

  graph.nodes = [...nodes.values()];
  graph.edges = [...edges.values()];
  const sqlCount = graph.nodes.filter((n) => n.id.startsWith('sql:')).length;
  const tableCount = graph.nodes.filter((n) => n.kind === 'table').length;
  graph.analyzer = 'vue3+spring';
  return `백엔드: 컨트롤러 ${index.stats.controllers} · API ${apiMatched}/${apiTotal} 매칭 · SQL ${sqlCount} · 테이블 ${tableCount}`;
}
