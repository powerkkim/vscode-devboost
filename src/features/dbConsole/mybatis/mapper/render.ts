/**
 * MyBatis 동적 SQL 렌더러 (vscode 의존 없음).
 * mapper statement + 파라미터 값 + 분기 수동 지정 → 실행 가능한 SQL 과 "왜 이렇게 나왔는지" 정보.
 *
 * MyBatis 의 실제 동작을 따른다:
 *  - 조각들은 공백 하나로 이어 붙임 (DynamicContext)
 *  - <where>/<set>/<trim> 은 앞뒤를 trim 한 뒤 대문자로 비교해 prefixOverrides/suffixOverrides 제거
 *  - <foreach> 는 빈 목록이면 open/close 도 쓰지 않음, separator 는 내용이 있는 항목 앞에만
 *  - <choose> 는 처음 참인 <when> 하나, 없으면 <otherwise>
 */
import { XmlElement, XmlNode } from './xml';
import { MapperDoc, MapperStatement } from './mapperDoc';
import { evalOgnl, EvalEnv, OgnlUnsupported, truthy, referencedPaths } from './ognl';
import { toSqlLiteral, toRawText, describeValue, toBindValue } from './values';

export type BranchTag = 'if' | 'when' | 'otherwise' | 'foreach' | 'bind' | 'include';

export interface BranchInfo {
  key: string;
  tag: BranchTag;
  /** test 식, foreach 는 collection, include 는 refid */
  expr: string;
  file: string;
  line: number;
  start: number;
  end: number;
  /** 중첩 깊이 (화면 들여쓰기) */
  depth: number;
  /** 최종 상태 */
  on: boolean;
  /** auto: 식으로 결정 / manual: 사용자가 지정 / unknown: 식을 평가하지 못해 꺼 둠 */
  how: 'auto' | 'manual' | 'unknown';
  /** foreach 안에서 여러 번 평가된 경우: 참이 된 횟수 / 평가 횟수 */
  hits: number;
  evals: number;
  /** 평가 실패 이유, foreach 개수 같은 부가 설명 */
  note?: string;
}

export type BranchOverride = 'on' | 'off';

/** 다른 mapper 의 <sql> 조각 찾기: (namespace, id) → 조각과 그 문서 */
export type FragmentResolver = (namespace: string, id: string) => { el: XmlElement; doc: MapperDoc } | undefined;

export interface RenderOptions {
  /** literal: 값을 SQL 에 직접 넣음 / bind: :name 바인드 변수로 남김 */
  mode?: 'literal' | 'bind';
  overrides?: Record<string, BranchOverride>;
  resolveFragment?: FragmentResolver;
  databaseId?: string;
}

export interface BindVar {
  name: string;
  expr: string;
  value: unknown;
  /** 값 넣기 모드였다면 들어갔을 리터럴 (화면 표시용) */
  literal: string;
  /** VARIABLE 선언 타입 */
  varType: string;
  /** EXEC :name := <assign>; */
  assign: string;
}

export interface RenderResult {
  sql: string;
  branches: BranchInfo[];
  warnings: string[];
  binds: BindVar[];
}

interface Scope {
  vars: Map<string, unknown>;
  /** foreach item/index → 바인드 이름 접두어 (bind 모드용) */
  iter: Map<string, string>;
  parent?: Scope;
}

interface Ctx {
  doc: MapperDoc;
  props?: Map<string, string>;
  depth: number;
  includeDepth: number;
}

const WHERE_PREFIXES = ['AND ', 'OR ', 'AND\n', 'OR\n', 'AND\r', 'OR\r', 'AND\t', 'OR\t'];

const splitOverrides = (s: string | undefined) => (s ? s.split('|').filter((x) => x !== '').map((x) => x.toUpperCase()) : []);

/** TrimSqlNode 의 동작 그대로 */
export function applyTrim(body: string, prefix: string | undefined, prefixOverrides: string[], suffix: string | undefined, suffixOverrides: string[]): string {
  let sql = body.trim();
  if (sql.length === 0) return '';
  const upper = () => sql.toUpperCase();
  for (const p of prefixOverrides) {
    if (upper().startsWith(p)) {
      sql = sql.slice(p.trim().length).trimStart();
      break;
    }
  }
  if (prefix) sql = `${prefix} ${sql}`;
  for (const s of suffixOverrides) {
    if (upper().endsWith(s) || upper().endsWith(s.trim())) {
      sql = sql.slice(0, sql.length - s.trim().length).trimEnd();
      break;
    }
  }
  if (suffix) sql = `${sql} ${suffix}`;
  return sql;
}

const TOP_KEYWORD = /^(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|UNION(\s+ALL)?|MINUS|INTERSECT|INSERT|UPDATE|DELETE|MERGE|SET|VALUES|WITH|CONNECT\s+BY|START\s+WITH|OFFSET|FETCH)\b/i;
const LONE_KEYWORD = /^(SELECT(\s+DISTINCT)?|FROM|WHERE|SET|VALUES|AND|OR|IN|NOT\s+IN|ON)$/i;

/** 문자열 리터럴·주석 밖의 괄호 깊이 변화 */
function parenDelta(line: string): { delta: number; leadingClose: number } {
  const code = line.replace(/'(?:[^']|'')*'|--.*$|\/\*.*?\*\//g, '');
  let d = 0;
  for (const c of code) {
    if (c === '(') d++;
    else if (c === ')') d--;
  }
  return { delta: d, leadingClose: /^\)+/.exec(code.trim())?.[0].length ?? 0 };
}

/**
 * 렌더링 결과 정리. 태그마다 들여쓰기가 제각각이라 원본 들여쓰기는 버리고 다시 맞춘다.
 *  - 빈 줄 제거, 줄 안의 연속 공백 1칸 (따옴표 안은 그대로)
 *  - 'SELECT' 처럼 키워드만 있는 줄, '... IN' 다음의 '(...)' 은 한 줄로
 *  - SELECT/FROM/WHERE 같은 절은 왼쪽 끝, 나머지는 2칸, 괄호 안은 깊이만큼 더
 */
export function tidySql(sql: string): string {
  const raw = sql
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim().replace(/('(?:[^']|'')*')|[ \t]{2,}/g, (m, q) => (q ? q : ' ')))
    .filter((l) => l !== '');
  const lines: string[] = [];
  for (const l of raw) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && (LONE_KEYWORD.test(prev) || (/\b(NOT\s+)?IN$/i.test(prev) && l.startsWith('(')))) {
      lines[lines.length - 1] = `${prev} ${l}`;
    } else {
      lines.push(l);
    }
  }
  let depth = 0;
  return lines
    .map((l) => {
      const { delta, leadingClose } = parenDelta(l);
      const d = Math.max(0, depth - leadingClose);
      depth = Math.max(0, depth + delta);
      const base = TOP_KEYWORD.test(l) ? 0 : 2;
      return ' '.repeat(d * 4 + base) + l;
    })
    .join('\n');
}

export class Renderer {
  private readonly branches = new Map<string, BranchInfo>();
  private readonly order: string[] = [];
  private readonly keys = new Map<XmlElement, string>();
  private readonly keyCount = new Map<string, number>();
  private readonly warnings = new Set<string>();
  private readonly binds: BindVar[] = [];
  private readonly bindNames = new Map<string, number>();
  private iterSeq = 0;
  private readonly root: Scope;

  constructor(
    private readonly params: Record<string, unknown>,
    private readonly opts: RenderOptions = {}
  ) {
    this.root = { vars: new Map(), iter: new Map() };
  }

  render(doc: MapperDoc, st: MapperStatement): RenderResult {
    const ctx: Ctx = { doc, depth: 0, includeDepth: 0 };
    const body = this.renderChildren(st.el, ctx, this.root);
    if (/\bselectKey\b/.test(doc.src.slice(st.el.start, st.el.end))) {
      this.warnings.add('<selectKey> 는 실행하지 않고 건너뜀 (키 생성 SQL 은 따로 확인)');
    }
    return {
      sql: tidySql(body),
      branches: this.order.map((k) => this.branches.get(k)!),
      warnings: [...this.warnings],
      binds: this.binds,
    };
  }

  // ───────────────────────── 평가 환경
  private env(scope: Scope): EvalEnv {
    return {
      lookup: (name) => {
        for (let s: Scope | undefined = scope; s; s = s.parent) {
          if (s.vars.has(name)) return s.vars.get(name);
        }
        if (name === '_parameter') return this.params._parameter !== undefined ? this.params._parameter : this.params;
        if (name === '_databaseId') return this.opts.databaseId ?? 'oracle';
        return this.params[name];
      },
      warn: (m) => this.warnings.add(m),
    };
  }

  private keyOf(el: XmlElement, ctx: Ctx, expr: string): string {
    let k = this.keys.get(el);
    if (!k) {
      const base = `${ctx.doc.namespace}|${el.name}|${expr}`;
      const n = this.keyCount.get(base) ?? 0;
      this.keyCount.set(base, n + 1);
      k = `${base}#${n}`;
      this.keys.set(el, k);
    }
    return k;
  }

  private record(el: XmlElement, ctx: Ctx, tag: BranchTag, expr: string, on: boolean, how: BranchInfo['how'], note?: string): BranchInfo {
    const key = this.keyOf(el, ctx, expr);
    let b = this.branches.get(key);
    if (!b) {
      b = {
        key, tag, expr, file: ctx.doc.file, line: ctx.doc.pos(el.start).line, start: el.start, end: el.end,
        depth: ctx.depth, on: false, how, hits: 0, evals: 0, note,
      };
      this.branches.set(key, b);
      this.order.push(key);
    }
    b.evals++;
    if (on) {
      b.hits++;
      b.on = true;
    }
    // 한 번이라도 평가 실패하면 unknown 을 남긴다 (manual 이 우선)
    if (how === 'manual' || (how === 'unknown' && b.how === 'auto')) b.how = how;
    if (note) b.note = note;
    return b;
  }

  /** test 식 평가 → 수동 지정 → 실패 시 꺼짐(unknown) */
  private decide(el: XmlElement, ctx: Ctx, scope: Scope, tag: 'if' | 'when', expr: string): boolean {
    const key = this.keyOf(el, ctx, expr);
    const ov = this.opts.overrides?.[key];
    if (ov) {
      this.record(el, ctx, tag, expr, ov === 'on', 'manual');
      return ov === 'on';
    }
    try {
      const on = truthy(evalOgnl(expr, this.env(scope)));
      this.record(el, ctx, tag, expr, on, 'auto');
      return on;
    } catch (e) {
      const why = e instanceof OgnlUnsupported ? e.message : String(e);
      this.record(el, ctx, tag, expr, false, 'unknown', `자동 평가 불가: ${why}`);
      return false;
    }
  }

  // ───────────────────────── 노드 렌더링
  private renderChildren(el: XmlElement, ctx: Ctx, scope: Scope): string {
    const parts: string[] = [];
    for (const c of el.children) {
      const s = this.renderNode(c, ctx, scope);
      if (s !== '') parts.push(s);
    }
    // DynamicContext 는 조각을 공백으로 잇는다. 줄바꿈이 있는 조각은 그대로 둔다
    return parts.reduce((acc, p) => (acc === '' ? p : /\s$/.test(acc) || /^\s/.test(p) ? acc + p : `${acc} ${p}`), '');
  }

  private renderNode(n: XmlNode, ctx: Ctx, scope: Scope): string {
    if (n.kind === 'text') {
      return this.substitute(n.text, ctx, scope);
    }
    const el = n;
    const attr = (name: string) => this.applyProps(el.attrs[name], ctx);
    const inner = (c: Ctx = ctx, s: Scope = scope) => this.renderChildren(el, { ...c, depth: c.depth + 1 }, s);
    switch (el.name) {
      case 'if': {
        const test = attr('test') ?? '';
        return this.decide(el, ctx, scope, 'if', test) ? inner() : '';
      }
      case 'choose': {
        let chosen: XmlElement | undefined;
        for (const c of el.children) {
          if (c.kind !== 'element') continue;
          if (c.name === 'when') {
            const test = this.applyProps(c.attrs.test, ctx) ?? '';
            if (chosen) {
              // 이미 선택된 뒤의 when 은 평가하지 않음(MyBatis 동일). 목록에는 꺼짐으로 표시
              this.record(c, { ...ctx, depth: ctx.depth }, 'when', test, false, 'auto', '앞의 조건이 선택됨');
              continue;
            }
            if (this.decide(c, ctx, scope, 'when', test)) chosen = c;
          } else if (c.name === 'otherwise') {
            const key = this.keyOf(c, ctx, '');
            const ov = this.opts.overrides?.[key];
            const on = !chosen && ov !== 'off';
            this.record(c, ctx, 'otherwise', '', on, ov ? 'manual' : 'auto', chosen ? '앞의 조건이 선택됨' : undefined);
            if (on) chosen = c;
          }
        }
        return chosen ? this.renderChildren(chosen, { ...ctx, depth: ctx.depth + 1 }, scope) : '';
      }
      case 'where':
        return applyTrim(inner(), 'WHERE', WHERE_PREFIXES, undefined, []);
      case 'set':
        return applyTrim(inner(), 'SET', [','], undefined, [',']);
      case 'trim':
        return applyTrim(inner(), attr('prefix'), splitOverrides(attr('prefixOverrides')), attr('suffix'), splitOverrides(attr('suffixOverrides')));
      case 'foreach':
        return this.renderForeach(el, ctx, scope);
      case 'bind': {
        const name = attr('name') ?? '';
        const value = attr('value') ?? '';
        try {
          const v = evalOgnl(value, this.env(scope));
          // bind 는 statement 전체에서 보이는 변수
          this.root.vars.set(name, v);
          this.record(el, ctx, 'bind', `${name} = ${value}`, true, 'auto', `→ ${describeValue(v)}`);
        } catch (e) {
          this.root.vars.set(name, null);
          this.record(el, ctx, 'bind', `${name} = ${value}`, false, 'unknown', `계산 불가: ${(e as Error).message} (null 로 둠)`);
        }
        return '';
      }
      case 'include':
        return this.renderInclude(el, ctx, scope);
      case 'selectKey':
      case 'property':
        return '';
      case 'sql':
        return '';
      default:
        // 모르는 태그(iBATIS 등)는 내용만 살린다
        this.warnings.add(`<${el.name}> 태그는 해석하지 않고 내용만 넣음`);
        return inner();
    }
  }

  private renderForeach(el: XmlElement, ctx: Ctx, scope: Scope): string {
    const a = (n: string) => this.applyProps(el.attrs[n], ctx);
    const collExpr = a('collection') ?? '';
    const itemName = a('item');
    const indexName = a('index');
    let coll: unknown;
    try {
      coll = evalOgnl(collExpr, this.env(scope));
    } catch (e) {
      this.record(el, ctx, 'foreach', collExpr, false, 'unknown', `목록을 계산할 수 없음: ${(e as Error).message}`);
      return '';
    }
    if (coll === null || coll === undefined) {
      const nullable = a('nullable') === 'true';
      this.record(el, ctx, 'foreach', collExpr, false, 'auto', nullable ? '목록이 null (nullable)' : '목록이 null — MyBatis 에서는 오류');
      if (!nullable) this.warnings.add(`<foreach collection="${collExpr}"> 값이 null 입니다. 실제 실행 시 MyBatis 가 오류를 냅니다`);
      return '';
    }
    let entries: [unknown, unknown][];
    if (Array.isArray(coll)) entries = coll.map((v, i) => [i, v]);
    else if (typeof coll === 'object') entries = Object.entries(coll as object);
    else if (typeof coll === 'string') {
      this.record(el, ctx, 'foreach', collExpr, false, 'unknown', `목록이 아니라 문자열 "${coll}" — 목록 타입으로 입력하세요`);
      return '';
    } else entries = [[0, coll]];

    if (entries.length === 0) {
      this.record(el, ctx, 'foreach', collExpr, false, 'auto', '빈 목록 → 아무것도 쓰지 않음');
      this.warnings.add(`<foreach collection="${collExpr}"> 가 빈 목록이라 "IN ()" 처럼 깨진 SQL 이 될 수 있습니다`);
      return '';
    }
    const sep = a('separator') ?? '';
    const open = a('open') ?? '';
    const close = a('close') ?? '';
    const parts: string[] = [];
    for (const [idx, item] of entries) {
      const seq = this.iterSeq++;
      const s: Scope = { vars: new Map(), iter: new Map(), parent: scope };
      if (itemName) {
        s.vars.set(itemName, item);
        s.iter.set(itemName, `${itemName}_${seq}`);
      }
      if (indexName) {
        s.vars.set(indexName, idx);
        s.iter.set(indexName, `${indexName}_${seq}`);
      }
      const body = this.renderChildren(el, { ...ctx, depth: ctx.depth + 1 }, s).trim();
      // separator 는 내용이 있는 항목 사이에만 (MyBatis 동일)
      if (body !== '') parts.push(body);
    }
    this.record(el, ctx, 'foreach', collExpr, true, 'auto', `${entries.length}개`);
    const t = sep.trim();
    const glue = t === '' ? '\n' : t === ',' ? ', ' : /\n/.test(sep) ? sep : ` ${t} `;
    return `${open}${parts.join(glue)}${close}`;
  }

  private renderInclude(el: XmlElement, ctx: Ctx, scope: Scope): string {
    const refid = this.applyProps(el.attrs.refid, ctx) ?? '';
    // <property name value> 를 조각 안의 ${name} 에 넣는다
    const props = new Map(ctx.props ?? []);
    for (const c of el.children) {
      if (c.kind === 'element' && c.name === 'property' && c.attrs.name) props.set(c.attrs.name, this.applyProps(c.attrs.value, ctx) ?? '');
    }
    if (ctx.includeDepth > 8) {
      this.warnings.add(`<include refid="${refid}"> 가 너무 깊게 중첩됨 (순환 참조?)`);
      return '';
    }
    const found = this.findFragment(refid, ctx.doc);
    if (!found) {
      this.record(el, ctx, 'include', refid, false, 'unknown', '조각을 찾지 못함');
      this.warnings.add(`<include refid="${refid}"> 를 찾지 못했습니다`);
      return `/* include ${refid} ? */`;
    }
    const other = found.doc !== ctx.doc;
    this.record(el, ctx, 'include', refid, true, 'auto', other ? `${found.doc.namespace} (${shortFile(found.doc.file)})` : undefined);
    return this.renderChildren(found.el, { doc: found.doc, props, depth: ctx.depth + 1, includeDepth: ctx.includeDepth + 1 }, scope);
  }

  private findFragment(refid: string, doc: MapperDoc): { el: XmlElement; doc: MapperDoc } | undefined {
    const local = doc.fragments.get(refid);
    if (local) return { el: local, doc };
    const dot = refid.lastIndexOf('.');
    if (dot > 0) {
      const ns = refid.slice(0, dot);
      const id = refid.slice(dot + 1);
      if (ns === doc.namespace && doc.fragments.has(id)) return { el: doc.fragments.get(id)!, doc };
      return this.opts.resolveFragment?.(ns, id);
    }
    return undefined;
  }

  /** <include> property 로 ${name} 치환 (조각의 텍스트와 속성 모두) */
  private applyProps(s: string | undefined, ctx: Ctx): string | undefined {
    if (s === undefined || !ctx.props || ctx.props.size === 0) return s;
    return s.replace(/\$\{([^}]+)\}/g, (m, name: string) => (ctx.props!.has(name.trim()) ? ctx.props!.get(name.trim())! : m));
  }

  // ───────────────────────── #{} / ${} 치환
  private substitute(text: string, ctx: Ctx, scope: Scope): string {
    const withProps = this.applyProps(text, ctx)!;
    const legacy = ctx.doc.legacy;
    const re = legacy ? /([#$])\{([^}]*)\}|#([\w.[\]]+)(?::\w+)?#|\$([\w.[\]]+)\$/g : /([#$])\{([^}]*)\}/g;
    return withProps.replace(re, (...g: unknown[]) => {
      const sigil = g[1] as string | undefined;
      const body = g[2] as string | undefined;
      const legacyBind = legacy && typeof g[3] === 'string' ? g[3] : undefined;
      const legacyRaw = legacy && typeof g[4] === 'string' ? g[4] : undefined;
      if (legacyBind) return this.bindValue(legacyBind, scope);
      if (legacyRaw) return this.rawValue(legacyRaw, scope);
      return sigil === '#' ? this.bindValue(body ?? '', scope) : this.rawValue(body ?? '', scope);
    });
  }

  private evalPath(expr: string, scope: Scope): { ok: true; v: unknown } | { ok: false; why: string } {
    try {
      return { ok: true, v: evalOgnl(expr, this.env(scope)) };
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    }
  }

  private bindValue(body: string, scope: Scope): string {
    const [nameRaw, ...opts] = body.split(',');
    const expr = nameRaw.trim();
    const jdbcType = opts.map((o) => /^\s*jdbcType\s*=\s*(\w+)/.exec(o)?.[1]).find(Boolean);
    const r = this.evalPath(expr, scope);
    if (!r.ok) {
      this.warnings.add(`#{${expr}} 값을 구하지 못함: ${r.why}`);
      return `/* #{${expr}} ? */ NULL`;
    }
    const lit = toSqlLiteral(r.v, jdbcType);
    if (this.opts.mode === 'bind') {
      const bv = toBindValue(r.v, jdbcType);
      if (bv.problem) this.warnings.add(`#{${expr}}: ${bv.problem}`);
      const name = this.bindName(expr, scope);
      if (!this.binds.some((b) => b.name === name)) {
        this.binds.push({ name, expr, value: r.v, literal: lit.sql, varType: bv.varType, assign: bv.assign });
      }
      return bv.wrap ? bv.wrap(`:${name}`) : `:${name}`;
    }
    if (lit.problem) this.warnings.add(`#{${expr}}: ${lit.problem}`);
    return lit.sql;
  }

  private bindName(expr: string, scope: Scope): string {
    // foreach 의 item 은 반복마다 다른 이름 (MyBatis 의 __frch_item_0 과 같은 이유)
    const first = expr.split(/[.[]/)[0];
    let base = expr;
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      const alias = s.iter.get(first);
      if (alias) {
        base = alias + expr.slice(first.length);
        break;
      }
    }
    let name = base.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'p';
    if (/^\d/.test(name)) name = `p_${name}`;
    // Oracle 바인드 이름 길이 제한(30) 고려
    name = name.slice(0, 30);
    const existing = this.binds.find((b) => b.name === name);
    if (existing && existing.expr !== expr) {
      const n = (this.bindNames.get(name) ?? 1) + 1;
      this.bindNames.set(name, n);
      name = `${name.slice(0, 27)}_${n}`;
    }
    return name;
  }

  private rawValue(body: string, scope: Scope): string {
    const expr = body.trim();
    const r = this.evalPath(expr, scope);
    if (!r.ok) {
      this.warnings.add(`\${${expr}} 값을 구하지 못함: ${r.why}`);
      return `/* \${${expr}} ? */`;
    }
    if (r.v === null || r.v === undefined) {
      this.warnings.add(`\${${expr}} 값이 비어 있어 빈 문자열이 들어갑니다`);
    }
    return toRawText(r.v);
  }
}

function shortFile(f: string): string {
  return f.split(/[\\/]/).pop() ?? f;
}

/**
 * 바인드 변수 모드의 실행 스크립트 (SQL*Plus / SQLcl 문법, 워크시트에서 F5 로 실행).
 *
 *   VARIABLE name VARCHAR2(4000)      ← 도구가 바인드 변수를 만든다 (SQL*Plus 명령)
 *   EXEC :name := '홍길동';            ← PL/SQL 한 줄로 값을 넣는다
 *   SELECT ... WHERE NAME = :name;    ← 실제 쿼리 (값이 바인드되어 실행)
 */
export function buildBindScript(sql: string, binds: BindVar[], title?: string): string {
  const lines: string[] = [];
  if (title) lines.push(`-- ${title}`);
  if (binds.length > 0) {
    const w = Math.max(...binds.map((b) => b.name.length));
    for (const b of binds) lines.push(`VARIABLE ${b.name.padEnd(w)} ${b.varType}`);
    for (const b of binds) lines.push(`EXEC :${b.name.padEnd(w)} := ${b.assign};`);
    lines.push('');
  }
  lines.push(/;\s*$/.test(sql) ? sql.trim() : `${sql.trim()};`);
  return lines.join('\n');
}

export function renderStatement(doc: MapperDoc, st: MapperStatement, params: Record<string, unknown>, opts: RenderOptions = {}): RenderResult {
  return new Renderer(params, opts).render(doc, st);
}

// ───────────────────────── 파라미터 수집 (정적 분석)

export interface ParamSpec {
  /** 최상위 기준 경로. 예: name, user.name, ids */
  path: string;
  /** #{} 바인드 / ${} 문자열 치환 / test 식 / foreach 목록 */
  uses: Array<'bind' | 'raw' | 'test' | 'collection'>;
  jdbcType?: string;
  /** 처음 나온 줄 */
  line: number;
}

/**
 * statement 에서 입력받아야 할 파라미터를 모은다 (분기와 무관하게 전부).
 * foreach item/index, bind 이름은 지역 변수라 제외한다.
 */
export function collectParams(doc: MapperDoc, st: MapperStatement, resolveFragment?: FragmentResolver): ParamSpec[] {
  const specs = new Map<string, ParamSpec>();
  const binds = new Set<string>();
  // bind 이름은 statement 어디서 선언되든 전역
  const add = (path: string, use: ParamSpec['uses'][number], line: number, jdbcType?: string, locals?: Set<string>) => {
    const p = path.replace(/\[[^\]]*\]/g, '').trim();
    if (!p || /^\d/.test(p)) return;
    const root = p.split('.')[0];
    if (locals?.has(root) || binds.has(root) || root === '_databaseId') return;
    let s = specs.get(p);
    if (!s) {
      s = { path: p, uses: [], line };
      specs.set(p, s);
    }
    if (!s.uses.includes(use)) s.uses.push(use);
    if (jdbcType && !s.jdbcType) s.jdbcType = jdbcType;
  };

  const visit = (el: XmlElement, d: MapperDoc, locals: Set<string>, props: Map<string, string>, depth: number) => {
    const ap = (s: string | undefined) => (s === undefined ? s : s.replace(/\$\{([^}]+)\}/g, (m, n: string) => props.get(n.trim()) ?? m));
    for (const c of el.children) {
      if (c.kind === 'text') {
        const line = d.pos(c.start).line;
        const text = ap(c.text)!;
        for (const m of text.matchAll(/([#$])\{([^}]*)\}/g)) {
          const [name, ...opts] = m[2].split(',');
          const jt = opts.map((o) => /^\s*jdbcType\s*=\s*(\w+)/.exec(o)?.[1]).find(Boolean);
          for (const p of referencedPaths(name.trim())) add(p, m[1] === '#' ? 'bind' : 'raw', line, jt, locals);
        }
        if (d.legacy) {
          for (const m of text.matchAll(/#([\w.[\]]+)(?::\w+)?#/g)) add(m[1], 'bind', line, undefined, locals);
          for (const m of text.matchAll(/\$([\w.[\]]+)\$/g)) add(m[1], 'raw', line, undefined, locals);
        }
        continue;
      }
      const line = d.pos(c.start).line;
      const a = (n: string) => ap(c.attrs[n]);
      if ((c.name === 'if' || c.name === 'when') && a('test')) {
        for (const p of referencedPaths(a('test')!)) add(p, 'test', line, undefined, locals);
      }
      if (c.name === 'bind') {
        for (const p of referencedPaths(a('value') ?? '')) add(p, 'test', line, undefined, locals);
        if (a('name')) binds.add(a('name')!);
        continue;
      }
      if (c.name === 'foreach') {
        for (const p of referencedPaths(a('collection') ?? '')) add(p, 'collection', line, undefined, locals);
        const inner = new Set(locals);
        if (a('item')) inner.add(a('item')!);
        if (a('index')) inner.add(a('index')!);
        visit(c, d, inner, props, depth);
        continue;
      }
      if (c.name === 'include') {
        if (depth > 8) continue;
        const refid = a('refid') ?? '';
        const p2 = new Map(props);
        for (const pc of c.children) {
          if (pc.kind === 'element' && pc.name === 'property' && pc.attrs.name) p2.set(pc.attrs.name, ap(pc.attrs.value) ?? '');
        }
        let frag: { el: XmlElement; doc: MapperDoc } | undefined;
        if (d.fragments.has(refid)) frag = { el: d.fragments.get(refid)!, doc: d };
        else {
          const dot = refid.lastIndexOf('.');
          if (dot > 0) {
            const ns = refid.slice(0, dot);
            const id = refid.slice(dot + 1);
            frag = ns === d.namespace && d.fragments.has(id) ? { el: d.fragments.get(id)!, doc: d } : resolveFragment?.(ns, id);
          }
        }
        if (frag) visit(frag.el, frag.doc, locals, p2, depth + 1);
        continue;
      }
      if (c.name === 'selectKey') continue;
      visit(c, d, locals, props, depth);
    }
  };
  visit(st.el, doc, new Set(), new Map(), 0);

  // user 와 user.name 이 함께 있으면 user 는 test(null 비교) 용 → 하위 경로가 입력되면 자동으로 채워진다
  const out = [...specs.values()];
  return out
    .filter((s) => !(s.uses.every((u) => u === 'test') && out.some((o) => o.path.startsWith(s.path + '.'))))
    .sort((x, y) => x.line - y.line);
}
