/** 프론트 URL ↔ 백엔드 매핑 경로 비교용 */

/** '/api/users/{id:[0-9]+}?x=1' → ['api','users','{}'] */
export function pathSegments(raw: string): string[] {
  let p = raw.trim();
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, ''); // 프로토콜+호스트 제거
  p = p.replace(/[?#].*$/, '');
  const segs = p.split('/').filter((s) => s !== '');
  const out = segs.map((s) => (/\{.*\}/.test(s) || s === '?' ? '{}' : s));
  // `${baseUrl}/orders` 같은 선두 변수는 기준 경로 불명 → 버린다
  while (out.length && out[0] === '{}' && out.length > 1 && /^\{\}/.test(raw.trim())) out.shift();
  return out;
}

export function joinMapping(a: string, b: string): string {
  const j = `/${a}/${b}`.replace(/\/+/g, '/');
  return j.length > 1 ? j.replace(/\/$/, '') : j;
}

const segEq = (a: string, b: string) => a === b || a === '{}' || b === '{}';
/** 프론트 변수({}) 가 백엔드의 고정 문자열 자리에 오면 약한 일치: 어떤 값이 들어올지 모르기 때문 */
const segStrict = (front: string, back: string) => front === back || back === '{}';

export type MatchKind = 'exact' | 'loose' | 'suffix' | null;

/**
 * exact  : 세그먼트가 모두 같거나, 백엔드의 {변수} 자리에 프론트 값이 옴
 * loose  : 길이는 같지만 프론트 {} 가 백엔드의 고정 문자열과 맞춰짐 (다른 엔드포인트일 수도 있음)
 * suffix : 한쪽이 다른쪽의 뒤쪽 (컨텍스트 경로·baseURL 차이)
 */
export function matchPaths(front: string[], back: string[]): MatchKind {
  if (!front.length || !back.length) return null;
  if (front.length === back.length && front.every((s, i) => segEq(s, back[i]))) {
    return front.every((s, i) => segStrict(s, back[i])) ? 'exact' : 'loose';
  }
  const tail = (long: string[], short: string[]) =>
    short.length >= 1 && long.length > short.length && short.every((s, i) => segEq(s, long[long.length - short.length + i]));
  // 짧은 쪽이 변수로만 이루어져 있으면 의미가 없다
  const meaningful = (s: string[]) => s.some((x) => x !== '{}');
  if (meaningful(front) && tail(back, front)) return 'suffix';
  if (meaningful(back) && tail(front, back)) return 'suffix';
  return null;
}
