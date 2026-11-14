/**
 * 정규식 작업대의 패턴 만들기 (vscode 를 쓰지 않는다): 직접 만들기(compose) · 질문 따라가기(ask) · 예시로 만들기(guess),
 * 코드에 붙여 넣을 글(toCode), 자주 쓰는 정규식 읽기(parsePresets).
 * 만든 패턴은 JavaScript 와 Java 에서 같은 뜻이 되는 꼴만 쓴다.
 */
export type Repeat = 'ONCE' | 'OPTIONAL' | 'ONE_OR_MORE' | 'ZERO_OR_MORE' | 'EXACTLY' | 'AT_LEAST' | 'RANGE';
/** 조각이 맞출 글자를 정하는 방식: 종류에서 고르기 · 정해진 낱말(쉼표로 여럿이면 그중 하나) · 아무 글자 · 이 글자 빼고 */
export type Source = 'KINDS' | 'WORDS' | 'ANY' | 'EXCEPT';

/** "종류에서 고르기" 의 글자 종류 → [ ] 안에 넣을 꼴. SYMBOL 은 ASCII 문장 부호 전부 */
export const KINDS = { KOREAN: '가-힣', UPPER: 'A-Z', LOWER: 'a-z', DIGIT: '0-9', SPACE: '\\s', SYMBOL: '!-/:-@\\[-`{-~' } as const;
export type CharKind = keyof typeof KINDS;
const KIND_ORDER = Object.keys(KINDS) as CharKind[];

/** 글 전체 모양일 때 "꼭 들어가야 할 것". 각각 글 어딘가에 하나 이상 있어야 한다 */
export const NEEDS = { LETTER: '[A-Za-z]', UPPER: '[A-Z]', LOWER: '[a-z]', DIGIT: '\\d', SYMBOL: `[${KINDS.SYMBOL}]`, KOREAN: '[가-힣]' } as const;
export type Need = keyof typeof NEEDS;
const NEED_ORDER = Object.keys(NEEDS) as Need[];

/** 반복 · 꺼내기 설정. lazy 는 "가능한 짧게", name 은 비면 번호 그룹 */
export interface Repeating {
  repeat: Repeat;
  n?: number;
  m?: number;
  lazy?: boolean;
  capture?: boolean;
  name?: string;
}
const ONCE: Repeating = { repeat: 'ONCE' };
const ONE_OR_MORE: Repeating = { repeat: 'ONE_OR_MORE' };

/**
 * 조각 하나. text 는 KINDS 에서 더할 글자, WORDS 에서 쉼표로 가른 낱말, EXCEPT 에서 뺄 글자.
 * before · after 는 이 조각 바로 앞에 있어야 / 바로 뒤에 와야 하는 글자(값에는 들어가지 않음)
 */
export interface Piece {
  source: Source;
  kinds?: CharKind[];
  text?: string;
  repeating?: Repeating;
  before?: string;
  after?: string;
}
/** 여러 조각을 함께 반복 · 꺼내는 묶음. anyOf 면 안의 조각 가운데 하나(또는), 아니면 차례로 */
export interface Bunch {
  pieces: Piece[];
  anyOf?: boolean;
  repeating?: Repeating;
}
export type Part = Piece | Bunch;
const isBunch = (p: Part): p is Bunch => Array.isArray((p as Bunch).pieces);

/** 글 모양 전체 설정. whole 이면 글 전체(^…$), wordOnly 면 낱말 단위, needs · minLength 는 whole 일 때만 쓴다 */
export interface Shape {
  whole?: boolean;
  wordOnly?: boolean;
  needs?: Need[];
  minLength?: number;
}

export const PROBLEMS = {
  NO_KINDS: '글자 종류를 하나 이상 고르거나 "이 글자도" 에 글자를 넣으세요.',
  NO_WORDS: '낱말을 넣으세요.',
  NO_EXCEPT: '뺄 글자를 넣으세요.',
  RANGE: 'N 이 M 보다 클 수 없습니다.',
  NAME: '이름은 영문으로 시작하고 영문 · 숫자만 씁니다.',
  EMPTY_GROUP: '묶음 안에 조각이 없습니다. 묶음에 조각을 더하세요.',
  DUPLICATE_NAME: '꺼내는 이름이 두 곳에서 같습니다. 이름을 서로 다르게 하세요.',
} as const;
export type PartProblem = keyof typeof PROBLEMS;

// 묶음 밖 · 안에서 앞에 \ 를 붙일 글자. 모두 JS u 모드에서도 허용되는 이스케이프다
const SPECIAL = '\\^$.|?*+()[]{}/';
const CLASS_SPECIAL = '\\]^-[';
/** 이름 붙은 그룹의 이름. Java 가 받는 꼴이며 JavaScript 도 받는다 */
const GROUP_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const ANY_CHAR = '[\\s\\S]';
const SURROGATE_PAIR = '[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]';
/** 낱말 단위의 낱말 글자. \b 는 ASCII 기준이라 한글 옆에서 맞지 않으므로 앞뒤 보기로 직접 건다 */
const WORD_CHAR = '[가-힣A-Za-z0-9_]';

const rep = (r?: Repeating) => r ?? ONCE;
const escape = (text: string, special: string) => [...text].map((c) => (special.includes(c) ? '\\' + c : c)).join('');
/** 같은 글자는 한 번만 넣는다 */
const classChars = (text: string) => escape([...new Set(text)].join(''), CLASS_SPECIAL);

/** 쉼표로 가른 낱말. 앞뒤 공백은 떼고 빈 것 · 겹친 것은 뺀다 */
export function words(text: string): string[] {
  return [...new Set(text.split(',').map((w) => w.trim()).filter(Boolean))];
}

function repeatProblem(r: Repeating): PartProblem | undefined {
  if (r.repeat === 'RANGE' && (r.n ?? 0) > (r.m ?? 0)) return 'RANGE';
  if (r.capture && r.name && !GROUP_NAME.test(r.name)) return 'NAME';
  return undefined;
}

/** 패턴을 만들 수 없게 고른 점. 묶음은 안의 조각 문제를 먼저 돌려준다 */
export function partProblem(part: Part): PartProblem | undefined {
  if (isBunch(part)) {
    if (!part.pieces.length) return 'EMPTY_GROUP';
    for (const p of part.pieces) {
      const inner = partProblem(p);
      if (inner) return inner;
    }
    return repeatProblem(rep(part.repeating));
  }
  const text = part.text ?? '';
  if (part.source === 'KINDS' && !part.kinds?.length && !text) return 'NO_KINDS';
  if (part.source === 'WORDS' && !words(text).length) return 'NO_WORDS';
  if (part.source === 'EXCEPT' && !text) return 'NO_EXCEPT';
  return repeatProblem(rep(part.repeating));
}

/** 조합 전체의 고칠 점. 줄마다 보고, 없으면 두 곳 이상이 같은 이름으로 꺼내는지 본다 */
export function problem(parts: Part[]): PartProblem | undefined {
  const names = new Set<string>();
  for (const part of parts) {
    const p = partProblem(part);
    if (p) return p;
    for (const r of isBunch(part) ? [rep(part.repeating), ...part.pieces.map((x) => rep(x.repeating))] : [rep(part.repeating)]) {
      if (!r.capture || !r.name) continue;
      if (names.has(r.name)) return 'DUPLICATE_NAME';
      names.add(r.name);
    }
  }
  return undefined;
}

/** text 의 BMP 밖 글자(이모지)를 겹치지 않게, 나머지 글자는 bmp 로 */
function split(text: string): { bmp: string; astral: string[] } {
  const astral: string[] = [];
  let bmp = '';
  for (const ch of text) {
    if (ch.length === 1) bmp += ch;
    else if (!astral.includes(ch)) astral.push(ch);
  }
  return { bmp, astral };
}

/**
 * 고른 종류와 더할 글자를 한 [ ] 로. 숫자만 · 공백만이면 \d · \s 로 줄인다.
 * BMP 밖 글자는 JS u 없는 모드의 [ ] 가 반쪽씩 맞추므로 (?:[…]|😀) 처럼 또는으로 붙인다
 */
function kindsAtom(kinds: CharKind[], extra: string): string {
  if (!extra && kinds.length === 1) {
    if (kinds[0] === 'DIGIT') return '\\d';
    if (kinds[0] === 'SPACE') return '\\s';
  }
  const content = KIND_ORDER.filter((k) => kinds.includes(k)).map((k) => KINDS[k]).join('');
  const { bmp, astral } = split(extra);
  const set = !content && !bmp ? '' : `[${content}${classChars(bmp)}]`;
  return astral.length ? `(?:${[set, ...astral].filter(Boolean).join('|')})` : set;
}

/** "이 글자 빼고". BMP 밖 글자는 [^ ] 대신 앞보기로 뺀다 */
function exceptAtom(text: string): string {
  const { bmp, astral } = split(text);
  if (!astral.length) return `[^${classChars(text)}]`;
  return `(?:(?!${astral.join('|')})(?:${SURROGATE_PAIR}|${bmp ? `[^${classChars(bmp)}]` : ANY_CHAR}))`;
}

function wordsAtom(list: string[]): string {
  return list.length === 1 ? escape(list[0], SPECIAL) : `(?:${list.map((w) => escape(w, SPECIAL)).join('|')})`;
}

/** 반복을 붙이려면 (?:…) 로 감싸야 하는 조각인지: UTF-16 두 칸 이상인 낱말 하나. 여러 낱말은 이미 (?:a|b) 다 */
function needsWrap(piece: Piece): boolean {
  if (piece.source !== 'WORDS') return false;
  const list = words(piece.text ?? '');
  return list.length === 1 && list[0].length > 1;
}

function wrap(atom: string, several: boolean, r: Repeating): string {
  let q = { ONCE: '', OPTIONAL: '?', ONE_OR_MORE: '+', ZERO_OR_MORE: '*', EXACTLY: `{${r.n ?? 0}}`, AT_LEAST: `{${r.n ?? 0},}`, RANGE: `{${r.n ?? 0},${r.m ?? 0}}` }[r.repeat];
  // 정확히 N번은 짧게 · 길게가 같다
  if (r.lazy && q && r.repeat !== 'EXACTLY') q += '?';
  const body = (several && q ? `(?:${atom})` : atom) + q;
  return r.capture ? (r.name ? `(?<${r.name}>` : '(') + body + ')' : body;
}

/** 꺼내기는 반복까지 감싸서((\d+)) 반복한 전체를 꺼낸다. 앞 · 뒤 조건은 꺼내기 밖에 둔다 */
export function pieceText(piece: Piece): string {
  const text = piece.text ?? '';
  const atom = piece.source === 'KINDS' ? kindsAtom(piece.kinds ?? [], text) : piece.source === 'WORDS' ? wordsAtom(words(text)) : piece.source === 'ANY' ? '.' : exceptAtom(text);
  const before = piece.before ? `(?<=${escape(piece.before, SPECIAL)})` : '';
  const after = piece.after ? `(?=${escape(piece.after, SPECIAL)})` : '';
  return before + wrap(atom, needsWrap(piece), rep(piece.repeating)) + after;
}

function bunchText(b: Bunch): string {
  const r = rep(b.repeating);
  const inner = b.pieces.map(pieceText).join(b.anyOf ? '|' : '');
  // "또는" 은 반복 · 꺼내기가 없어도 앞뒤 조각과 섞이지 않게 늘 감싼다
  const atom = b.anyOf && b.pieces.length > 1 && !r.capture && r.repeat === 'ONCE' ? `(?:${inner})` : inner;
  return wrap(atom, b.pieces.length > 1 || needsWrap(b.pieces[0]), r);
}

/** parts 를 차례로 이은 패턴. 모든 줄이 문제가 없어야 한다. 조각이 없고 조건만 있으면 본문은 "아무 글자 여럿" */
export function compose(parts: Part[], shape: Shape = {}): string {
  const body = parts.map((p) => (isBunch(p) ? bunchText(p) : pieceText(p))).join('');
  if (!shape.whole) return shape.wordOnly && body ? `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})` : body;
  let out = '^' + NEED_ORDER.filter((n) => shape.needs?.includes(n)).map((n) => `(?=.*${NEEDS[n]})`).join('');
  if (shape.minLength && shape.minLength > 0) out += `(?=.{${shape.minLength},}$)`;
  if (!body && out.length === 1) return '';
  return out + (body || '.*') + '$';
}

const ONE_SPACE: Piece = { source: 'KINDS', kinds: ['SPACE'] };

/**
 * "질문 따라가기" 답으로 만든 패턴. 한 낱말은 kinds · extra 글자로 length 만큼, spaced 면 그 낱말이 띄어쓰기 한 칸을 사이에 두고
 * 여럿 올 수 있다(예: 김 철수). whole 이면 글 전체(^…$)이고 needs 를 앞에 건다. 고른 글자가 없으면 undefined
 */
export function ask(whole: boolean, kinds: CharKind[], extra: string, length: Repeating, spaced: boolean, needs: Need[]): string | undefined {
  const word: Piece = { source: 'KINDS', kinds, text: extra, repeating: length };
  if (partProblem(word)) return undefined;
  const parts: Part[] = [word];
  if (spaced) parts.push({ pieces: [ONE_SPACE, word], repeating: { repeat: 'ZERO_OR_MORE' } });
  return compose(parts, { whole, needs: whole ? needs : [] });
}

/** 같은 종류 글자가 이어진 한 토막. kind 가 없으면 literal 글자 하나가 count 번 */
interface Run {
  kind?: CharKind;
  literal: string;
  count: number;
}
const sameRun = (a: Run, b: Run) => (a.kind ? a.kind === b.kind : !b.kind && a.literal === b.literal);

/** 글자의 종류. 특수문자는 종류로 넓히지 않고 그 글자 그대로 쓴다 */
function kindOf(ch: string): CharKind | undefined {
  if (ch >= '가' && ch <= '힣') return 'KOREAN';
  if (ch >= 'A' && ch <= 'Z') return 'UPPER';
  if (ch >= 'a' && ch <= 'z') return 'LOWER';
  if (ch >= '0' && ch <= '9') return 'DIGIT';
  return ch === ' ' || ch === '\t' ? 'SPACE' : undefined;
}

function runsOf(text: string): Run[] {
  const out: Run[] = [];
  for (const ch of text) {
    const kind = kindOf(ch);
    const run: Run = { kind, literal: kind ? '' : ch, count: 1 };
    const last = out[out.length - 1];
    if (last && sameRun(last, run)) last.count++;
    else out.push(run);
  }
  return out;
}

function count(min: number, max: number): Repeating {
  return min === max ? (min === 1 ? ONCE : { repeat: 'EXACTLY', n: min }) : { repeat: 'RANGE', n: min, m: max };
}

/** 토막마다 한 조각. anyLength 면 글자 종류 토막은 "하나 이상", 아니면 예시의 최소~최대 길이. 특수문자 토막은 늘 길이 그대로 */
function sequence(shapes: Run[][], anyLength: boolean): string {
  const parts: Part[] = shapes[0].map((run, i) => {
    const counts = shapes.map((s) => s[i].count);
    const repeating = anyLength && run.kind ? ONE_OR_MORE : count(Math.min(...counts), Math.max(...counts));
    return run.kind ? { source: 'KINDS', kinds: [run.kind], repeating } : { source: 'KINDS', kinds: [], text: run.literal, repeating };
  });
  return compose(parts, { whole: true });
}

/** "예시로 만들기" 결과. rejectsAll 이면 틀려야 할 글이 모두 맞지 않는다 */
export interface Guess {
  pattern: string;
  rejectsAll: boolean;
}

/**
 * 맞아야 할 글(good)에 모두 맞는 글 전체 패턴(^…$)을 만든다. 빈 줄은 뺀다. good 이 비면 undefined.
 * 후보를 좁은 것부터 차례로 보고, good 에 모두 맞으면서 bad 에 하나도 맞지 않는 첫 후보를 고른다. 그런 후보가 없으면 첫 후보.
 * 후보: 1 글자 종류 차례와 길이가 같은 꼴(010-1234-5678), 2 차례만 같은 꼴, 3 띄어쓰기로 이은 낱말(김 철수),
 * 4 나온 글자 종류만으로 최소~최대 길이, 5 나온 글자 종류만으로 아무 길이
 */
export function guess(good: string[], bad: string[]): Guess | undefined {
  good = good.filter(Boolean);
  bad = bad.filter(Boolean);
  const shapes = good.map(runsOf);
  if (!shapes.length) return undefined;
  const candidates: string[] = [];
  if (shapes.every((s) => s.length === shapes[0].length && s.every((r, i) => sameRun(r, shapes[0][i])))) {
    candidates.push(sequence(shapes, false), sequence(shapes, true));
  }
  const kinds = new Set<CharKind>();
  let literals = '';
  let min = Infinity;
  let max = 0;
  for (const shape of shapes) {
    let length = 0;
    for (const run of shape) {
      length += run.count;
      if (run.kind) kinds.add(run.kind);
      else if (!literals.includes(run.literal)) literals += run.literal;
    }
    min = Math.min(min, length);
    max = Math.max(max, length);
  }
  if (kinds.has('SPACE')) {
    const spaced = ask(true, [...kinds].filter((k) => k !== 'SPACE'), literals, ONE_OR_MORE, true, []);
    if (spaced) candidates.push(spaced);
  }
  const bag = (repeating: Repeating) => compose([{ source: 'KINDS', kinds: [...kinds], text: literals, repeating }], { whole: true });
  candidates.push(bag(count(min, max)), bag(ONE_OR_MORE));
  let first: string | undefined;
  for (const c of candidates) {
    // 만든 패턴은 모두 ^…$ 라 맞으면 글 전체가 맞은 것이다
    const re = new RegExp(c);
    if (!good.every((t) => re.test(t))) continue;
    first ??= c;
    if (!bad.some((t) => re.test(t))) return { pattern: c, rejectsAll: true };
  }
  // 마지막 후보는 나온 글자를 모두 담은 + 라 good 에 늘 맞는다
  return { pattern: first ?? candidates[candidates.length - 1], rejectsAll: false };
}

/** 이스케이프되지 않은 / 앞에 \ 를 붙인다 */
function escapeSlash(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) out += c + pattern[++i];
    else out += c === '/' ? '\\/' : c;
  }
  return out;
}

const JAVA_FLAGS: Record<string, string> = { i: 'CASE_INSENSITIVE', m: 'MULTILINE', s: 'DOTALL' };

/** 코드에 붙여 넣을 글. JavaScript 는 /패턴/플래그, Java 는 Pattern.compile("…", 플래그) (g · u 는 Java 에 짝이 없다) */
export function toCode(flavor: 'js' | 'java', pattern: string, flags: string): string {
  // 빈 리터럴 // 은 JS 에서 주석이 된다
  if (flavor === 'js') return `/${pattern ? escapeSlash(pattern) : '(?:)'}/${[...'gimsu'].filter((f) => flags.includes(f)).join('')}`;
  const esc: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  const text = pattern.replace(/[\\"\n\r\t]/g, (c) => esc[c]);
  const names = Object.keys(JAVA_FLAGS).filter((f) => flags.includes(f)).map((f) => 'Pattern.' + JAVA_FLAGS[f]);
  return `Pattern.compile("${text}"${names.length ? ', ' + names.join(' | ') : ''})`;
}

/** 바꿀 글의 이름 그룹 표기를 Java 꼴로: $<이름> → ${이름}, 일치 전체 $& → $0 */
export function javaReplacement(replacement: string): string {
  return replacement.replace(/\$<(\w+)>/g, '${$1}').replace(/\$&/g, '$0');
}

/** 자주 쓰는 정규식 하나. flags 는 JS 플래그 글자(g i m s u) */
export interface Preset {
  category: string;
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  sample: string;
}

/**
 * "이름 TAB 패턴 TAB 플래그 TAB 바꿀 글 TAB 예시 글" 줄들을 읽는다. "## 분류" 줄은 그 아래 줄들의 분류다.
 * 빈 줄과 그 밖의 # 로 시작하는 줄은 건너뛴다. 예시 글의 \n 은 줄바꿈이다. 칸 수가 맞지 않으면 줄 번호와 함께 오류
 */
export function parsePresets(tsv: string): Preset[] {
  const out: Preset[] = [];
  let category = '';
  tsv.split(/\r?\n/).forEach((line, i) => {
    if (line.startsWith('## ')) {
      category = line.slice(3).trim();
      return;
    }
    if (!line.trim() || line.startsWith('#')) return;
    const cols = line.split('\t');
    if (cols.length !== 5) throw new Error(`${i + 1}번째 줄: 칸이 ${cols.length}개 (5개여야 함)`);
    out.push({ category, name: cols[0], pattern: cols[1], flags: cols[2], replacement: cols[3], sample: cols[4].replace(/\\n/g, '\n') });
  });
  return out;
}
