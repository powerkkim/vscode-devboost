/**
 * 가벼운 Java 구조 파서 (정규식 + 괄호 짝 맞추기). Spring/MyBatis 흐름 추적에 필요한 것만 뽑는다:
 * 클래스·어노테이션·필드·메서드(시그니처, 본문)·생성자 파라미터.
 * 완전한 Java 파서가 아니므로 제네릭/람다 안쪽 같은 복잡한 코드는 일부 놓칠 수 있다.
 */
export interface Ann {
  name: string;
  /** 괄호 안 원문 (문자열 리터럴 유지) */
  args: string;
}
export interface Param {
  type: string; // 제네릭·패키지 제거한 단순 이름
  name: string;
}
export interface JavaMethod {
  name: string;
  line: number;
  annotations: Ann[];
  params: Param[];
  returnType: string;
  /** 본문(문자열 내용은 가려진 상태) — 호출 분석용. 추상 메서드는 null */
  body: string | null;
  /** 본문(문자열 유지) — "namespace.id" 같은 문자열 인자 읽기용. body 와 같은 길이 */
  bodyText: string | null;
}
export interface JavaClass {
  name: string;
  fqcn: string;
  pkg: string;
  file: string;
  line: number;
  kind: 'class' | 'interface' | 'enum' | 'record';
  annotations: Ann[];
  implements: string[];
  extends: string[];
  imports: string[];
  fields: Param[];
  ctorParams: Param[];
  methods: JavaMethod[];
}

/** 주석을 공백으로 바꾸고(줄바꿈 유지), 문자열 내용을 가린 버전도 같이 만든다. 둘 다 원본과 길이가 같다. */
export function maskSource(src: string): { plain: string; masked: string } {
  const plain = src.split('');
  const masked = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(plain, i, j); blank(masked, i, j); i = j;
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      blank(plain, i, j); blank(masked, i, j); i = j;
    } else if (c === '"' && src.startsWith('"""', i)) {
      let j = src.indexOf('"""', i + 3);
      j = j < 0 ? n : j + 3;
      blank(masked, i + 3, j - 3); i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(masked, i + 1, j); // 따옴표는 남기고 내용만 가림
      i = j + 1;
    } else {
      i++;
    }
  }
  return { plain: plain.join(''), masked: masked.join('') };
}

function lineStarts(src: string): number[] {
  const a = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') a.push(i + 1);
  return a;
}
function lineAt(starts: number[], idx: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** idx 의 여는 괄호에 대응하는 닫는 괄호 위치 (masked 기준). 없으면 -1 */
function matchClose(masked: string, idx: number): number {
  const open = masked[idx];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : '>';
  let depth = 0;
  for (let i = idx; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

export function simpleType(t: string): string {
  let s = t.trim().replace(/@\w+(\([^)]*\))?\s*/g, '').replace(/\bfinal\b/g, '').trim();
  // 제네릭 제거 (중첩 대응)
  let depth = 0, out = '';
  for (const c of s) {
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (depth === 0) out += c;
  }
  s = out.replace(/\[\]|\.\.\./g, '').trim();
  return s.split('.').pop() ?? s;
}

function splitTopLevel(s: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0, cur = '', inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; } else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if ('(<{['.includes(c)) depth++;
    else if (')>}]'.includes(c)) depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 앞쪽의 어노테이션들을 떼어 내고 [어노테이션 목록, 나머지 시그니처] 를 돌려준다 */
function takeAnnotations(text: string): [Ann[], string] {
  const anns: Ann[] = [];
  let rest = text.trimStart();
  for (;;) {
    const m = rest.match(/^@([\w.]+)\s*/);
    if (!m || m[1] === 'interface') break;
    let args = '';
    let after = rest.slice(m[0].length);
    if (after.startsWith('(')) {
      const close = matchClose(after, 0);
      if (close < 0) break;
      args = after.slice(1, close);
      after = after.slice(close + 1);
    }
    anns.push({ name: m[1].split('.').pop()!, args });
    rest = after.trimStart();
  }
  return [anns, rest];
}

function parseParams(s: string): Param[] {
  return splitTopLevel(s)
    .map((p) => {
      const [, sig] = takeAnnotations(p.trim());
      // 파라미터 앞에 붙은 어노테이션이 여러 개이거나 공백이 섞여도 마지막 토큰이 이름
      const clean = sig.replace(/\bfinal\b/g, '').trim();
      const m = clean.match(/^([\s\S]+?)\s+(\w+)$/);
      return m ? { type: simpleType(m[1]), name: m[2] } : null;
    })
    .filter((x): x is Param => !!x);
}

const MODS = '(?:(?:public|protected|private|static|final|abstract|synchronized|default|native|transient|volatile|strictfp)\\s+)*';
const METHOD_RE = new RegExp(`^${MODS}(?:<[^>]*>\\s+)?([\\w.<>\\[\\],?&\\s]+?)\\s+(\\w+)\\s*\\(([\\s\\S]*)\\)\\s*(?:throws[\\s\\S]*)?$`);
const CTOR_RE = new RegExp(`^${MODS}(\\w+)\\s*\\(([\\s\\S]*)\\)\\s*(?:throws[\\s\\S]*)?$`);
const FIELD_RE = new RegExp(`^${MODS}([\\w.<>\\[\\],?\\s]+?)\\s+(\\w+)\\s*(?:=[\\s\\S]*)?$`);

export function parseJava(source: string, file: string): JavaClass[] {
  const { plain, masked } = maskSource(source);
  const starts = lineStarts(source);
  const pkg = (masked.match(/^\s*package\s+([\w.]+)\s*;/m) ?? [])[1] ?? '';
  const imports = Array.from(masked.matchAll(/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm)).map((m) => m[1]);

  // 결합 깊이( { ( ) 로 최상위 타입 선언 찾기
  const depthAt = new Int32Array(masked.length + 1);
  for (let i = 0, d = 0; i < masked.length; i++) {
    depthAt[i] = d;
    const c = masked[i];
    if (c === '{' || c === '(') d++;
    else if (c === '}' || c === ')') d = Math.max(0, d - 1);
  }

  const classes: JavaClass[] = [];
  const declRe = /\b(class|interface|enum|record)\s+(\w+)([^{;]*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(masked))) {
    if (depthAt[m.index] !== 0) continue;
    // 선언 앞의 어노테이션·수식어: 직전 최상위 문장 끝(; 또는 }) 이후부터
    let b = m.index - 1;
    while (b >= 0 && !((masked[b] === ';' || masked[b] === '}') && depthAt[b] === 0 && depthAt[b + 1] === 0)) b--;
    const [anns] = takeAnnotations(plain.slice(b + 1, m.index).replace(MODS_ONLY, ' '));
    const header = m[3];
    const impl = (header.match(/\bimplements\s+([\s\S]+?)(?=\bextends\b|$)/) ?? [])[1];
    const ext = (header.match(/\bextends\s+([\s\S]+?)(?=\bimplements\b|$)/) ?? [])[1];
    const bodyOpen = m.index + m[0].length - 1;
    const bodyClose = matchClose(masked, bodyOpen);
    if (bodyClose < 0) continue;
    const kind = m[1] as JavaClass['kind'];
    const cls: JavaClass = {
      name: m[2], fqcn: pkg ? `${pkg}.${m[2]}` : m[2], pkg, file, line: lineAt(starts, m.index),
      kind, annotations: anns,
      implements: impl ? splitTopLevel(impl).map(simpleType).filter(Boolean) : [],
      // interface 의 extends 는 여러 개일 수 있음
      extends: ext ? splitTopLevel(ext).map(simpleType).filter(Boolean) : [],
      imports, fields: [], ctorParams: [], methods: [],
    };
    parseBody(cls, plain, masked, bodyOpen + 1, bodyClose, starts);
    classes.push(cls);
    declRe.lastIndex = bodyClose;
  }
  return classes;
}

const MODS_ONLY = /\b(?:public|protected|private|static|final|abstract|sealed|strictfp)\b/g;

function parseBody(cls: JavaClass, plain: string, masked: string, from: number, to: number, starts: number[]) {
  let start = from;
  let paren = 0;
  const handle = (hs: number, he: number, blockOpen: number, blockClose: number) => {
    const headerPlain = plain.slice(hs, he);
    const headerMasked = masked.slice(hs, he);
    const [anns, sigPlain] = takeAnnotations(headerPlain);
    const [, sigMasked] = takeAnnotations(headerMasked);
    const sig = sigMasked.replace(/\s+/g, ' ').trim();
    if (!sig || /^(static\s*)?$/.test(sig)) return; // 초기화 블록
    if (/\b(class|interface|enum|record)\s+\w+/.test(sig.split('(')[0])) return; // 중첩 타입은 건너뜀
    const firstParen = sig.indexOf('(');
    const firstEq = sig.indexOf('=');
    const nameOffset = hs + (headerPlain.length - sigPlain.length);
    if (firstParen < 0 || (firstEq >= 0 && firstEq < firstParen)) {
      const f = sig.match(FIELD_RE);
      if (f && blockOpen < 0) cls.fields.push({ type: simpleType(f[1]), name: f[2] });
      return;
    }
    const sigClean = sig;
    const mm = sigClean.match(METHOD_RE);
    const cm = !mm ? sigClean.match(CTOR_RE) : null;
    // 시그니처는 masked 에서 읽었으므로 파라미터 이름/타입에는 영향 없음(문자열이 거의 없음)
    const plainSig = sigPlain.replace(/\s+/g, ' ').trim();
    if (cm && cm[1] === cls.name) {
      const pm = plainSig.match(CTOR_RE);
      cls.ctorParams = parseParams(pm ? pm[2] : cm[2]);
      return;
    }
    if (!mm) return;
    const pm = plainSig.match(METHOD_RE);
    const name = mm[2];
    const idx = plain.indexOf(name, nameOffset);
    cls.methods.push({
      name, line: lineAt(starts, idx < 0 ? hs : idx), annotations: anns,
      params: parseParams(pm ? pm[3] : mm[3]), returnType: simpleType(mm[1]),
      body: blockOpen >= 0 ? masked.slice(blockOpen + 1, blockClose) : null,
      bodyText: blockOpen >= 0 ? plain.slice(blockOpen + 1, blockClose) : null,
    });
  };
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (paren === 0 && c === ';') {
      handle(start, i, -1, -1);
      start = i + 1;
    } else if (paren === 0 && c === '{') {
      const close = matchClose(masked, i);
      if (close < 0) return;
      handle(start, i, i, close);
      start = close + 1;
      i = close;
    }
  }
}
