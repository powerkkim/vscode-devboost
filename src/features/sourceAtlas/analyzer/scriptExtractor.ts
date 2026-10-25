import { parse } from '@babel/parser';
import type { Certainty } from './types';

export interface ImportInfo {
  local: string;
  imported: string;
  source: string;
  line: number;
}
export interface PropInfo {
  name: string;
  type?: string;
  required?: boolean;
}
export interface ApiCallInfo {
  method: string;
  url: string;
  via: 'axios' | 'fetch' | 'custom';
  certainty: Certainty;
  line: number;
  col: number;
  /** 호출을 감싸고 있는 함수 이름 (addItem 등). 최상위면 undefined */
  fn?: string;
}
export interface UseCall {
  name: string;
  line: number;
}

export type ScriptStyle = 'script-setup' | 'define-component' | 'options' | 'module' | 'unknown';

export interface ScriptInfo {
  style: ScriptStyle;
  lang: 'ts' | 'js';
  imports: ImportInfo[];
  dynamicImports: { source: string | null; line: number }[];
  props: PropInfo[];
  emits: string[];
  uses: UseCall[];
  apis: ApiCallInfo[];
  refs: string[];
  computed: string[];
  watchers: string[];
  /** components: { Foo } 옵션 → { 태그/키: 로컬 식별자 } */
  registered: Record<string, string>;
  /** defineStore('id') 로 정의된 스토어 id */
  storeDefs: string[];
  warnings: string[];
  /** 심볼 위치: "refs:loading" → { line, col } (파일 기준). 화면에서 클릭 이동용 */
  locs: Record<string, SymLoc>;
}
export interface SymLoc {
  line: number;
  col: number;
}

export function emptyScriptInfo(lang: 'ts' | 'js' = 'js'): ScriptInfo {
  return {
    style: 'unknown', lang, imports: [], dynamicImports: [], props: [], emits: [], uses: [], apis: [],
    refs: [], computed: [], watchers: [], registered: {}, storeDefs: [], warnings: [], locs: {},
  };
}

/** 여러 script 블록(<script> + <script setup>)의 결과를 합친다 */
export function mergeScriptInfo(a: ScriptInfo, b: ScriptInfo): ScriptInfo {
  const uniq = <T>(arr: T[]) => Array.from(new Set(arr));
  const byName = <T extends { name: string }>(arr: T[]) => {
    const seen = new Set<string>();
    return arr.filter((x) => !seen.has(x.name) && !!seen.add(x.name));
  };
  return {
    style: b.style === 'script-setup' || a.style === 'unknown' ? b.style : a.style,
    lang: a.lang === 'ts' || b.lang === 'ts' ? 'ts' : 'js',
    imports: [...a.imports, ...b.imports],
    dynamicImports: [...a.dynamicImports, ...b.dynamicImports],
    props: byName([...a.props, ...b.props]),
    emits: uniq([...a.emits, ...b.emits]),
    uses: byName([...a.uses, ...b.uses]),
    apis: [...a.apis, ...b.apis],
    refs: uniq([...a.refs, ...b.refs]),
    computed: uniq([...a.computed, ...b.computed]),
    watchers: uniq([...a.watchers, ...b.watchers]),
    registered: { ...a.registered, ...b.registered },
    storeDefs: uniq([...a.storeDefs, ...b.storeDefs]),
    warnings: uniq([...a.warnings, ...b.warnings]),
    locs: { ...b.locs, ...a.locs },
  };
}

export interface ExtractOptions {
  lang: 'ts' | 'js';
  /** <script setup> 블록인가 */
  isSetup?: boolean;
  /** 순수 모듈(.ts/.js 파일: composable·store) 인가 */
  isModule?: boolean;
  /** babel 의 1번째 줄이 파일의 몇 번째 줄인지 - 1 */
  lineOffset?: number;
  jsx?: boolean;
}

const REF_FNS = new Set(['ref', 'shallowRef', 'reactive', 'shallowReactive', 'toRef', 'toRefs', 'customRef']);
const WATCH_FNS = new Set(['watch', 'watchEffect', 'watchPostEffect', 'watchSyncEffect']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const API_RECEIVER = /api|http|request|client|service|axios/i;

export function extractScript(code: string, opts: ExtractOptions): ScriptInfo {
  const info = emptyScriptInfo(opts.lang);
  const off = opts.lineOffset ?? 0;
  let ast: any;
  try {
    const plugins: any[] = opts.lang === 'ts' ? ['typescript'] : [];
    if (opts.jsx || opts.lang === 'js') {
      plugins.push('jsx');
    }
    ast = parse(code, { sourceType: 'module', plugins, errorRecovery: true, allowReturnOutsideFunction: true });
  } catch (e) {
    info.warnings.push(`script 파싱 실패: ${(e as Error).message}`);
    return info;
  }
  if (ast.errors?.length) {
    info.warnings.push(`script 파싱 경고 ${ast.errors.length}건 (일부 정보가 누락될 수 있음)`);
  }
  const lineOf = (n: any): number => (n?.loc?.start?.line ?? 1) + off;
  const colOf = (n: any): number => (n?.loc?.start?.column ?? 0) + 1;
  const mark = (section: string, name: string, n: any) => {
    const k = `${section}:${name}`;
    if (n?.loc && !info.locs[k]) info.locs[k] = { line: lineOf(n), col: colOf(n) };
  };
  let currentFn: string | undefined; // 지금 순회 중인 함수 이름 (API 호출 위치 표시용)
  const text = (n: any): string => (n && n.start != null ? code.slice(n.start, n.end) : '');

  // ── 1차: 최상위 import 와 같은 파일 안의 타입 선언을 모은다
  const localTypes = new Map<string, any>(); // interface/type alias → 멤버를 가진 노드
  const importedLocals = new Map<string, ImportInfo>();
  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (stmt.type === 'ImportDeclaration' && stmt.importKind !== 'type') {
      for (const sp of stmt.specifiers) {
        if (sp.importKind === 'type') {
          continue;
        }
        const imported =
          sp.type === 'ImportDefaultSpecifier' ? 'default'
          : sp.type === 'ImportNamespaceSpecifier' ? '*'
          : sp.imported?.name ?? sp.imported?.value ?? sp.local.name;
        const ii: ImportInfo = { local: sp.local.name, imported, source: stmt.source.value, line: lineOf(stmt) };
        info.imports.push(ii);
        importedLocals.set(ii.local, ii);
      }
    } else if (decl.type === 'TSInterfaceDeclaration') {
      localTypes.set(decl.id.name, decl.body);
    } else if (decl.type === 'TSTypeAliasDeclaration') {
      localTypes.set(decl.id.name, decl.typeAnnotation);
    }
  }

  // ── props / emits 헬퍼
  const keyName = (k: any): string | null =>
    k?.type === 'Identifier' ? k.name : k?.type === 'StringLiteral' ? k.value : null;

  const typeMembers = (t: any, what: string, seen = new Set<string>()): any[] | null => {
    if (!t) {
      return null;
    }
    if (t.type === 'TSTypeLiteral') {
      return t.members;
    }
    if (t.type === 'TSInterfaceBody') {
      return t.body;
    }
    if (t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier') {
      const n = t.typeName.name;
      if (localTypes.has(n) && !seen.has(n)) {
        seen.add(n);
        return typeMembers(localTypes.get(n), what, seen);
      }
      info.warnings.push(`${what} 타입 '${n}' 을(를) 같은 파일에서 찾지 못함 (import 타입은 미지원)`);
      return null;
    }
    return null;
  };

  const addProp = (p: PropInfo, at?: any) => {
    if (!info.props.some((x) => x.name === p.name)) {
      info.props.push(p);
    }
    mark('props', p.name, at);
  };
  const addEmit = (n: string, at?: any) => {
    if (!info.emits.includes(n)) {
      info.emits.push(n);
    }
    mark('emits', n, at);
  };

  const propsFromType = (t: any) => {
    for (const m of typeMembers(t, 'props') ?? []) {
      if (m.type === 'TSPropertySignature') {
        const name = keyName(m.key);
        if (name) {
          addProp({ name, type: text(m.typeAnnotation?.typeAnnotation) || undefined, required: !m.optional }, m);
        }
      }
    }
  };
  const propsFromRuntime = (n: any) => {
    if (n?.type === 'ArrayExpression') {
      n.elements.forEach((e: any) => e?.type === 'StringLiteral' && addProp({ name: e.value }, e));
    } else if (n?.type === 'ObjectExpression') {
      for (const p of n.properties) {
        const name = keyName(p.key);
        if (!name || p.type === 'SpreadElement') {
          continue;
        }
        const v = p.value;
        if (v?.type === 'Identifier') {
          addProp({ name, type: v.name }, p);
        } else if (v?.type === 'ArrayExpression') {
          addProp({ name, type: v.elements.map((e: any) => text(e)).join('|') }, p);
        } else if (v?.type === 'ObjectExpression') {
          const tp = v.properties.find((q: any) => keyName(q.key) === 'type');
          const rq = v.properties.find((q: any) => keyName(q.key) === 'required');
          addProp({
            name,
            type: tp ? (tp.value.type === 'ArrayExpression' ? tp.value.elements.map((e: any) => text(e)).join('|') : text(tp.value)) : undefined,
            required: rq?.value?.type === 'BooleanLiteral' ? rq.value.value : false,
          }, p);
        } else {
          addProp({ name }, p);
        }
      }
    }
  };
  const emitsFromRuntime = (n: any) => {
    if (n?.type === 'ArrayExpression') {
      n.elements.forEach((e: any) => e?.type === 'StringLiteral' && addEmit(e.value, e));
    } else if (n?.type === 'ObjectExpression') {
      n.properties.forEach((p: any) => {
        const name = keyName(p.key);
        if (name) {
          addEmit(name, p);
        }
      });
    }
  };
  const emitsFromType = (t: any) => {
    for (const m of typeMembers(t, 'emits') ?? []) {
      if (m.type === 'TSCallSignatureDeclaration') {
        const first = (m.parameters ?? m.params ?? [])[0];
        const lit = first?.typeAnnotation?.typeAnnotation;
        if (lit?.type === 'TSLiteralType' && lit.literal?.type === 'StringLiteral') {
          addEmit(lit.literal.value, m);
        }
      } else if (m.type === 'TSPropertySignature') {
        const name = keyName(m.key);
        if (name) {
          addEmit(name, m);
        }
      }
    }
  };

  const handleOptions = (obj: any) => {
    for (const p of obj.properties ?? []) {
      const name = keyName(p.key);
      if (name === 'props') {
        propsFromRuntime(p.value);
      } else if (name === 'emits') {
        emitsFromRuntime(p.value);
      } else if (name === 'components' && p.value?.type === 'ObjectExpression') {
        for (const c of p.value.properties) {
          const k = keyName(c.key);
          if (k && c.value?.type === 'Identifier') {
            info.registered[k] = c.value.name;
          }
        }
      }
    }
  };

  const urlOf = (n: any): string => {
    if (n?.type === 'StringLiteral') {
      return n.value;
    }
    if (n?.type === 'TemplateLiteral') {
      return n.quasis.map((q: any, i: number) => q.value.cooked + (i < n.expressions.length ? '{}' : '')).join('');
    }
    return '?';
  };

  // ── 2차: 전체 순회
  const visit = (node: any, parent: any) => {
    if (!node || typeof node.type !== 'string') {
      return;
    }
    switch (node.type) {
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if (d?.type === 'ObjectExpression') {
          info.style = 'options';
          handleOptions(d);
        } else if (d?.type === 'CallExpression' && d.callee?.name === 'defineComponent') {
          info.style = 'define-component';
          if (d.arguments[0]?.type === 'ObjectExpression') {
            handleOptions(d.arguments[0]);
          }
        }
        break;
      }
      case 'ImportExpression': {
        info.dynamicImports.push({ source: node.source?.type === 'StringLiteral' ? node.source.value : null, line: lineOf(node) });
        break;
      }
      case 'CallExpression': {
        const c = node.callee;
        if (c?.type === 'Import') {
          const a = node.arguments[0];
          info.dynamicImports.push({ source: a?.type === 'StringLiteral' ? a.value : null, line: lineOf(node) });
        } else if (c?.type === 'Identifier') {
          const fn = c.name;
          const declId = parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier' ? parent.id.name : null;
          if (fn === 'defineProps') {
            const tp = node.typeParameters?.params?.[0] ?? node.typeArguments?.params?.[0];
            if (tp) {
              propsFromType(tp);
            } else {
              propsFromRuntime(node.arguments[0]);
            }
          } else if (fn === 'defineEmits') {
            const tp = node.typeParameters?.params?.[0] ?? node.typeArguments?.params?.[0];
            if (tp) {
              emitsFromType(tp);
            } else {
              emitsFromRuntime(node.arguments[0]);
            }
          } else if (fn === 'defineStore') {
            const a = node.arguments[0];
            if (a?.type === 'StringLiteral') {
              info.storeDefs.push(a.value);
            }
          } else if (REF_FNS.has(fn) && declId) {
            info.refs.push(declId);
            mark('refs', declId, parent.id);
          } else if (fn === 'computed' && declId) {
            info.computed.push(declId);
            mark('computed', declId, parent.id);
          } else if (WATCH_FNS.has(fn)) {
            const a = node.arguments[0];
            const w = fn === 'watch' && a?.type === 'Identifier' ? a.name : fn === 'watch' ? text(a).slice(0, 40) || 'watch' : fn;
            info.watchers.push(w);
            mark('watchers', w, node);
          } else if (fn === 'fetch') {
            const opt = node.arguments[1];
            const m = opt?.type === 'ObjectExpression' ? opt.properties.find((q: any) => keyName(q.key) === 'method') : null;
            info.apis.push({
              method: (m?.value?.type === 'StringLiteral' ? m.value.value : 'GET').toUpperCase(),
              url: urlOf(node.arguments[0]), via: 'fetch', certainty: 'sure', line: lineOf(node), col: colOf(node), fn: currentFn,
            });
          } else if (/^use[A-Z]\w*$/.test(fn) && importedLocals.has(fn)) {
            if (!info.uses.some((u) => u.name === fn)) {
              info.uses.push({ name: fn, line: lineOf(node) });
            }
            mark('uses', fn, node);
          }
        } else if (c?.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier') {
          const method = c.property.name;
          const recv = c.object?.type === 'Identifier' ? c.object.name : null;
          if (recv && HTTP_METHODS.has(method) && (recv === 'axios' || API_RECEIVER.test(recv))) {
            const first = node.arguments[0];
            // api.get(변수) 처럼 URL 을 모르는 경우, 커스텀 래퍼는 노이즈가 커서 문자열일 때만 기록
            if (recv === 'axios' || first?.type === 'StringLiteral' || first?.type === 'TemplateLiteral') {
              info.apis.push({
                method: method.toUpperCase(), url: urlOf(first),
                via: recv === 'axios' ? 'axios' : 'custom',
                certainty: recv === 'axios' ? 'sure' : 'guess', line: lineOf(node), col: colOf(node), fn: currentFn,
              });
            }
          }
        }
        break;
      }
      default:
        break;
    }
    // 함수에 들어갈 때 이름을 기억: function f(){} / const f = () => {} / { f() {} } / f: function(){}
    const prevFn = currentFn;
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      currentFn = node.id.name;
    } else if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && parent) {
      const n =
        parent.type === 'VariableDeclarator' && parent.id?.type === 'Identifier' ? parent.id.name
        : (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') ? keyName(parent.key)
        : parent.type === 'AssignmentExpression' && parent.left?.type === 'MemberExpression' ? keyName(parent.left.property)
        : null;
      if (n) currentFn = n;
    } else if ((node.type === 'ObjectMethod' || node.type === 'ClassMethod') && keyName(node.key)) {
      currentFn = keyName(node.key)!;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
        continue;
      }
      const v = node[key];
      if (Array.isArray(v)) {
        v.forEach((x) => visit(x, node));
      } else if (v && typeof v.type === 'string') {
        visit(v, node);
      }
    }
    currentFn = prevFn;
  };
  visit(ast.program, null);

  if (opts.isSetup) {
    info.style = 'script-setup';
  } else if (opts.isModule) {
    info.style = 'module';
  }
  return info;
}
