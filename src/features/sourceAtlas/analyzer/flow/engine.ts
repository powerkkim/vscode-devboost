/**
 * 흐름 엔진: 모듈 요약(summary)을 이어 붙여 "이 함수를 부르면 결국 어떤 네트워크 요청이 나가는가"를 푼다.
 *
 * 끝점(sink)은 axios·fetch 같은 실제 네트워크 호출뿐이다. 래퍼(api.post, request, useApi().get …)는 이름이 아니라
 * "그 함수 본문이 결국 끝점에 닿고, 자기 인자가 URL 자리로 흘러가는가"로 판정된다 (요약 치환).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { Resolver } from '../resolver';
import { summarizeModule, ModuleFlow, FnSummary, CallSite } from './summary';
import { Val, lit, unknown, concat, alt, render, describe } from './values';

export interface FlowProfile {
  /** 끝점으로 보는 패키지 (import 원본 이름) */
  sinkPackages: string[];
  /** this.$http 처럼 컴포넌트 인스턴스에 꽂힌 끝점 */
  thisSinks: string[];
  /** 해석 못 한 호출을 이름으로 추정할지 (api.get('/x') 등). 결과는 '추정' */
  nameHeuristic: boolean;
}

export const DEFAULT_PROFILE: FlowProfile = {
  sinkPackages: ['axios', 'redaxios', 'ky', 'ofetch', 'superagent'],
  thisSinks: ['$http', '$axios', '$api', '$fetch'],
  nameHeuristic: true,
};

export interface Step {
  /** 절대경로 */
  file: string;
  fn: string;
  line: number;
  col: number;
}

export interface Effect {
  method: string;
  url: string;
  /** URL 에서 확정하지 못한 부분의 이유 */
  unknowns: string[];
  sink: string;
  certainty: 'sure' | 'guess';
  /** 진입 함수의 호출 위치부터 끝점 호출 위치까지 */
  chain: Step[];
  /**
   * known: 경로에 글자가 있음 · param: URL 이 자기 인자뿐 (래퍼 함수 자체의 효과 — 노드로 만들지 않음)
   * unknown: 실행 시 값이라 경로를 전혀 모름 (미해석 목록으로)
   */
  urlKind: 'known' | 'param' | 'unknown';
}

export interface EntryEffects {
  fn: string;
  fnId: string;
  line: number;
  effects: Effect[];
  /** HTTP 호출처럼 보이지만 끝점·URL 을 확정하지 못한 호출 (사람이 볼 "미해석 목록") */
  unresolved: string[];
}

interface Ctx {
  mod: ModuleFlow;
  args: R[];
  /** 함수의 기본 인자값 (인자가 안 넘어왔을 때) */
  defaults?: (Val | null)[];
}

/** 해석된 값 */
type R =
  | Val
  | { k: 'fnR'; mod: ModuleFlow; id: string }
  | { k: 'objR'; mod: ModuleFlow; members: Record<string, Val>; args: R[] }
  | { k: 'sinkR'; sink: string; base?: R; guess?: boolean }
  | { k: 'sinkM'; sink: string; method: string; base?: R; guess?: boolean };

const HTTP = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const WRAPPER_NAME = /api|http|request|client|service|fetch|ajax/i;
const MAX_DEPTH = 14;

export interface FlowEngineOptions {
  resolver: Resolver;
  profile?: Partial<FlowProfile>;
}

export class FlowEngine {
  private modules = new Map<string, ModuleFlow | null>();
  /** (함수, 인자) → 효과 메모. chain 은 그 함수 안에서 시작하는 상대 경로로 저장한다 */
  private effectMemo = new Map<string, Effect[]>();
  private profile: FlowProfile;
  private resolver: Resolver;

  constructor(opts: FlowEngineOptions) {
    this.resolver = opts.resolver;
    this.profile = { ...DEFAULT_PROFILE, ...opts.profile };
  }

  /** 파일 → 요약 (캐시). .vue 는 script 블록만 */
  moduleOf(abs: string): ModuleFlow | null {
    if (this.modules.has(abs)) return this.modules.get(abs)!;
    let mod: ModuleFlow | null = null;
    try {
      const code = fs.readFileSync(abs, 'utf8');
      if (abs.endsWith('.vue')) {
        const { descriptor } = parseSfc(code, { filename: abs, sourceMap: false });
        const setup = descriptor.scriptSetup;
        const plain = descriptor.script;
        const block = setup ?? plain;
        if (block) {
          const lang: 'ts' | 'js' = block.lang === 'ts' || block.lang === 'tsx' ? 'ts' : 'js';
          mod = summarizeModule(block.content, {
            file: abs, lang, jsx: block.lang === 'tsx' || block.lang === 'jsx',
            startLine: block.loc.start.line, isComponent: true, isSetup: !!setup,
          });
          // <script setup> 과 일반 <script> 가 같이 있으면 일반 블록의 export 도 합친다
          if (setup && plain) {
            const other = summarizeModule(plain.content, {
              file: abs, lang: plain.lang === 'ts' ? 'ts' : 'js', startLine: plain.loc.start.line, isComponent: false,
            });
            for (const [id, f] of other.fns) if (!mod.fns.has(id)) mod.fns.set(id, f);
          }
        }
      } else {
        const lang: 'ts' | 'js' = /\.(ts|mts|tsx)$/.test(abs) ? 'ts' : 'js';
        mod = summarizeModule(code, { file: abs, lang, jsx: /x$/.test(abs) });
      }
    } catch {
      mod = null;
    }
    this.modules.set(abs, mod);
    return mod;
  }

  /** 컴포넌트의 진입 함수(setup 본문·최상위 함수·methods·hooks)별 네트워크 효과 */
  componentEffects(abs: string): EntryEffects[] {
    const mod = this.moduleOf(abs);
    if (!mod) return [];
    const out: EntryEffects[] = [];
    for (const id of mod.entries) {
      const fn = mod.fns.get(id);
      if (!fn) continue;
      const unresolved = new Set<string>();
      const effects = this.effectsOfFn({ k: 'fnR', mod, id }, [], [], 0, new Set(), unresolved);
      out.push({ fn: fn.name, fnId: id, line: fn.line, effects, unresolved: [...unresolved] });
    }
    return out;
  }

  /**
   * 모듈(composable·store·api 유틸)에서 "밖에서 쓸 수 있는" 함수별 효과 — 노드 상세 표용.
   * export 된 함수, 그 함수가 돌려주는 객체의 함수 멤버, export 된 객체의 함수 멤버만 본다
   * (안쪽에서만 쓰고 돌려주지 않는 헬퍼는 그 모듈을 쓴다고 해서 생기는 효과가 아니다).
   */
  moduleFnEffects(abs: string): EntryEffects[] {
    const mod = this.moduleOf(abs);
    if (!mod) return [];
    const out: EntryEffects[] = [];
    const done = new Set<string>();
    const visit = (r: R, depth: number) => {
      if (depth > 2) return;
      if (r.k === 'fnR') {
        const key = `${r.mod.file}#${r.id}`;
        const fn = r.mod.fns.get(r.id);
        if (!fn || done.has(key)) return;
        done.add(key);
        if (r.mod === mod) {
          const unresolved = new Set<string>();
          // 인자는 "자기 인자" 표식으로 넘긴다 → URL 에 인자가 남으면 render 가 `인자 'p'` 로 표시하고 urlKind 가 'param' 이 된다
          const ownArgs: R[] = fn.params.map((name, i) => ({ k: 'param', i, name }));
          const effects = this.effectsOfFn(r, ownArgs, [], 0, new Set(), unresolved);
          if (effects.length || unresolved.size) out.push({ fn: fn.name, fnId: r.id, line: fn.line, effects, unresolved: [...unresolved] });
        }
        if (fn.returns) visit(this.resolve(fn.returns, { mod: r.mod, args: [] }, 0), depth + 1);
      } else if (r.k === 'objR') {
        for (const m of Object.values(r.members)) visit(this.resolve(m, { mod: r.mod, args: r.args }, 0), depth + 1);
      } else if (r.k === 'alt') {
        for (const o of r.options) visit(this.resolve(o, { mod, args: [] }, 0), depth + 1);
      }
    };
    for (const val of Object.values(mod.exports)) visit(this.resolve(val, { mod, args: [] }, 0), 0);
    return out;
  }

  // ───────────────────────── 효과 계산 ─────────────────────────

  private effectsOfFn(fnR: { k: 'fnR'; mod: ModuleFlow; id: string }, args: R[], chain: Step[], depth: number, seen: Set<string>, unresolved: Set<string>): Effect[] {
    const key = `${fnR.mod.file}#${fnR.id}`;
    if (seen.has(key) || depth > MAX_DEPTH) return [];
    const fn = fnR.mod.fns.get(fnR.id);
    if (!fn) return [];
    const memoKey = `${key}|${args.map((a) => JSON.stringify(toVal(a))).join('\u0001')}`;
    const memo = this.effectMemo.get(memoKey);
    if (memo) return memo.map((e) => ({ ...e, chain: [...chain, ...e.chain] }));
    const nextSeen = new Set(seen).add(key);
    const ctx: Ctx = { mod: fnR.mod, args, defaults: fn.paramDefaults };
    const rel: Effect[] = [];
    for (const cs of fn.calls) {
      rel.push(...this.effectsOfCall(cs, fn, ctx, depth, nextSeen, unresolved));
    }
    // 순환 때문에 잘린 경로가 없을 때만 메모 (seen 이 비어 있는 최상위 호출이 아니어도, 결과는 함수+인자에만 의존)
    this.effectMemo.set(memoKey, rel);
    return rel.map((e) => ({ ...e, chain: [...chain, ...e.chain] }));
  }

  /** 호출 하나의 효과. chain 은 이 호출 위치(step)부터 시작하는 상대 경로 */
  private effectsOfCall(cs: CallSite, fn: FnSummary, ctx: Ctx, depth: number, seen: Set<string>, unresolved: Set<string>): Effect[] {
    const step: Step = { file: ctx.mod.file, fn: fn.name, line: cs.line, col: cs.col };
    const callee = this.resolve(cs.callee, ctx, 0);
    const args = cs.args.map((a) => this.resolve(a, ctx, 0));
    const here = [step];

    if (callee.k === 'sinkM') return this.sinkEffect(callee, args, here);
    if (callee.k === 'sinkR') return this.sinkDirect(callee, args, here);
    if (callee.k === 'fnR') {
      const found = this.effectsOfFn(callee, args, here, depth + 1, seen, unresolved);
      if (found.length || seen.has(`${callee.mod.file}#${callee.id}`)) return found;
      // 함수는 찾았는데 본문에서 끝점에 닿지 못함 (클래스·미지원 문법 등). 이름이 HTTP 래퍼 같고 URL 이 문자열이면 추정으로 남긴다
      return this.heuristic(cs, args, here, '본문에서 끝점을 찾지 못함', unresolved);
    }
    // 해석 실패 (외부 패키지, 전역 주입 등): 이름 기반 추정
    return this.heuristic(cs, args, here, '호출 대상을 해석하지 못함', unresolved);
  }

  /** api.get('/x'), this.$api.post(...) 처럼 이름으로만 HTTP 호출을 추정. URL 까지 모르면 미해석 목록에만 남긴다 */
  private heuristic(cs: CallSite, args: R[], chain: Step[], why: string, unresolved: Set<string>): Effect[] {
    if (!this.profile.nameHeuristic || cs.callee.k !== 'member' || !HTTP.has(cs.callee.prop)) return [];
    const recvName = cs.callee.hint ?? receiverName(cs.callee.base);
    if (!recvName || !WRAPPER_NAME.test(recvName)) return [];
    if (!args[0] || !isStringish(args[0])) {
      const where = chain[chain.length - 1];
      unresolved.add(`${recvName}.${cs.callee.prop}(…) — URL 을 알 수 없음 (${describe(toVal(args[0] ?? unknown('인자 없음')))}) · ${path.basename(where.file)}:${where.line}`);
      return [];
    }
    return this.sinkEffect({ sink: `${recvName} (${why})`, method: cs.callee.prop, guess: true }, args, chain);
  }

  private sinkEffect(s: { sink: string; method: string; base?: R; guess?: boolean }, args: R[], chain: Step[]): Effect[] {
    const m = s.method.toLowerCase();
    if (s.sink === 'xhr') {
      if (m !== 'open') return [];
      return this.finish(toVal(args[0] ?? unknown('method')), toVal(args[1] ?? unknown('url')), undefined, 'xhr', chain, !!s.guess);
    }
    if (s.sink === 'fetch' || s.sink === '$fetch' || s.sink === 'useFetch' || s.sink === 'ofetch') {
      // fetch 는 함수 자체가 끝점 (sinkDirect 로 옴). $fetch.raw(url, opts) 만 같은 모양
      return m === 'raw' ? this.sinkDirect({ sink: s.sink, base: s.base, guess: s.guess }, args, chain) : [];
    }
    if (m === 'request') {
      return this.fromConfig(args[0], s.sink, s.base, chain, !!s.guess);
    }
    if (!HTTP.has(m)) return [];
    const url = toVal(args[0] ?? unknown('URL 인자 없음'));
    return this.finish(lit(m.toUpperCase()), url, s.base, s.sink, chain, !!s.guess);
  }

  /** axios(config) / fetch(url, opts) / $fetch(url, opts) 처럼 끝점을 직접 부른 경우 */
  private sinkDirect(s: { sink: string; base?: R; guess?: boolean }, args: R[], chain: Step[]): Effect[] {
    if (s.sink === 'fetch' || s.sink === '$fetch' || s.sink === 'useFetch' || s.sink === 'ofetch') {
      const url = toVal(args[0] ?? unknown('URL 인자 없음'));
      const opt = args[1];
      const method = opt && opt.k === 'objR' ? toVal(this.resolve(opt.members.method ?? lit('GET'), { mod: opt.mod, args: opt.args }, 0)) : lit('GET');
      return this.finish(method, url, s.base, s.sink, chain, !!s.guess);
    }
    // axios(config) / axios(url, config)
    if (args[0] && isStringish(args[0])) {
      const opt = args[1];
      const method = opt && opt.k === 'objR' ? toVal(this.resolve(opt.members.method ?? lit('GET'), { mod: opt.mod, args: opt.args }, 0)) : lit('GET');
      return this.finish(method, toVal(args[0]), s.base, s.sink, chain, !!s.guess);
    }
    return this.fromConfig(args[0], s.sink, s.base, chain, !!s.guess);
  }

  private fromConfig(cfg: R | undefined, sink: string, base: R | undefined, chain: Step[], guess: boolean): Effect[] {
    if (!cfg || cfg.k !== 'objR') return [];
    const c: Ctx = { mod: cfg.mod, args: cfg.args };
    const url = toVal(this.resolve(cfg.members.url ?? unknown('url 없음'), c, 0));
    const method = toVal(this.resolve(cfg.members.method ?? lit('GET'), c, 0));
    const cfgBase = cfg.members.baseURL ? this.resolve(cfg.members.baseURL, c, 0) : undefined;
    return this.finish(method, url, cfgBase ?? base, sink, chain, guess);
  }

  private finish(method: Val, url: Val, base: R | undefined, sink: string, chain: Step[], guess: boolean): Effect[] {
    const urls = render(url);
    const methods = render(method);
    // baseURL: 전부 확정일 때만 앞에 붙인다. 환경변수 등으로 불확실하면 붙이지 않고 이유만 남긴다 (경로 부분은 그대로 보이게)
    let baseR = base ? render(toVal(base)) : [{ text: '', unknowns: [] }];
    if (baseR.some((b) => b.unknowns.length)) {
      const known = baseR.filter((b) => !b.unknowns.length).map((b) => JSON.stringify(b.text));
      const why = baseR.flatMap((b) => b.unknowns);
      // `${env}/v1` 처럼 앞쪽만 모르면 뒤의 고정 경로(/v1)는 살린다 (백엔드 매핑 /v1/... 과 맞춰야 하므로)
      const suffixes = [...new Set(baseR.filter((b) => b.unknowns.length).map((b) => (b.text.match(/^(?:\{\})+(\/.*)?$/) ?? [])[1] ?? ''))];
      const suffix = suffixes.length === 1 ? suffixes[0] : '';
      baseR = [{ text: suffix, unknowns: [`baseURL 미확정: ${[...new Set(why)].join(', ')}${known.length ? ` (기본값 ${known.join('|')})` : ''}`] }];
    }
    const out: Effect[] = [];
    for (const u of urls) {
      // base 를 붙이기 전의 경로만 보고 종류를 정한다: 글자가 있으면 known, 전부 인자면 param, 그 밖(실행 시 값)은 unknown
      const bare = u.text.replace(/\{\}/g, '').replace(/[\/]/g, '');
      // `인자 'p'` (따옴표 형태) 는 치환되지 않은 자기 인자. 인자가 경로 전체이거나 경로의 이어짐(`/api/v2` + p)이면 래퍼 자체의 효과,
      // `/orders/` + id 처럼 세그먼트 경계 뒤에 오면 경로 변수(path param)로 보고 남긴다
      const prefix = u.text.split('{}')[0];
      const ownParamOnly = u.unknowns.length > 0 && u.unknowns.every((w) => w.startsWith("인자 '")) && (!prefix.replace(/\//g, '') || !prefix.endsWith('/'));
      const urlKind: Effect['urlKind'] = ownParamOnly ? 'param' : bare ? 'known' : 'unknown';
      for (const m of methods.slice(0, 2)) {
        for (const b of baseR.slice(0, 3)) {
          const absolute = /^[a-z]+:\/\//i.test(u.text);
          const text = absolute || !b.text ? u.text : joinUrl(b.text, u.text);
          const unknowns = [...u.unknowns, ...(absolute ? [] : b.unknowns), ...m.unknowns.map((w) => `HTTP 메서드 미확정: ${w}`)];
          const methodText = m.unknowns.length ? 'ANY' : (m.text || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
          out.push({ method: methodText, url: text || '{}', unknowns, sink, certainty: guess ? 'guess' : 'sure', chain, urlKind });
        }
      }
    }
    return out;
  }

  // ───────────────────────── 값 해석 ─────────────────────────

  private resolve(v: Val, ctx: Ctx, depth: number): R {
    if (depth > 24) return unknown('너무 깊은 해석');
    switch (v.k) {
      case 'lit':
      case 'unknown':
      case 'sink':
        return v.k === 'sink' ? { k: 'sinkR', sink: v.sink, base: v.base ? this.resolve(v.base, ctx, depth + 1) : undefined } : v;
      case 'param': {
        if (ctx.args[v.i]) return ctx.args[v.i];
        const d = ctx.defaults?.[v.i];
        return d ? this.resolve(d, { mod: ctx.mod, args: [] }, depth + 1) : unknown(`인자 ${v.name} (실행 시 값)`);
      }
      case 'concat':
        return concat(v.parts.map((p) => toVal(this.resolve(p, ctx, depth + 1))));
      case 'alt':
        return alt(v.options.map((o) => toVal(this.resolve(o, ctx, depth + 1))));
      case 'obj':
        return { k: 'objR', mod: ctx.mod, members: v.members, args: ctx.args };
      case 'fn':
        return { k: 'fnR', mod: ctx.mod, id: v.id };
      case 'this':
        return v;
      case 'ext':
        return v;
      case 'import':
        return this.resolveImport(v.source, v.imported, ctx.mod, depth);
      case 'member':
        return this.resolveMember(v, ctx, depth);
      case 'call':
        return this.resolveCall(v, ctx, depth);
    }
  }

  private resolveImport(source: string, imported: string, from: ModuleFlow, depth: number, visiting: Set<string> = new Set()): R {
    if (depth > 24) return unknown('너무 깊은 import 해석');
    const target = this.resolver.resolve(source, from.file);
    if (target) {
      const vkey = `${target}|${imported}`;
      if (visiting.has(vkey)) return unknown(`순환 export (${path.basename(target)})`);
      const mod = this.moduleOf(target);
      if (!mod) return unknown(`${source} 를 읽지 못함`);
      if (imported === '*') return { k: 'objR', mod, members: mod.exports, args: [] };
      const ex = mod.exports[imported];
      if (!ex) {
        // export * from './x' 를 거쳐 오는 이름 (배럴 index 순환 대비 visiting)
        const next = new Set(visiting).add(vkey);
        for (const [k, v] of Object.entries(mod.exports)) {
          if (k.startsWith('*') && v.k === 'import') {
            const r = this.resolveImport(v.source, imported, mod, depth + 1, next);
            if (r.k !== 'unknown') return r;
          }
        }
        return unknown(`${path.basename(target)} 에 export '${imported}' 없음`);
      }
      return this.resolve(ex, { mod, args: [] }, depth + 1);
    }
    const pkg = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
    if (this.profile.sinkPackages.includes(pkg)) {
      return { k: 'sinkR', sink: pkg };
    }
    if (pkg === 'vue' || pkg === 'pinia' || pkg === 'vue-router' || pkg === '@vueuse/core') return { k: 'ext', source: pkg, path: [imported] };
    return { k: 'ext', source, path: [imported] };
  }

  private resolveMember(v: { base: Val; prop: string }, ctx: Ctx, depth: number): R {
    const base = this.resolve(v.base, ctx, depth + 1);
    const prop = v.prop;
    switch (base.k) {
      case 'objR': {
        const m = base.members[prop];
        if (!m) return unknown(`속성 '${prop}' 없음`);
        return this.resolve(m, { mod: base.mod, args: base.args }, depth + 1);
      }
      case 'sinkR':
        return { k: 'sinkM', sink: base.sink, method: prop, base: base.base, guess: base.guess };
      case 'this': {
        const tm = ctx.mod.thisMembers[prop];
        if (tm) return this.resolve(tm, { mod: ctx.mod, args: [] }, depth + 1);
        if (this.profile.thisSinks.includes(prop)) return { k: 'sinkR', sink: `this.${prop}`, guess: true };
        return unknown(`this.${prop}`);
      }
      case 'ext':
        return { k: 'ext', source: base.source, path: [...base.path, prop] };
      case 'alt':
        return alt(base.options.map((o) => toVal(this.resolveMember({ base: o, prop }, ctx, depth + 1))));
      case 'lit':
      case 'concat':
      case 'param':
        // ref('/x').value, url.value 같은 것: 그대로
        return prop === 'value' ? base : unknown(`${describe(base)}.${prop}`);
      case 'fnR':
        return unknown(`함수의 속성 ${prop}`);
      default:
        return unknown(`${describe(toVal(base))}.${prop}`);
    }
  }

  private resolveCall(v: { callee: Val; args: Val[] }, ctx: Ctx, depth: number): R {
    const callee = this.resolve(v.callee, ctx, depth + 1);
    const args = v.args.map((a) => this.resolve(a, ctx, depth + 1));
    switch (callee.k) {
      case 'fnR': {
        const fn = callee.mod.fns.get(callee.id);
        if (!fn?.returns) return unknown(`${fn?.name ?? callee.id}() 반환값 없음`);
        return this.resolve(fn.returns, { mod: callee.mod, args }, depth + 1);
      }
      case 'sinkM':
        if (callee.method === 'create' || callee.method === 'extend') {
          // axios.create({ baseURL }) → 인스턴스 (baseURL 을 기억)
          const cfg = args[0];
          let base: R | undefined;
          if (cfg?.k === 'objR') {
            const b = cfg.members.baseURL ?? cfg.members.prefixUrl ?? cfg.members.baseUrl;
            base = b ? this.resolve(b, { mod: cfg.mod, args: cfg.args }, depth + 1) : undefined;
          }
          return { k: 'sinkR', sink: callee.sink, base: base ?? callee.base, guess: callee.guess };
        }
        return unknown('HTTP 응답');
      case 'sinkR':
        return unknown('HTTP 응답');
      case 'ext': {
        // vue 의 ref/computed: 실행 중에 바뀌는 값 → URL 에 쓰이면 알 수 없음으로 둔다 (reactive 객체는 멤버 접근이 많아 안의 값을 유지)
        if ((callee.source === 'vue' || callee.source === 'global') && ['ref', 'shallowRef', 'computed'].includes(callee.path[0])) {
          return unknown(`반응형 값 (${callee.path[0]})`);
        }
        if ((callee.source === 'vue' || callee.source === 'global') && ['reactive', 'readonly', 'unref', 'toRaw', 'shallowReactive'].includes(callee.path[0])) {
          return args[0] ?? unknown(callee.path[0]);
        }
        if (callee.source === 'pinia' && callee.path[0] === 'storeToRefs') return args[0] ?? unknown('storeToRefs');
        if ((callee.source === 'pinia' || callee.source === 'global') && callee.path[0] === 'defineStore') {
          // defineStore(id, setupFn) → setupFn 이 곧 스토어 팩토리 / defineStore(id, { actions, getters }) → 액션 객체
          const def = args[1] ?? args[0];
          if (def?.k === 'fnR') return def;
          if (def?.k === 'objR') {
            const pick = (name: string) => {
              const m = def.members[name];
              return m?.k === 'obj' ? m.members : {};
            };
            return { k: 'objR', mod: def.mod, args: def.args, members: { ...pick('getters'), ...pick('actions') } };
          }
          return unknown('defineStore 정의를 읽지 못함');
        }
        return { k: 'ext', source: callee.source, path: [...callee.path, '()'] };
      }
      case 'objR':
        // 옵션 스토어의 defineStore 결과처럼 객체를 함수처럼 부르는 경우는 요약 단계에서 fn 으로 바뀜. 여기선 그대로
        return callee;
      default:
        return unknown(`${describe(toVal(callee))}() 의 결과`);
    }
  }
}

/** R 중 값으로 쓸 수 있는 것만 Val 로. 함수·객체·끝점은 unknown */
function toVal(r: R): Val {
  switch (r.k) {
    case 'fnR': return unknown('함수 값');
    case 'objR': return unknown('객체 값');
    case 'sinkR': return unknown(`끝점 ${r.sink}`);
    case 'sinkM': return unknown(`끝점 ${r.sink}.${r.method}`);
    default: return r;
  }
}

function isStringish(r: R): boolean {
  return r.k === 'lit' || r.k === 'concat' || r.k === 'alt' || r.k === 'param';
}

function receiverName(v: Val): string | null {
  switch (v.k) {
    case 'import': return v.imported === 'default' ? v.source.split('/').pop() ?? null : v.imported;
    case 'member': return v.prop;
    case 'unknown': return v.why;
    case 'ext': return v.path[v.path.length - 1] ?? v.source;
    case 'call': return receiverName(v.callee);
    case 'this': return 'this';
    default: return null;
  }
}

function joinUrl(base: string, url: string): string {
  if (!base) return url;
  if (!url) return base;
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}
