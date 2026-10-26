/**
 * 모듈(파일) 하나를 읽어 "함수 요약"을 만든다. 다른 파일은 열지 않는다.
 *
 * - 이름이 붙은 함수(선언, 변수에 대입, 객체 속성/메서드, export, defineStore 인자)마다 요약 하나:
 *   그 함수가 하는 호출(callee·인자를 기호 값으로)과 돌려주는 값.
 * - 이름 없는 콜백(onMounted(() => …), .then(…), forEach(…))의 호출은 바깥 함수의 호출로 친다.
 * - .vue 의 <script setup> 최상위 문장은 `<setup>` 이라는 가상 함수의 본문으로 본다.
 *
 * 이름 해석은 Babel 의 스코프 분석(path.scope.getBinding)을 쓴다 — import/지역 변수/인자/구조 분해를 정확히 구분한다.
 */
import { parse } from '@babel/parser';
import traverseModule, { NodePath, Binding } from '@babel/traverse';
import * as t from '@babel/types';
import { Val, lit, unknown, concat, alt } from './values';

// esbuild(cjs)·ts 모두에서 default export 를 안전하게 집는다
const traverse: typeof traverseModule = ((traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule);

export interface CallSite {
  callee: Val;
  args: Val[];
  line: number;
  col: number;
}

export interface FnSummary {
  id: string;
  /** 사람이 보는 이름: load, useOrder, methods.save, <setup> */
  name: string;
  line: number;
  col: number;
  params: string[];
  /** 기본 인자값 (없으면 null) */
  paramDefaults: (Val | null)[];
  calls: CallSite[];
  /** return 값 (여러 개면 alt). 없으면 null */
  returns: Val | null;
}

export interface ModuleFlow {
  file: string;
  fns: Map<string, FnSummary>;
  /** export 이름 → 값. default 포함 */
  exports: Record<string, Val>;
  /** 컴포넌트일 때 분석을 시작할 함수들 (setup 본문, 최상위 함수, methods/hooks) */
  entries: string[];
  /** Options API 의 this.x 해석용 (methods·computed·setup 반환) */
  thisMembers: Record<string, Val>;
  warnings: string[];
}

export interface SummaryOptions {
  file: string;
  lang: 'ts' | 'js';
  jsx?: boolean;
  /** Babel 의 1번째 줄이 파일의 몇 번째 줄인지 (1부터). .vue 블록용 */
  startLine?: number;
  /** <script setup> 또는 컴포넌트 모듈인가 (entries 계산) */
  isComponent?: boolean;
  isSetup?: boolean;
}

const HOOKS = new Set([
  'setup', 'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated', 'beforeUnmount', 'unmounted',
  'beforeDestroy', 'destroyed', 'activated', 'deactivated', 'errorCaptured',
]);

type FnNode = t.Function;

export function summarizeModule(code: string, opts: SummaryOptions): ModuleFlow {
  const mod: ModuleFlow = { file: opts.file, fns: new Map(), exports: {}, entries: [], thisMembers: {}, warnings: [] };
  let ast: t.File;
  try {
    const plugins: ('typescript' | 'jsx' | 'decorators-legacy')[] = ['decorators-legacy'];
    if (opts.lang === 'ts') plugins.push('typescript');
    if (opts.jsx || opts.lang === 'js') plugins.push('jsx');
    ast = parse(code, {
      sourceType: 'module', plugins, errorRecovery: true, allowReturnOutsideFunction: true,
      startLine: opts.startLine ?? 1,
    });
  } catch (e) {
    mod.warnings.push(`흐름 분석용 파싱 실패: ${(e as Error).message}`);
    return mod;
  }

  // ── 1) 이름 붙은 함수에 id 부여
  const fnIds = new Map<FnNode, string>();
  const fnNames = new Map<FnNode, string>();
  const fnPaths = new Map<FnNode, NodePath<FnNode>>();
  const usedIds = new Set<string>();
  const assign = (p: NodePath<FnNode>, name: string) => {
    if (fnIds.has(p.node)) return;
    let id = `${name}@${p.node.loc?.start.line ?? 0}`;
    while (usedIds.has(id)) id += "'";
    usedIds.add(id);
    fnIds.set(p.node, id);
    fnNames.set(p.node, name);
    fnPaths.set(p.node, p);
  };

  // TS enum 은 Babel 스코프에 바인딩이 없다 → 이름 → 멤버 객체로 미리 모아 둔다 (enum ApiPath { LIST = '/x' })
  const enums = new Map<string, Val>();
  traverse(ast, {
    Function(p) {
      const name = namedFunction(p);
      if (name !== null) assign(p, name);
    },
    TSEnumDeclaration(p) {
      const members: Record<string, Val> = {};
      const body = (p.node as unknown as { members?: t.TSEnumMember[]; body?: { members: t.TSEnumMember[] } });
      for (const m of body.members ?? body.body?.members ?? []) {
        const k = t.isIdentifier(m.id) ? m.id.name : m.id.value;
        members[k] = m.initializer && t.isStringLiteral(m.initializer) ? lit(m.initializer.value) : m.initializer && t.isNumericLiteral(m.initializer) ? lit(String(m.initializer.value)) : unknown(`enum ${k}`);
      }
      enums.set(p.node.id.name, { k: 'obj', members });
    },
  });
  /** 변수 바인딩 → 값 메모 (같은 변수를 여러 번 참조해도 한 번만 계산, 자기 참조 대입은 unknown) */
  const bindingMemo = new Map<Binding, Val>();
  const bindingInProgress = new Set<Binding>();
  const selfReferenced = new Set<Binding>();

  // ── 2) 각 함수 요약
  for (const [node, id] of fnIds) {
    const p = fnPaths.get(node)!;
    mod.fns.set(id, summarizeFn(p, id, fnNames.get(node)!));
  }

  // 3) 가상 함수 <setup> / <module>: 최상위 문장의 호출
  const programPath = getProgramPath(ast);
  const topName = opts.isSetup ? '<setup>' : '<module>';
  const topId = topName;
  mod.fns.set(topId, summarizeBody(programPath, topId, topName, [], null));

  // ── 4) export · 컴포넌트 옵션 · entries
  collectExports(programPath, mod);
  // Pinia options 스토어: actions 안의 this.otherAction() 해석용
  programPath.traverse({
    CallExpression(p) {
      const cal = p.node.callee;
      if (!t.isIdentifier(cal) || cal.name !== 'defineStore') return;
      const a1 = p.get('arguments.1') as NodePath | undefined;
      if (!a1?.isObjectExpression()) return;
      for (const [key, valPath] of objectMembers(a1)) {
        if ((key === 'actions' || key === 'getters') && valPath.isObjectExpression()) {
          for (const [k2, v2] of objectMembers(valPath)) mod.thisMembers[k2] ??= valueOfPath(v2, null);
        }
      }
    },
  });
  if (opts.isComponent) {
    mod.entries.push(topId);
    // 최상위에서 이름 붙은 함수들 (script setup 의 함수는 템플릿에서 불린다)
    for (const [node, id] of fnIds) {
      const p = fnPaths.get(node)!;
      if (isTopLevelBinding(p)) mod.entries.push(id);
    }
    // Options API / defineComponent: methods·hooks·setup
    const options = findOptionsObject(programPath);
    if (options) {
      const members = objectMembers(options);
      for (const [key, valPath] of members) {
        if (key === 'methods' || key === 'computed' || key === 'watch') {
          if (valPath.isObjectExpression()) {
            for (const [k2, v2] of objectMembers(valPath)) {
              const v = valueOfPath(v2, null);
              if (key !== 'watch') mod.thisMembers[k2] = v;
              if (v.k === 'fn' && (key === 'methods' || key === 'watch')) mod.entries.push(v.id);
            }
          }
        } else if (HOOKS.has(key)) {
          const v = valueOfPath(valPath, null);
          if (v.k === 'fn') {
            mod.entries.push(v.id);
            if (key === 'setup') {
              // setup() 이 돌려준 객체의 멤버도 this.x 로 접근된다
              const ret = mod.fns.get(v.id)?.returns;
              if (ret?.k === 'obj') for (const [mk, mv] of Object.entries(ret.members)) mod.thisMembers[mk] ??= mv;
            }
          }
        }
      }
    }
    mod.entries = [...new Set(mod.entries)];
  }
  return mod;

  // ───────────────────────── helpers (클로저: fnIds 등 접근) ─────────────────────────

  /** 이름이 붙은 함수면 그 이름, 아니면 null (익명 콜백) */
  function namedFunction(p: NodePath<FnNode>): string | null {
    const n = p.node;
    if (t.isFunctionDeclaration(n)) return n.id?.name ?? 'default';
    if (t.isObjectMethod(n) || t.isClassMethod(n)) return keyName(n.key, n.computed) ?? null;
    const parent = p.parentPath;
    if (!parent) return null;
    if (parent.isVariableDeclarator() && parent.node.init === n && t.isIdentifier(parent.node.id)) return parent.node.id.name;
    if (parent.isObjectProperty() && parent.node.value === n) return keyName(parent.node.key, parent.node.computed);
    if (parent.isClassProperty() && parent.node.value === n) return keyName(parent.node.key, parent.node.computed);
    if (parent.isExportDefaultDeclaration()) return 'default';
    if (parent.isAssignmentExpression() && parent.node.right === n) {
      const l = parent.node.left;
      if (t.isIdentifier(l)) return l.name;
      if (t.isMemberExpression(l) && t.isIdentifier(l.property)) return l.property.name;
    }
    // defineStore('id', () => {...}) / defineStore('id', { actions })
    if (parent.isCallExpression() && t.isIdentifier(parent.node.callee) && parent.node.callee.name === 'defineStore' && parent.node.arguments[1] === n) {
      const a0 = parent.node.arguments[0];
      return `store:${t.isStringLiteral(a0) ? a0.value : '?'}`;
    }
    return null;
  }

  function summarizeFn(p: NodePath<FnNode>, id: string, name: string): FnSummary {
    const params = p.node.params.map((prm) => (t.isIdentifier(prm) ? prm.name : t.isAssignmentPattern(prm) && t.isIdentifier(prm.left) ? prm.left.name : '?'));
    const paramPaths = p.get('params') as NodePath[];
    const defaults = paramPaths.map((pp) => (pp.isAssignmentPattern() ? valueOfPath(pp.get('right') as NodePath, { ownFn: p.node, params }) : null));
    const bodyPath = p.get('body') as NodePath;
    const returnsExpr = !t.isBlockStatement(p.node.body) ? (p.get('body') as NodePath<t.Expression>) : null;
    const sum = summarizeBody(bodyPath, id, name, params, returnsExpr, p);
    sum.paramDefaults = defaults;
    return sum;
  }

  /** scopeRoot 안의 호출·return 을 모은다. 안쪽의 "이름 붙은 함수"는 건너뛴다 (자기 요약이 있음) */
  function summarizeBody(root: NodePath, id: string, name: string, params: string[], exprBody: NodePath<t.Expression> | null, fnPath?: NodePath<FnNode>): FnSummary {
    const calls: CallSite[] = [];
    const rets: Val[] = [];
    const ownFn = fnPath?.node;
    const ctx: ValCtx = { ownFn: ownFn ?? null, params };
    const visit = (p: NodePath) => {
      if (p.isFunction()) {
        if (p.node !== ownFn && fnIds.has(p.node)) return p.skip();
      }
      if (p.isCallExpression() || p.isOptionalCallExpression() || p.isNewExpression()) {
        const callee = p.get('callee') as NodePath;
        const args = (p.get('arguments') as NodePath[]).map((a) => argValue(a, ctx));
        const cv = p.isNewExpression() ? newValue(callee, ctx) : valueOfPath(callee, ctx);
        calls.push({ callee: cv, args, line: p.node.loc?.start.line ?? 0, col: (p.node.loc?.start.column ?? 0) + 1 });
      }
      if (p.isReturnStatement() && p.node.argument) {
        if (p.getFunctionParent()?.node === ownFn) rets.push(valueOfPath(p.get('argument') as NodePath, ctx));
      }
    };
    if (root.isProgram() || root.isBlockStatement()) {
      root.traverse({ enter: visit });
    } else {
      // 식 본문 화살표: 본문 자체도 방문
      visit(root);
      root.traverse({ enter: visit });
    }
    if (exprBody) rets.push(valueOfPath(exprBody, ctx));
    const loc = (fnPath ?? root).node.loc?.start;
    return { id, name, line: loc?.line ?? 1, col: (loc?.column ?? 0) + 1, params, paramDefaults: params.map(() => null), calls, returns: rets.length ? alt(rets) : null };
  }

  interface ValCtx {
    ownFn: FnNode | null;
    params: string[];
  }

  /** 호출 인자: 함수면 '콜백' (요약하지 않음 — 그 안의 호출은 바깥 함수에 귀속) */
  function argValue(a: NodePath, ctx: ValCtx): Val {
    if (a.isFunction() && !fnIds.has(a.node)) return unknown('콜백');
    if (a.isSpreadElement()) return unknown('spread 인자');
    return valueOfPath(a, ctx);
  }

  function newValue(callee: NodePath, ctx: ValCtx): Val {
    if (callee.isIdentifier() && callee.node.name === 'XMLHttpRequest') return { k: 'sink', sink: 'xhr' };
    return { k: 'call', callee: valueOfPath(callee, ctx), args: [] };
  }

  function valueOfPath(p: NodePath, ctx: ValCtx | null, depth = 0): Val {
    const c: ValCtx = ctx ?? { ownFn: null, params: [] };
    if (depth > 12) return unknown('너무 깊은 참조');
    const n = p.node;
    if (t.isStringLiteral(n)) return lit(n.value);
    if (t.isNumericLiteral(n)) return lit(String(n.value));
    if (t.isTemplateLiteral(n)) {
      const parts: Val[] = [];
      n.quasis.forEach((q, i) => {
        parts.push(lit(q.value.cooked ?? q.value.raw));
        if (i < n.expressions.length) parts.push(valueOfPath(p.get(`expressions.${i}`) as NodePath, c, depth + 1));
      });
      return concat(parts);
    }
    if (t.isBinaryExpression(n) && n.operator === '+') {
      return concat([valueOfPath(p.get('left') as NodePath, c, depth + 1), valueOfPath(p.get('right') as NodePath, c, depth + 1)]);
    }
    if (t.isAwaitExpression(n)) return valueOfPath(p.get('argument') as NodePath, c, depth + 1);
    if (t.isTSAsExpression(n) || t.isTSNonNullExpression(n) || t.isParenthesizedExpression(n) || t.isTSSatisfiesExpression(n) || t.isTSTypeAssertion(n)) {
      return valueOfPath(p.get('expression') as NodePath, c, depth + 1);
    }
    if (t.isConditionalExpression(n)) {
      return alt([valueOfPath(p.get('consequent') as NodePath, c, depth + 1), valueOfPath(p.get('alternate') as NodePath, c, depth + 1)]);
    }
    if (t.isLogicalExpression(n)) {
      const l = valueOfPath(p.get('left') as NodePath, c, depth + 1);
      const r = valueOfPath(p.get('right') as NodePath, c, depth + 1);
      return n.operator === '&&' ? r : alt([l, r]);
    }
    if (t.isThisExpression(n)) return { k: 'this' };
    if (t.isObjectExpression(n)) {
      const members: Record<string, Val> = {};
      for (const [k, v] of objectMembers(p as NodePath<t.ObjectExpression>)) members[k] = valueOfPath(v, c, depth + 1);
      return { k: 'obj', members };
    }
    if (t.isArrayExpression(n)) return unknown('배열');
    if (p.isFunction()) {
      const id = fnIds.get(p.node);
      return id ? { k: 'fn', id } : unknown('익명 함수');
    }
    if (t.isMetaProperty(n)) return { k: 'ext', source: 'import.meta', path: [] };
    if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) {
      const prop = n.computed
        ? (t.isStringLiteral(n.property) ? n.property.value : t.isNumericLiteral(n.property) ? String(n.property.value) : null)
        : t.isIdentifier(n.property) ? n.property.name : null;
      const base = valueOfPath(p.get('object') as NodePath, c, depth + 1);
      if (prop === null) return unknown(`동적 속성 ${describeShort(base)}[…]`);
      if (base.k === 'ext' && base.source === 'import.meta') {
        // import.meta.env.VITE_X
        return base.path.length === 0 && prop === 'env' ? { k: 'ext', source: 'import.meta', path: ['env'] } : unknown(`환경변수 ${prop}`);
      }
      if (base.k === 'ext' && base.source === 'global' && base.path[0] === 'process') return unknown(`환경변수 ${prop}`);
      const obj = n.object;
      const hint = t.isIdentifier(obj) ? obj.name : t.isThisExpression(obj) ? 'this' : t.isMemberExpression(obj) && t.isIdentifier(obj.property) ? obj.property.name : undefined;
      return hint ? { k: 'member', base, prop, hint } : { k: 'member', base, prop };
    }
    if (t.isCallExpression(n) || t.isOptionalCallExpression(n)) {
      const callee = p.get('callee') as NodePath;
      const args = (p.get('arguments') as NodePath[]).map((a) => argValue(a, c));
      return { k: 'call', callee: valueOfPath(callee, c, depth + 1), args };
    }
    if (t.isNewExpression(n)) return newValue(p.get('callee') as NodePath, c);
    if (t.isIdentifier(n)) return identifierValue(p as NodePath<t.Identifier>, c, depth);
    if (t.isNullLiteral(n)) return unknown('null');
    return unknown(`식 ${n.type}`);
  }

  function identifierValue(p: NodePath<t.Identifier>, c: ValCtx, depth: number): Val {
    const name = p.node.name;
    if (name === 'undefined') return unknown('undefined');
    const b: Binding | undefined = p.scope.getBinding(name);
    if (!b) {
      const en = enums.get(name);
      if (en) return en;
      if (name === 'fetch' || name === '$fetch' || name === 'useFetch') return { k: 'sink', sink: name };
      if (name === 'axios') return { k: 'sink', sink: 'axios' };
      return { k: 'ext', source: 'global', path: [name] };
    }
    switch (b.kind) {
      case 'module': {
        const bp = b.path;
        const decl = bp.parentPath;
        if (!decl || !decl.isImportDeclaration()) return unknown(`import ${name}`);
        const source = decl.node.source.value;
        if (bp.isImportDefaultSpecifier()) return { k: 'import', source, imported: 'default' };
        if (bp.isImportNamespaceSpecifier()) return { k: 'import', source, imported: '*' };
        if (bp.isImportSpecifier()) {
          const im = bp.node.imported;
          return { k: 'import', source, imported: t.isIdentifier(im) ? im.name : im.value };
        }
        return unknown(`import ${name}`);
      }
      case 'param': {
        const fn = b.path.getFunctionParent()?.node ?? (b.path.isFunction() ? b.path.node : null);
        if (fn && fn === c.ownFn) {
          const i = c.params.indexOf(name);
          if (i >= 0) return { k: 'param', i, name };
          return unknown(`구조 분해 인자 ${name}`);
        }
        if (fn && fnIds.has(fn)) return unknown(`바깥 함수 인자 ${name}`);
        return unknown(`콜백 인자 ${name}`);
      }
      case 'hoisted':
      case 'local': {
        if (b.path.isFunction()) {
          const id = fnIds.get(b.path.node);
          return id ? { k: 'fn', id } : unknown(`함수 ${name}`);
        }
        return unknown(`${name}`);
      }
      case 'const':
      case 'let':
      case 'var': {
        const d = b.path;
        if (!d.isVariableDeclarator()) return unknown(name);
        const memo = bindingMemo.get(b);
        if (memo) return memo;
        if (bindingInProgress.has(b)) {
          selfReferenced.add(b); // u = u + '&a=' + x 처럼 자기 자신을 참조하는 누적 대입
          return unknown(`누적 대입 ${name}`);
        }
        bindingInProgress.add(b);
        const init = d.get('init') as NodePath;
        const idNode = d.node.id;
        let v: Val;
        if (!d.node.init) v = unknown(`초기값 없는 ${name}`);
        else if (t.isIdentifier(idNode)) v = valueOfPath(init, c, depth + 1);
        else v = destructured(idNode as t.Node, name, valueOfPath(init, c, depth + 1));
        // let 에 다시 대입한 값들: `=` 는 후보 추가, `+=` 는 이어 붙이기, 그 밖의 복합 대입은 unknown
        for (const cv of b.constantViolations) {
          if (!cv.isAssignmentExpression() || !t.isIdentifier(cv.node.left) || cv.node.left.name !== name) continue;
          const rhs = valueOfPath(cv.get('right') as NodePath, c, depth + 1);
          if (cv.node.operator === '=') v = alt([v, rhs]);
          else if (cv.node.operator === '+=') v = alt([v, concat([v, rhs])]);
          else v = unknown(`${cv.node.operator} 대입 ${name}`);
        }
        bindingInProgress.delete(b);
        if (selfReferenced.has(b)) v = unknown(`누적 대입 ${name} (실행 중에 만들어지는 값)`);
        bindingMemo.set(b, v);
        return v;
      }
      default:
        return unknown(name);
    }
  }

  /** const { a, b: c } = X / const [x] = X 에서 name 이 어느 멤버인지 */
  function destructured(pattern: t.Node, name: string, base: Val): Val {
    const find = (pat: t.Node, path: string[]): string[] | null => {
      if (t.isIdentifier(pat)) return pat.name === name ? path : null;
      if (t.isObjectPattern(pat)) {
        for (const prop of pat.properties) {
          if (t.isRestElement(prop)) continue;
          const key = keyName(prop.key, prop.computed);
          if (key === null) continue;
          const r = find(prop.value, [...path, key]);
          if (r) return r;
        }
      } else if (t.isArrayPattern(pat)) {
        for (let i = 0; i < pat.elements.length; i++) {
          const el = pat.elements[i];
          if (el) {
            const r = find(el, [...path, String(i)]);
            if (r) return r;
          }
        }
      } else if (t.isAssignmentPattern(pat)) {
        return find(pat.left, path);
      }
      return null;
    };
    const path = find(pattern, []);
    if (!path) return unknown(`구조 분해 ${name}`);
    return path.reduce<Val>((acc, prop) => ({ k: 'member', base: acc, prop }), base);
  }

  function isTopLevelBinding(p: NodePath<FnNode>): boolean {
    if (p.isFunctionDeclaration()) return p.parentPath?.isProgram() || p.parentPath?.isExportNamedDeclaration() || p.parentPath?.isExportDefaultDeclaration() || false;
    const vd = p.parentPath;
    if (vd?.isVariableDeclarator()) {
      const decl = vd.parentPath;
      return decl?.parentPath?.isProgram() || decl?.parentPath?.isExportNamedDeclaration() || false;
    }
    return false;
  }

  function collectExports(program: NodePath<t.Program>, m: ModuleFlow) {
    for (const st of program.get('body')) {
      if (st.isExportNamedDeclaration()) {
        const decl = st.get('declaration') as NodePath;
        if (decl.isVariableDeclaration()) {
          for (const d of decl.get('declarations')) {
            if (t.isIdentifier(d.node.id)) m.exports[d.node.id.name] = valueOfPath(d.get('id') as NodePath, null);
          }
        } else if (decl.isFunctionDeclaration() && decl.node.id) {
          const id = fnIds.get(decl.node);
          if (id) m.exports[decl.node.id.name] = { k: 'fn', id };
        } else if (decl.isTSEnumDeclaration()) {
          const en = enums.get(decl.node.id.name);
          if (en) m.exports[decl.node.id.name] = en;
        } else if (decl.isClassDeclaration()) {
          /* 클래스는 미지원 */
        }
        const src = st.node.source?.value;
        for (const sp of st.get('specifiers')) {
          if (sp.isExportSpecifier()) {
            const exported = t.isIdentifier(sp.node.exported) ? sp.node.exported.name : sp.node.exported.value;
            if (src) m.exports[exported] = { k: 'import', source: src, imported: sp.node.local.name };
            else m.exports[exported] = valueOfPath(sp.get('local') as NodePath, null);
          } else if (sp.isExportNamespaceSpecifier() && src) {
            const ex = sp.node.exported as t.Identifier | t.StringLiteral;
            const exported = t.isIdentifier(ex) ? ex.name : ex.value;
            m.exports[exported] = { k: 'import', source: src, imported: '*' };
          }
        }
      } else if (st.isExportDefaultDeclaration()) {
        const decl = st.get('declaration') as NodePath;
        if (decl.isFunctionDeclaration() || decl.isFunctionExpression() || decl.isArrowFunctionExpression()) {
          const id = fnIds.get(decl.node as FnNode);
          m.exports.default = id ? { k: 'fn', id } : unknown('default 함수');
        } else if (decl.isExpression()) {
          m.exports.default = valueOfPath(decl, null);
        }
      } else if (st.isExportAllDeclaration()) {
        m.exports[`*${st.node.source.value}`] = { k: 'import', source: st.node.source.value, imported: '*' };
      }
    }
  }

  /** export default { … } / export default defineComponent({ … }) 의 옵션 객체 */
  function findOptionsObject(program: NodePath<t.Program>): NodePath<t.ObjectExpression> | null {
    for (const st of program.get('body')) {
      if (!st.isExportDefaultDeclaration()) continue;
      const d = st.get('declaration') as NodePath;
      if (d.isObjectExpression()) return d;
      if (d.isCallExpression()) {
        const a0 = d.get('arguments.0') as NodePath | undefined;
        if (a0?.isObjectExpression()) return a0;
      }
    }
    return null;
  }
}

/** 객체 리터럴의 (키, 값 경로) 목록. 메서드는 값 경로가 메서드 자신 */
function objectMembers(obj: NodePath<t.ObjectExpression>): [string, NodePath][] {
  const out: [string, NodePath][] = [];
  obj.get('properties').forEach((prop) => {
    if (prop.isObjectProperty()) {
      const k = keyName(prop.node.key, prop.node.computed);
      if (k !== null) out.push([k, prop.get('value') as NodePath]);
    } else if (prop.isObjectMethod()) {
      const k = keyName(prop.node.key, prop.node.computed);
      if (k !== null) out.push([k, prop as NodePath]);
    }
  });
  return out;
}

function keyName(key: t.Node, computed: boolean): string | null {
  if (!computed && t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return null;
}

function getProgramPath(ast: t.File): NodePath<t.Program> {
  let out: NodePath<t.Program> | null = null;
  traverse(ast, {
    Program(p) {
      out = p;
      p.stop();
    },
  });
  return out!;
}

function describeShort(v: Val): string {
  return v.k === 'member' ? `${describeShort(v.base)}.${v.prop}` : v.k === 'import' ? v.imported : v.k === 'lit' ? JSON.stringify(v.s) : v.k;
}
