/**
 * import 따라가기의 계산 부분: import 문 읽기, 경로 별칭(@/…) 풀기, 대상 파일에서 export 위치 찾기.
 * vscode 모듈에 의존하지 않는다 (파일 접근은 Files 로 받아 단독 테스트가 가능).
 *
 * 프로젝트의 tsconfig 에 경로 별칭(paths)이 없으면 편집기는 `@/types/user` 를 풀지 못해,
 * 가져온 이름을 눌러도 같은 파일의 import 줄로만 간다. 여기서는 별칭을 직접 풀어 실제 선언을 찾는다.
 */

export interface Files {
  /** 파일 내용. 없으면 undefined */
  read(path: string): string | undefined;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}

export interface ImportBinding {
  /** 이 파일에서 쓰는 이름 */
  local: string;
  /** 대상 파일에서 내보낸 이름. 기본 내보내기는 'default', 통째로(* as X)는 '*' */
  imported: string;
}

export interface ImportStatement {
  /** from 뒤의 경로 글 */
  module: string;
  /** 경로 글(따옴표 안)의 위치 */
  moduleStart: number;
  moduleEnd: number;
  /** 문 전체의 위치 */
  start: number;
  end: number;
  bindings: ImportBinding[];
}

const ID = String.raw`[A-Za-z_$][\w$]*`;

/** 주석을 같은 길이의 빈칸으로 바꾼다 (위치는 그대로, 주석 안의 import·export 에 속지 않게). 따옴표 글은 건드리지 않는다 */
export function blankComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        if (c !== '`' && text[j] === '\n') break;
        j++;
      }
      out += text.slice(i, Math.min(n, j + 1));
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out += text.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `{ A, B as C, type D, default as E }` 안의 이름들 */
function namedBindings(body: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const part of body.split(',')) {
    const m = new RegExp(String.raw`^\s*(?:type\s+)?(${ID}|default)(?:\s+as\s+(${ID}))?\s*$`).exec(part);
    if (m) out.push({ imported: m[1], local: m[2] ?? m[1] });
  }
  return out;
}

const IMPORT_RE = new RegExp(
  String.raw`(?:^|[\n;>])[ \t]*import\s+(?:type\s+)?(?:(${ID})\s*,?\s*)?(?:\*\s*as\s+(${ID})|\{([^}]*)\})?\s*from\s*(['"])([^'"\n]+)\4`,
  'g'
);

/** 글 안의 import 문들 (.vue 는 파일 전체를 그대로 넣어도 된다) */
export function parseImports(text: string): ImportStatement[] {
  const src = blankComments(text);
  const out: ImportStatement[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src))) {
    const bindings: ImportBinding[] = [];
    if (m[1]) bindings.push({ local: m[1], imported: 'default' });
    if (m[2]) bindings.push({ local: m[2], imported: '*' });
    if (m[3] !== undefined) bindings.push(...namedBindings(m[3]));
    const end = m.index + m[0].length;
    const moduleEnd = end - 1;
    out.push({ module: m[5], moduleStart: moduleEnd - m[5].length, moduleEnd, start: src.indexOf('import', m.index), end, bindings });
  }
  return out;
}

export type Aliases = Record<string, string>;

/**
 * vite.config 의 resolve.alias 에서 "별칭 → 폴더(설정 파일 기준 상대 경로)" 를 읽는다. 흔한 모양만:
 *   '@': fileURLToPath(new URL('./src', import.meta.url))   '@': path.resolve(__dirname, 'src')
 *   '@': resolve(__dirname, './src')   '@': '/src'   { find: '@', replacement: path.resolve(__dirname, 'src') }
 */
export function parseViteAliases(configText: string): Aliases {
  const src = blankComments(configText);
  const at = src.search(/\balias\s*:/);
  const out: Aliases = {};
  if (at < 0) return out;
  // alias: 뒤의 { … } 또는 [ … ] 한 덩어리
  const open = src.slice(at).search(/[{[]/);
  if (open < 0) return out;
  const from = at + open;
  let depth = 0;
  let to = from;
  for (; to < src.length; to++) {
    const c = src[to];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = src.slice(from, to + 1);
  /** 식 안의 경로 글: import.meta.url 같은 것을 빼고 마지막 따옴표 글 */
  const pathIn = (expr: string): string | undefined => {
    const strs = [...expr.matchAll(/(['"`])([^'"`\n]*)\1/g)].map((x) => x[2]).filter((x) => x !== '' && !/^(file|https?):/.test(x));
    return strs.length ? strs[strs.length - 1] : undefined;
  };
  const put = (key: string, p: string | undefined) => {
    if (p === undefined || !key) return;
    out[key] = p.replace(/^\/(?=[\w.])/, './'); // '/src' 는 프로젝트 기준
  };
  // { find: '@', replacement: … }
  for (const m of block.matchAll(/find\s*:\s*(['"])([^'"]+)\1\s*,\s*replacement\s*:\s*([^\n}]+)/g)) put(m[2], pathIn(m[3]));
  // '@': …  /  '@components': …  (값은 그 줄 끝이나 다음 키 앞까지)
  for (const m of block.matchAll(/(?:^|[{,\n])\s*(?:(['"])([^'"\n]+)\1|([@~\w$-]+))\s*:\s*([^\n]+)/g)) {
    const key = m[2] ?? m[3];
    if (key === 'find' || key === 'replacement' || key === 'alias' || key in out) continue;
    put(key, pathIn(m[4]));
  }
  return out;
}

/** tsconfig/jsconfig 의 compilerOptions.paths ("@/*": ["src/*"]) → 별칭. baseUrl 기준 경로를 설정 파일 기준으로 돌려준다 */
export function parseTsconfigAliases(text: string): Aliases {
  const out: Aliases = {};
  try {
    const json = JSON.parse(blankComments(text).replace(/,(\s*[}\]])/g, '$1'));
    const co = json?.compilerOptions ?? {};
    const base = typeof co.baseUrl === 'string' ? co.baseUrl : '.';
    for (const [k, v] of Object.entries(co.paths ?? {})) {
      const first = Array.isArray(v) ? v[0] : undefined;
      if (typeof first !== 'string') continue;
      out[k.replace(/\/\*$/, '')] = joinPath(base, first.replace(/\/\*$/, ''));
    }
  } catch {
    // 읽을 수 없는 설정은 없는 것으로
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, '/');

export function dirname(p: string): string {
  const s = norm(p);
  const i = s.lastIndexOf('/');
  return i <= 0 ? s.slice(0, i + 1) || '.' : s.slice(0, i);
}

/** 경로 잇기 (./ 와 ../ 를 정리). b 가 절대 경로면 b */
export function joinPath(a: string, b: string): string {
  const bb = norm(b);
  if (/^(?:[A-Za-z]:)?\//.test(bb)) return bb;
  const parts = norm(a).split('/');
  for (const seg of bb.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** 별칭으로 시작하는 경로면 실제 경로로. 가장 긴 별칭부터 맞춘다. 별칭이 아니면 undefined */
export function applyAlias(spec: string, aliases: Aliases, root: string): string | undefined {
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (spec === k) return joinPath(root, aliases[k]);
    const prefix = k.endsWith('/') ? k : k + '/';
    if (spec.startsWith(prefix)) return joinPath(joinPath(root, aliases[k]), spec.slice(prefix.length));
  }
  return undefined;
}

const EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.vue'];

/** 확장자·index 를 붙여 실제 파일을 찾는다 */
export function resolveFile(base: string, files: Files): string | undefined {
  if (files.exists(base) && !files.isDirectory(base)) return base;
  // './user.js' 로 적고 실제는 user.ts 인 경우
  const bare = base.replace(/\.(?:js|mjs|jsx)$/, '');
  for (const b of bare === base ? [base] : [base, bare]) {
    for (const e of EXTS) if (files.exists(b + e)) return b + e;
  }
  if (files.isDirectory(base)) {
    for (const e of EXTS) if (files.exists(base + '/index' + e)) return base + '/index' + e;
  }
  return undefined;
}

export interface Target {
  file: string;
  /** 이름의 위치 */
  start: number;
  end: number;
  /** 선언 전체(본문 끝까지)의 위치 — 미리보기에 쓴다 */
  declStart: number;
  declEnd: number;
}

/** 선언이 시작하는 자리에서 본문 끝(닫는 중괄호나 ;)까지 */
function declEnd(text: string, from: number): number {
  let depth = 0;
  let seenBrace = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      i = j;
    } else if (c === '{' || c === '(' || c === '[') {
      depth++;
      if (c === '{') seenBrace = true;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth <= 0 && c === '}' && seenBrace) {
        // 함수·클래스·interface 는 } 에서 끝. 값(const x = {…} as const;)은 줄 끝까지
        const nl = text.indexOf('\n', i);
        const rest = text.slice(i + 1, nl < 0 ? text.length : nl);
        return /^\s*(?:as\s+const\s*)?;?\s*$/.test(rest) ? i + 1 + rest.replace(/\s+$/, '').length : i + 1;
      }
      if (depth < 0) return i;
    } else if (depth === 0 && c === ';') {
      return i + 1;
    } else if (depth === 0 && c === '\n' && !seenBrace) {
      // ; 없이 끝나는 한 줄 선언: 다음 줄이 이어지는 모양(|, &, ., ?, :, =)이 아니면 끝
      const next = /^[ \t]*(\S)/.exec(text.slice(i + 1))?.[1];
      const prev = text.slice(from, i).replace(/\s+$/, '').slice(-1);
      if (next !== undefined && !'|&.?:=+-*/,'.includes(next) && !'|&=,:+-*/<({['.includes(prev)) return i;
    }
  }
  return text.length;
}

const DECL = String.raw`(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function\s*\*?|class|interface|type|enum|namespace)`;

/** 파일 안에서 이름 name 을 선언한 자리 (export 여부와 무관) */
function findDeclaration(src: string, name: string): { start: number; declStart: number } | undefined {
  const re = new RegExp(String.raw`(^|\n)([ \t]*(?:export\s+(?:default\s+)?)?${DECL}\s+)(${escapeRe(name)})(?![\w$])`, 'g');
  const m = re.exec(src);
  if (!m) return undefined;
  const declStart = m.index + m[1].length + (m[2].length - m[2].trimStart().length);
  return { start: m.index + m[1].length + m[2].length, declStart };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** .vue 파일이면 <script> 안만 남기고 나머지는 빈칸으로 (위치는 그대로) */
function scriptOnly(file: string, text: string): string {
  if (!file.endsWith('.vue')) return text;
  let out = text.replace(/[^\n]/g, ' ');
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const s = m.index! + m[0].indexOf('>') + 1;
    out = out.slice(0, s) + m[1] + out.slice(s + m[1].length);
  }
  return out;
}

export interface Resolver {
  /** fromFile 의 import 경로 spec 이 가리키는 파일 */
  module(spec: string, fromFile: string): string | undefined;
}

/**
 * file 에서 내보낸 name 의 선언을 찾는다. `export { A } from './a'` · `export * from './a'` 는 따라간다 (최대 6단계).
 * 기본 내보내기는 name = 'default'. 못 찾으면 파일 맨 위를 돌려준다 (파일은 맞으므로)
 */
export function findExport(file: string, name: string, files: Files, resolver: Resolver, depth = 0, seen = new Set<string>()): Target | undefined {
  const key = file + '\n' + name;
  if (depth > 6 || seen.has(key)) return undefined;
  seen.add(key);
  const raw = files.read(file);
  if (raw === undefined) return undefined;
  const src = blankComments(scriptOnly(file, raw));
  const at = (start: number, len: number, declStart: number): Target => ({ file, start, end: start + len, declStart, declEnd: declEnd(src, declStart) });
  const top: Target = { file, start: 0, end: 0, declStart: 0, declEnd: 0 };

  if (name === '*') return top;
  if (name === 'default') {
    if (file.endsWith('.vue')) return top; // 컴포넌트 자체
    const m = /(^|\n)[ \t]*export\s+default\s+/.exec(src);
    if (m) {
      const s = m.index + m[0].length;
      const id = new RegExp(String.raw`^(?:(?:async\s+)?function\s*\*?\s*|class\s+)?(${ID})?`).exec(src.slice(s));
      const ident = id?.[1];
      const isDecl = /^(?:async\s+)?function|^class/.test(src.slice(s));
      if (ident && !isDecl && new RegExp(String.raw`^${escapeRe(ident)}\s*;?\s*(\n|$)`).test(src.slice(s))) {
        const d = findDeclaration(src, ident); // export default Name;
        if (d) return at(d.start, ident.length, d.declStart);
      }
      const declStart = m.index + m[1].length + (m[0].length - m[1].length - m[0].trimStart().length + 0);
      return ident && isDecl ? at(s + (id![0].length - ident.length), ident.length, declStart) : at(s, 0, declStart);
    }
    const re = /export\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"\n]+)\2)?/g;
    let e: RegExpExecArray | null;
    while ((e = re.exec(src))) {
      for (const b of namedBindings(e[1])) {
        if (b.local !== 'default') continue;
        if (e[3]) {
          const f = resolver.module(e[3], file);
          const t = f && findExport(f, b.imported, files, resolver, depth + 1, seen);
          if (t) return t;
        } else {
          const d = findDeclaration(src, b.imported);
          if (d) return at(d.start, b.imported.length, d.declStart);
        }
      }
    }
    return top;
  }

  // export const|function|class|interface|type|enum Name
  const direct = new RegExp(String.raw`(^|\n)([ \t]*export\s+${DECL}\s+)(${escapeRe(name)})(?![\w$])`).exec(src);
  if (direct) {
    const declStart = direct.index + direct[1].length + (direct[2].length - direct[2].trimStart().length);
    return at(direct.index + direct[1].length + direct[2].length, name.length, declStart);
  }
  // export { X as Name } / export { Name } [from '…']
  const re = /export\s*(?:type\s*)?\{([^}]*)\}\s*(?:from\s*(['"])([^'"\n]+)\2)?/g;
  let e: RegExpExecArray | null;
  while ((e = re.exec(src))) {
    for (const b of namedBindings(e[1])) {
      if (b.local !== name) continue;
      if (e[3]) {
        const f = resolver.module(e[3], file);
        const t = f && findExport(f, b.imported, files, resolver, depth + 1, seen);
        if (t) return t;
      } else {
        const d = findDeclaration(src, b.imported);
        if (d) return at(d.start, b.imported.length, d.declStart);
      }
    }
  }
  // export * from '…' / export * as NS from '…'
  for (const s of src.matchAll(/export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*(['"])([^'"\n]+)\2/g)) {
    const f = resolver.module(s[3], file);
    if (!f) continue;
    if (s[1]) {
      if (s[1] === name) return { file: f, start: 0, end: 0, declStart: 0, declEnd: 0 };
      continue;
    }
    const t = findExport(f, name, files, resolver, depth + 1, seen);
    if (t && (t.end > t.start || t.declEnd > t.declStart)) return t;
  }
  // 내보내기를 못 찾았어도 선언이 있으면 거기 (declare global, .d.ts 등)
  const d = findDeclaration(src, name);
  return d ? at(d.start, name.length, d.declStart) : depth === 0 ? top : undefined;
}

/** offset 자리의 이름 (템플릿의 <user-card> 같은 kebab 이름도 한 낱말로) */
export function wordAt(text: string, offset: number): { word: string; start: number; end: number } | undefined {
  const isId = (c: string) => /[\w$-]/.test(c);
  let s = offset;
  let e = offset;
  while (s > 0 && isId(text[s - 1])) s--;
  while (e < text.length && isId(text[e])) e++;
  let word = text.slice(s, e);
  // 앞뒤의 - 와, a-b 처럼 뺄셈일 수 있는 것은 템플릿 태그가 아니면 식별자 하나로 줄인다
  if (word.includes('-') && !/^<\/?$/.test(text.slice(Math.max(0, s - 2), s).replace(/^[^<]*(?=<)/, ''))) {
    let ls = offset;
    let le = offset;
    const id = (c: string) => /[\w$]/.test(c);
    while (ls > s && id(text[ls - 1])) ls--;
    while (le < e && id(text[le])) le++;
    s = ls;
    e = le;
    word = text.slice(s, e);
  }
  return word && /^[A-Za-z_$]/.test(word) ? { word, start: s, end: e } : undefined;
}

/** user-card → UserCard */
export function pascal(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

export interface Hit {
  statement: ImportStatement;
  /** 누른 것이 경로 글이면 undefined (파일 자체), 이름이면 그 이름 */
  binding?: ImportBinding;
  /** 누른 낱말의 위치 */
  start: number;
  end: number;
}

/** offset 자리가 import 로 가져온 이름(쓰는 곳·import 줄)이거나 import 경로 글이면 그 정보 */
export function hitAt(text: string, offset: number, imports: ImportStatement[]): Hit | undefined {
  for (const st of imports) {
    if (offset >= st.moduleStart && offset <= st.moduleEnd) return { statement: st, start: st.moduleStart, end: st.moduleEnd };
  }
  const w = wordAt(text, offset);
  if (!w) return undefined;
  // import 줄 안에서 `B as C` 의 B(원래 이름)를 누른 경우
  for (const st of imports) {
    if (offset < st.start || offset > st.end) continue;
    const b = st.bindings.find((x) => x.local === w.word) ?? st.bindings.find((x) => x.imported === w.word);
    return b ? { statement: st, binding: b, start: w.start, end: w.end } : undefined;
  }
  if (text[w.start - 1] === '.') return undefined; // obj.name 의 name 은 가져온 이름이 아니다
  const names = w.word.includes('-') ? [pascal(w.word)] : [w.word];
  for (const st of imports) {
    const b = st.bindings.find((x) => names.includes(x.local));
    if (b) return { statement: st, binding: b, start: w.start, end: w.end };
  }
  return undefined;
}
