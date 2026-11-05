import * as path from 'path';

/**
 * Mapper 탭의 본문 검색에서 쓰는 순수 로직 (vscode 모듈에 의존하지 않아 단독 테스트 가능).
 */

/** 본문 검색을 돌릴 폴더가 이보다 많으면 워크스페이스 전체에서 찾는다 (rg 명령줄이 너무 길어지지 않게) */
export const MAX_MAPPER_DIRS = 50;

/**
 * 본문 검색을 돌릴 폴더: mapper XML 이 들어 있는 폴더들 (다른 폴더 안에 든 폴더는 뺀다).
 * 워크스페이스 전체를 훑지 않고 mapper 폴더만 읽게 해서 빠르고, pom.xml·설정 XML 이 결과 한도를 차지하지 않는다.
 * 폴더가 너무 많으면 fallback(워크스페이스 폴더)을 그대로 쓴다
 */
export function mapperSearchRoots(xmlFiles: Iterable<string>, fallback: string[], maxDirs = MAX_MAPPER_DIRS): string[] {
  const dirs = [...new Set([...xmlFiles].map((f) => path.dirname(f)))].sort();
  const top: string[] = [];
  for (const d of dirs) {
    // 정렬돼 있어 상위 폴더가 하위 폴더보다 먼저 나온다 (바로 앞은 아닐 수 있다: mapper, mapper2, mapper\order).
    // 구분자까지 붙여 비교 (mapper 와 mapper2 를 같은 폴더로 보지 않게)
    if (top.some((t) => d.startsWith(t.endsWith(path.sep) ? t : t + path.sep))) continue;
    top.push(d);
    if (top.length > maxDirs) return fallback;
  }
  return top.length ? top : fallback;
}

/** 이름으로 찾은 것 (파일명·SQL id·Java mapper). 점수순으로 정렬돼 들어온다 */
export interface NameHit<T> {
  value: T;
  file: string;
  line: number;
  /** 이름에 검색어가 그대로 들어 있음 (false = 글자만 순서대로 맞음) */
  strong: boolean;
}

export interface Arranged<N, M> {
  /** 이름에 검색어가 그대로 든 것 */
  strong: N[];
  /** 본문에서 찾은 줄 */
  text: M[];
  /** 글자만 순서대로 맞은 이름 */
  weak: N[];
  /** 전체 개수 (보여 주는 것보다 많을 수 있음) */
  total: number;
}

/**
 * 이름 결과와 본문 결과를 화면 순서로 나눈다: 이름에 그대로 든 것 → 본문 → 글자만 맞은 이름.
 * 느슨하게 맞은 이름 수십 개에 본문 결과가 밀려 안 보이는 일이 없게 본문을 가운데 둔다.
 *  - 이름은 합쳐서 limit 개, 본문도 limit 개까지
 *  - 화면에 나온 이름과 같은 줄의 본문 결과는 뺀다 (같은 줄이 두 번 나오지 않게).
 *    이름이 limit 에 걸려 화면에 못 나온 줄은 본문 결과로 남긴다
 */
export function arrangeMapperResults<N, M extends { file: string; line: number }>(names: NameHit<N>[], matches: M[], limit: number): Arranged<N, M> {
  const key = (file: string, line: number) => `${file}\u0000${line}`;
  const strong: N[] = [];
  const weak: N[] = [];
  const shownLines = new Set<string>();
  const hiddenLines = new Set<string>(); // limit 에 걸려 화면에 못 나온 이름의 줄
  for (const n of names) {
    if (strong.length + weak.length >= limit) {
      hiddenLines.add(key(n.file, n.line));
      continue;
    }
    shownLines.add(key(n.file, n.line));
    (n.strong ? strong : weak).push(n.value);
  }
  const text: M[] = [];
  let textTotal = 0;
  let overlap = 0; // 이름으로도 세고 본문으로도 센 줄 (전체 개수에서 한 번만 세게)
  for (const m of matches) {
    const k = key(m.file, m.line);
    if (shownLines.has(k)) continue;
    textTotal++;
    if (hiddenLines.has(k)) overlap++;
    if (text.length < limit) text.push(m);
  }
  return { strong, text, weak, total: names.length + textTotal - overlap };
}

/** 그 줄이 들어 있는 문장: 같은 파일에서 그 줄보다 앞(같은 줄 포함)에 나온 마지막 문장 */
export function ownerStatement<S extends { line: number }>(statements: S[] | undefined, line: number): S | undefined {
  let owner: S | undefined;
  for (const s of statements ?? []) if (s.line <= line && (!owner || s.line > owner.line)) owner = s;
  return owner;
}

/** 한 파일에서 가져온 줄이 perFile 개에 닿은 파일이 있는가 (있으면 실제로는 더 많을 수 있다) */
export function hitPerFileCap(matches: { file: string }[], perFile: number): boolean {
  const n = new Map<string, number>();
  for (const m of matches) {
    const c = (n.get(m.file) ?? 0) + 1;
    if (c >= perFile) return true;
    n.set(m.file, c);
  }
  return false;
}
