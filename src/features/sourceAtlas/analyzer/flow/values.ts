/**
 * 호출 전파 분석에서 쓰는 "기호 값".
 *
 * 코드를 실행하지 않고 "이 자리에 어떤 값이 오는가"를 표현한다. 요약(summary) 단계에서는 파일 하나만 보고
 * 문법적으로 만들 수 있는 값(lit · concat · param · import · member · call …)을 만들고,
 * 엔진(engine) 단계에서 다른 파일을 열어 import · call · member 를 풀어 lit/concat/param/unknown 으로 줄인다.
 */
export type Val =
  | { k: 'lit'; s: string }
  | { k: 'concat'; parts: Val[] }
  /** 요약 중인 함수의 i 번째 인자. 호출자가 실제 인자로 치환한다 */
  | { k: 'param'; i: number; name: string }
  | { k: 'unknown'; why: string }
  /** import 한 값 (엔진이 모듈을 열어 푼다) */
  | { k: 'import'; source: string; imported: string }
  /** hint: 원래 코드에서 base 가 식별자였으면 그 이름 (이름 기반 추정용) */
  | { k: 'member'; base: Val; prop: string; hint?: string }
  /** 호출 결과 값 (함수가 돌려주는 것). callee 는 함수를 가리키는 값 */
  | { k: 'call'; callee: Val; args: Val[] }
  /** 분기 등으로 여러 후보 중 하나 */
  | { k: 'alt'; options: Val[] }
  | { k: 'obj'; members: Record<string, Val> }
  /** 같은 모듈 안의 함수 (요약 id) */
  | { k: 'fn'; id: string }
  /** 네트워크 끝점(axios 등). base 는 baseURL */
  | { k: 'sink'; sink: string; base?: Val }
  /** Options API 의 this */
  | { k: 'this' }
  /** 해석 못 한 외부 패키지 값 (member 를 붙여도 unknown 이 되지 않게 따로 둔다) */
  | { k: 'ext'; source: string; path: string[] };

export const lit = (s: string): Val => ({ k: 'lit', s });
export const unknown = (why: string): Val => ({ k: 'unknown', why });

/** 인접한 문자열을 합치고 중첩 concat 을 편다 */
export function concat(parts: Val[]): Val {
  const flat: Val[] = [];
  for (const p of parts) {
    if (p.k === 'concat') flat.push(...p.parts);
    else flat.push(p);
  }
  const out: Val[] = [];
  for (const p of flat) {
    const last = out[out.length - 1];
    if (p.k === 'lit' && last?.k === 'lit') out[out.length - 1] = lit(last.s + p.s);
    else if (!(p.k === 'lit' && p.s === '')) out.push(p);
  }
  if (out.length === 0) return lit('');
  if (out.length === 1) return out[0];
  return { k: 'concat', parts: out };
}

export function alt(options: Val[]): Val {
  const flat: Val[] = [];
  for (const o of options) {
    if (o.k === 'alt') flat.push(...o.options);
    else flat.push(o);
  }
  const uniq = flat.filter((v, i) => flat.findIndex((w) => sameVal(w, v)) === i);
  return uniq.length === 1 ? uniq[0] : { k: 'alt', options: uniq.slice(0, 8) };
}

export function sameVal(a: Val, b: Val): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** param 을 실제 인자로 치환 (얕은 구조 전체) */
export function subst(v: Val, args: Val[]): Val {
  switch (v.k) {
    case 'param':
      return args[v.i] ?? unknown(`인자 '${v.name}' 없음`);
    case 'concat':
      return concat(v.parts.map((p) => subst(p, args)));
    case 'member':
      return { ...v, base: subst(v.base, args) };
    case 'call':
      return { k: 'call', callee: subst(v.callee, args), args: v.args.map((a) => subst(a, args)) };
    case 'alt':
      return alt(v.options.map((o) => subst(o, args)));
    case 'obj': {
      const members: Record<string, Val> = {};
      for (const [k, m] of Object.entries(v.members)) members[k] = subst(m, args);
      return { k: 'obj', members };
    }
    case 'sink':
      return v.base ? { ...v, base: subst(v.base, args) } : v;
    default:
      return v;
  }
}

export interface Rendered {
  text: string;
  /** 알 수 없는 부분의 이유 (없으면 전부 확정) */
  unknowns: string[];
}

/** 최종 값(lit/concat/unknown/alt 만 남은 상태)을 문자열로. alt 는 후보마다 하나씩 */
export function render(v: Val): Rendered[] {
  switch (v.k) {
    case 'lit':
      return [{ text: v.s, unknowns: [] }];
    case 'unknown':
      return [{ text: '{}', unknowns: [v.why] }];
    case 'param':
      return [{ text: '{}', unknowns: [`인자 '${v.name}'`] }];
    case 'alt': {
      const out: Rendered[] = [];
      for (const o of v.options) out.push(...render(o));
      return out.slice(0, 6);
    }
    case 'concat': {
      let acc: Rendered[] = [{ text: '', unknowns: [] }];
      for (const p of v.parts) {
        const rs = render(p);
        const next: Rendered[] = [];
        for (const a of acc) for (const r of rs) next.push({ text: a.text + r.text, unknowns: [...a.unknowns, ...r.unknowns] });
        acc = next.slice(0, 6);
      }
      return acc;
    }
    default:
      return [{ text: '{}', unknowns: [describe(v)] }];
  }
}

export function describe(v: Val): string {
  switch (v.k) {
    case 'lit': return JSON.stringify(v.s);
    case 'param': return `인자 ${v.name}`;
    case 'unknown': return v.why;
    case 'import': return `${v.source} 의 ${v.imported}`;
    case 'member': return `${describe(v.base)}.${v.prop}`;
    case 'call': return `${describe(v.callee)}() 의 결과`;
    case 'alt': return v.options.map(describe).join(' | ');
    case 'obj': return '객체';
    case 'fn': return `함수 ${v.id}`;
    case 'sink': return `끝점 ${v.sink}`;
    case 'this': return 'this';
    case 'ext': return [v.source, ...v.path].join('.');
    case 'concat': return v.parts.map(describe).join(' + ');
  }
}
