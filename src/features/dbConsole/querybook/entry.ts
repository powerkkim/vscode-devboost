/**
 * 쿼리 사전 항목 (.md 파일 하나 = 시나리오 하나). vscode 에 의존하지 않는다 — 화면·테스트가 함께 쓴다.
 *
 *   ---
 *   title: 부서별 사원 월급과 그 부서의 월급 합계
 *   category: 집계·분석
 *   db: oracle                 (비우면 모든 DB)
 *   tags: 분석함수, SUM OVER
 *   privilege: V$SESSION 조회   (필요한 권한, 있으면)
 *   ---
 *   ## 상황 / ## 예제 테이블 / ## 원하는 결과 / ## 쿼리 / ## 풀이 / ## 바꿔 쓸 곳 / ## 연습 실행
 *
 * 쿼리 안의 `${이름:기본값}` 은 바꿀 자리 (같은 이름은 함께 바뀐다). 연습 실행은 SELECT 하나 (예제 데이터를 WITH 로).
 */

export type BookSource = 'builtin' | 'project' | 'user';

export interface BookEntry {
  /** 출처 + 파일 경로 (고유) */
  id: string;
  source: BookSource;
  /** 파일 위치 (열어서 고칠 때) */
  path: string;
  title: string;
  category: string;
  /** 쓸 수 있는 DB (빈 배열이면 모두) */
  db: string[];
  tags: string[];
  privilege?: string;
  situation: string;
  example: string;
  result: string;
  /** 바꿀 자리 표시가 들어 있는 쿼리 */
  query: string;
  explain: string;
  replace: string;
  /** 예제 데이터를 포함한 SELECT (없으면 연습 실행 없음) */
  practice?: string;
}

const SECTIONS: Record<string, keyof BookEntry> = {
  상황: 'situation',
  '예제 테이블': 'example',
  예제: 'example',
  '원하는 결과': 'result',
  결과: 'result',
  쿼리: 'query',
  풀이: 'explain',
  '바꿔 쓸 곳': 'replace',
  '연습 실행': 'practice',
};

/** ```sql … ``` 안의 글 (없으면 섹션 글 그대로) */
function codeOf(text: string): string {
  const m = /```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/.exec(text);
  return (m ? m[1] : text).trim();
}

export function parseEntry(text: string, source: BookSource, path: string): BookEntry | undefined {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const body = fm ? src.slice(fm[0].length) : src;
  const parts: Partial<Record<keyof BookEntry, string>> = {};
  let title = meta.title;
  // ## 제목 으로 나눈다 (# 제목 이 있으면 제목으로)
  const chunks = body.split(/^(?=#{1,2} )/m);
  for (const chunk of chunks) {
    const h = /^(#{1,2}) (.+)\n?/.exec(chunk);
    if (!h) continue;
    const name = h[2].trim();
    const content = chunk.slice(h[0].length).trim();
    if (h[1] === '#') {
      title ??= name;
      continue;
    }
    const key = SECTIONS[name];
    if (key) parts[key] = content;
  }
  if (!title || !parts.query) return undefined;
  const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const practice = parts.practice ? codeOf(parts.practice) : undefined;
  return {
    id: `${source}:${path}`,
    source,
    path,
    title,
    category: meta.category || '기타',
    db: list(meta.db).map((d) => d.toLowerCase()),
    tags: list(meta.tags),
    privilege: meta.privilege || undefined,
    situation: parts.situation ?? '',
    example: parts.example ?? '',
    result: parts.result ?? '',
    query: codeOf(parts.query),
    explain: parts.explain ?? '',
    replace: parts.replace ?? '',
    practice: practice || undefined,
  };
}

/** 이 DB 에서 쓸 수 있는 항목인가 */
export const fitsDb = (e: BookEntry, kind: string) => !e.db.length || e.db.includes(kind);

const PLACEHOLDER = /\$\{([^}:\n]+)(?::([^}\n]*))?\}/g;

/** 바꿀 자리 이름들 (나온 순서, 중복 없이) */
export function placeholders(query: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const m of query.matchAll(PLACEHOLDER)) {
    const name = m[1].trim();
    const have = out.find((x) => x.name === name);
    if (!have) out.push({ name, value: (m[2] ?? '').trim() });
    else if (!have.value && m[2]) have.value = m[2].trim();
  }
  return out;
}

/** 자리 표시를 값으로 채운 글 (복사·바로 넣기용) */
export function fillQuery(query: string, values: Record<string, string> = {}): string {
  const defaults = Object.fromEntries(placeholders(query).map((p) => [p.name, p.value]));
  return query.replace(PLACEHOLDER, (_, n: string) => {
    const name = n.trim();
    return values[name] ?? (defaults[name] || name);
  });
}

/**
 * 편집기 스니펫 틀로: `${이름:값}` → `${번호:값}` (같은 이름은 같은 번호 — 함께 바뀐다).
 * 쿼리 안의 다른 { } (MyBatis #{x} 등) 는 글자 그대로 남게 \ 를 붙인다
 */
export function toSnippet(query: string, values: Record<string, string> = {}): string {
  const ph = placeholders(query);
  const index = new Map(ph.map((p, i) => [p.name, i + 1]));
  const defaults = new Map(ph.map((p) => [p.name, p.value]));
  let out = '';
  let last = 0;
  for (const m of query.matchAll(PLACEHOLDER)) {
    out += query.slice(last, m.index).replace(/[{}]/g, (c) => '\\' + c);
    const name = m[1].trim();
    const value = (values[name] ?? (defaults.get(name) || name)).replace(/[{}]/g, '');
    out += `\${${index.get(name)}:${value}}`;
    last = m.index! + m[0].length;
  }
  return out + query.slice(last).replace(/[{}]/g, (c) => '\\' + c);
}

/** 검색: 낱말마다 제목·분류·태그·상황 중 하나에 들어 있으면 (대소문자·띄어쓰기 무시) */
export function matches(e: BookEntry, query: string): boolean {
  const hay = [e.title, e.category, e.tags.join(' '), e.situation].join(' ').toLowerCase().replace(/\s+/g, '');
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** 새 항목 틀 (사전에 추가할 때) */
export function newEntryText(o: { title: string; category: string; db: string; query: string; situation?: string }): string {
  return [
    '---',
    `title: ${o.title}`,
    `category: ${o.category}`,
    `db: ${o.db}`,
    'tags: ',
    '---',
    '## 상황',
    o.situation?.trim() || '(어떤 데이터에서 무엇을 뽑고 싶은지 — 나중에 읽을 나를 위해)',
    '',
    '## 예제 테이블',
    '| 칸1 | 칸2 |',
    '|---|---|',
    '| 값 | 값 |',
    '',
    '## 원하는 결과',
    '| 칸1 | 칸2 |',
    '|---|---|',
    '| 값 | 값 |',
    '',
    '## 쿼리',
    '```sql',
    o.query.trim().replace(/;\s*$/, ''),
    '```',
    '',
    '## 풀이',
    '- ',
    '',
    '## 바꿔 쓸 곳',
    '- 바꿀 자리는 쿼리에 ${이름:기본값} 으로 쓰면 넣을 때 Tab 으로 옮겨 다니며 바꿀 수 있다',
    '',
  ].join('\n');
}
