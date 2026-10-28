/**
 * 이름 표기법(case) 변환. vscode 에 의존하지 않는 순수 로직이라 Node 만으로 테스트한다.
 *
 *   user_name · userName · UserName · user-name · USER_NAME · user.name  →  서로 바꿈
 *   약어는 단어로 취급: userID → user_id, XMLHttpRequest → xml_http_request
 */

export type CaseKind = 'camel' | 'pascal' | 'snake' | 'constant' | 'kebab' | 'dot';

export const CASES: { kind: CaseKind; label: string }[] = [
  { kind: 'camel', label: 'camelCase' },
  { kind: 'pascal', label: 'PascalCase' },
  { kind: 'snake', label: 'snake_case' },
  { kind: 'constant', label: 'SCREAMING_SNAKE_CASE' },
  { kind: 'kebab', label: 'kebab-case' },
  { kind: 'dot', label: 'dot.case' },
];

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** 이름을 단어 목록(소문자)으로 나눔 */
export function splitWords(name: string): string[] {
  const words: string[] = [];
  for (const chunk of name.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    const spaced = chunk
      .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
    for (const w of spaced.split(' ')) {
      if (w) words.push(w.toLowerCase());
    }
  }
  return words;
}

export function joinWords(words: string[], kind: CaseKind): string {
  switch (kind) {
    case 'camel':
      return words.map((w, i) => (i === 0 ? w : cap(w))).join('');
    case 'pascal':
      return words.map(cap).join('');
    case 'snake':
      return words.join('_');
    case 'constant':
      return words.join('_').toUpperCase();
    case 'kebab':
      return words.join('-');
    case 'dot':
      return words.join('.');
  }
}

/** 이름 하나 변환. 앞뒤의 `_` `$` 는 그대로 둔다 (_private, value_) */
export function convertName(name: string, kind: CaseKind): string {
  const m = /^([_$]*)(.*?)([_$]*)$/su.exec(name);
  if (!m) return name;
  const words = splitWords(m[2]);
  if (words.length === 0) return name;
  return m[1] + joinWords(words, kind) + m[3];
}

const TOKEN = /[\p{L}\p{N}_$]+(?:-[\p{L}\p{N}_$]+)*/gu;

/** 여러 이름이 섞인 글에서 이름마다 변환 (공백·기호·줄바꿈은 그대로). 숫자만 있는 토큰은 건드리지 않음 */
export function convertText(text: string, kind: CaseKind): string {
  return text.replace(TOKEN, (tok) => (/^\d+$/.test(tok) ? tok : convertName(tok, kind)));
}

/** 필드·컬럼 이름 만들기에 자주 쓰는 단축 */
export const toCamel = (s: string) => convertName(s, 'camel');
export const toPascal = (s: string) => convertName(s, 'pascal');
export const toSnake = (s: string) => convertName(s, 'snake');

/** 단축키로 돌려 가며 바꿀 때의 순서 (dot.case 는 커서 아래 단어 인식이 어려워 뺌 — 명령 팔레트에서는 선택 가능) */
export const CYCLE_ORDER: CaseKind[] = ['camel', 'pascal', 'snake', 'constant', 'kebab'];

/**
 * 롤업: 지금 표기의 다음(direction=1) 또는 이전(-1) 표기로 바꾼 글을 돌려준다.
 * 단일 단어(`user`)처럼 케이스를 바꿔도 같은 글이 나오는 것은 건너뛰어, 누를 때마다 눈에 보이게 바뀐다.
 * 지금 글이 어느 표기와도 맞지 않으면(`User_name` 등) 순서의 첫 번째(또는 direction=-1 이면 마지막)로 정리한다.
 */
export function cycleCase(text: string, direction: 1 | -1 = 1): string {
  const candidates: string[] = [];
  for (const kind of CYCLE_ORDER) {
    const c = convertText(text, kind);
    if (!candidates.includes(c)) candidates.push(c);
  }
  const idx = candidates.indexOf(text);
  if (idx < 0) return direction === 1 ? candidates[0] : candidates[candidates.length - 1];
  return candidates[(idx + direction + candidates.length) % candidates.length];
}
