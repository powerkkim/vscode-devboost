import { skipQuoted, type DialectRules } from './statements';

/**
 * 문장 안의 테이블 자리 찾기 (vscode·DB 에 의존하지 않는다 — 콘솔 화면과 테스트가 함께 쓴다).
 *  - tableRefs: FROM·JOIN·UPDATE·INTO 뒤의 테이블 이름 자리 (편집기에서 굵게)
 *  - columnSources: 결과 칸마다 어느 테이블에서 왔는지 (결과 표에서 테이블별 색)
 * 틀리게 칠하느니 칠하지 않는다: 확실하지 않으면 undefined
 */

const IDENT = /[A-Za-z_ㄱ-힝][\w$#ㄱ-힝]*/y;
/** 테이블 바로 뒤에 와서 별칭이 될 수 없는 낱말 */
const NOT_ALIAS = new Set(
  'where on join left right inner outer full cross natural group order having union minus intersect except connect start fetch offset limit for using set values into partition sample with when then window qualify lateral returning straight_join pivot unpivot'.split(' ')
);
/** FROM 절이 끝나는 낱말 (괄호 밖) */
const FROM_END = /\b(where|group|order|having|union|minus|intersect|except|connect|start|fetch|offset|limit|for|window|qualify|returning)\b/i;

/** 문자열·주석은 공백으로 (따옴표 이름 "A b"·`a` 는 이름이므로 둔다). 길이는 그대로 */
export function maskSql(sql: string, rules: DialectRules): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const end = skipQuoted(sql, i, rules);
    if (end < 0) {
      out += sql[i++];
      continue;
    }
    const c = sql[i];
    out += c === '"' || c === '`' ? sql.slice(i, end) : sql.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

export interface TableRef {
  /** 이름 (스키마.테이블 그대로, 따옴표 포함) */
  name: string;
  from: number;
  to: number;
  alias?: string;
}

interface Scan {
  pos: number;
}

const skipWs = (t: string, s: Scan) => {
  while (s.pos < t.length && /\s/.test(t[s.pos])) s.pos++;
};

/** 이름 하나 (따옴표 이름 포함) */
function readIdent(t: string, s: Scan): string | undefined {
  const c = t[s.pos];
  if (c === '"' || c === '`') {
    const end = t.indexOf(c, s.pos + 1);
    if (end < 0) return undefined;
    const v = t.slice(s.pos, end + 1);
    s.pos = end + 1;
    return v;
  }
  IDENT.lastIndex = s.pos;
  const m = IDENT.exec(t);
  if (!m) return undefined;
  s.pos += m[0].length;
  return m[0];
}

/** 스키마.테이블(@dblink) */
function readName(t: string, s: Scan): { name: string; from: number; to: number } | undefined {
  const from = s.pos;
  let name = readIdent(t, s);
  if (!name) return undefined;
  while (t[s.pos] === '.' ) {
    const save = s.pos;
    s.pos++;
    const next = readIdent(t, s);
    if (!next) {
      s.pos = save;
      break;
    }
    name += '.' + next;
  }
  if (t[s.pos] === '@') {
    s.pos++;
    readIdent(t, s);
  }
  return { name, from, to: s.pos };
}

/** 괄호 묶음을 건너뛴다 (masked 글이라 따옴표 안의 괄호는 없다) */
function skipParens(t: string, s: Scan) {
  let depth = 0;
  for (; s.pos < t.length; s.pos++) {
    if (t[s.pos] === '(') depth++;
    else if (t[s.pos] === ')' && --depth === 0) {
      s.pos++;
      return;
    }
  }
}

/** [AS] 별칭 */
function readAlias(t: string, s: Scan): string | undefined {
  const save = s.pos;
  skipWs(t, s);
  let word = readIdent(t, s);
  if (word && word.toLowerCase() === 'as') {
    skipWs(t, s);
    word = readIdent(t, s);
  }
  if (word && !NOT_ALIAS.has(word.toLowerCase())) return word;
  s.pos = save;
  return undefined;
}

/** 한 자리(테이블 또는 서브쿼리)를 읽는다. 서브쿼리면 name 없이 별칭만 */
function readSource(t: string, s: Scan): { ref?: TableRef; alias?: string } {
  skipWs(t, s);
  if (t[s.pos] === '(') {
    skipParens(t, s);
    return { alias: readAlias(t, s) };
  }
  const n = readName(t, s);
  // MERGE 의 "UPDATE SET"·"INSERT VALUES" 처럼 이름 자리에 낱말이 오면 테이블이 아니다
  if (!n || NOT_ALIAS.has(n.name.toLowerCase())) return {};
  // 테이블 함수 TABLE(...)·UNNEST(...) 등은 테이블이 아니다
  if (t[s.pos] === '(') {
    skipParens(t, s);
    return { alias: readAlias(t, s) };
  }
  const alias = readAlias(t, s);
  return { ref: { ...n, alias }, alias };
}

/** 문장 안 모든 테이블 이름 자리 (서브쿼리 안도) */
export function tableRefs(sql: string, rules: DialectRules): TableRef[] {
  const t = maskSql(sql, rules);
  const out: TableRef[] = [];
  // 괄호마다 여는 자리: EXTRACT(YEAR FROM d)·TRIM(x FROM y) 의 FROM 은 테이블이 아니다
  const opens: number[] = [];
  const openAt = new Int32Array(t.length).fill(-1);
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') opens.push(i);
    else if (t[i] === ')') opens.pop();
    openAt[i] = opens.length ? opens[opens.length - 1] : -1;
  }
  const re = /\b(from|join|update|into|using)\b/gi;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const kw = m[1].toLowerCase();
    const open = openAt[m.index];
    if (open >= 0 && !/\b(select|update|delete|merge)\b/i.test(topLevel(t.slice(open + 1, m.index)))) continue;
    // USING 은 MERGE INTO … USING 테이블 일 때만 (JOIN … USING (칸) 은 괄호)
    const s: Scan = { pos: m.index + m[0].length };
    const list = kw === 'from';
    for (;;) {
      const src = readSource(t, s);
      if (src.ref) out.push(src.ref);
      if (!list) break;
      skipWs(t, s);
      if (t[s.pos] !== ',') break;
      s.pos++;
    }
  }
  // 서브쿼리 안도 다시 훑으므로 자리 순서로 (같은 자리는 한 번)
  out.sort((a, b) => a.from - b.from);
  return out.filter((r, i) => i === 0 || r.from !== out[i - 1].from);
}

// ───────── 결과 칸 → 테이블 ─────────

/** 괄호 안을 공백으로 (깊이 0 만 남김) */
function topLevel(t: string): string {
  let depth = 0;
  let out = '';
  for (const ch of t) {
    if (ch === '(') depth++;
    out += depth > 0 ? ' ' : ch;
    if (ch === ')' && depth > 0) depth--;
  }
  return out;
}

export interface Source {
  /** 테이블 이름 (서브쿼리면 없음) */
  table?: string;
  alias?: string;
  /** 머리글 풍선 도움말에 보일 이름 */
  label: string;
}

export interface ColumnSources {
  sources: Source[];
  /** 결과 칸마다 sources 의 번호 (모르면 undefined) */
  groups: (number | undefined)[];
}

const bare = (name: string) => name.split('.').pop()!.replace(/^["`]|["`]$/g, '');
const same = (a: string, b: string) => a.replace(/["`]/g, '').toLowerCase() === b.replace(/["`]/g, '').toLowerCase();

/**
 * 결과 칸마다 어느 테이블에서 왔는지. 바깥 SELECT 목록을 칸 순서대로 읽는다.
 * `*`·`별칭.*` 은 그 테이블의 칸 수로 펼친다 (columnsOf). 칸을 모르는 테이블은 need 로 돌려준다 —
 * 받아 온 뒤 다시 부르면 된다. 칸 수가 결과와 맞지 않으면 칠하지 않는다
 */
export function columnSources(
  sql: string,
  resultColumns: string[],
  columnsOf: (table: string) => string[] | undefined,
  rules: DialectRules
): { result?: ColumnSources; need: string[] } {
  const need: string[] = [];
  const masked = maskSql(sql, rules);
  const top = topLevel(masked);
  const sel = /\bselect\b/i.exec(top);
  if (!sel) return { need };
  const fromM = /\bfrom\b/i.exec(top.slice(sel.index));
  if (!fromM) return { need };
  const listStart = sel.index + sel[0].length;
  const fromAt = sel.index + fromM.index;
  const fromEndM = FROM_END.exec(top.slice(fromAt + 4));
  const fromEnd = fromEndM ? fromAt + 4 + fromEndM.index : top.length;

  // FROM 절의 자리들 (JOIN 포함, 순서대로)
  const fromText = masked.slice(0, fromEnd);
  const sources: Source[] = [];
  const s: Scan = { pos: fromAt + 4 };
  const fromTop = topLevel(fromText);
  for (;;) {
    const src = readSource(fromText, s);
    if (!src.ref && !src.alias) return { need };
    sources.push({ table: src.ref?.name, alias: src.alias, label: src.ref ? (src.alias ? `${src.ref.name} (${src.alias})` : src.ref.name) : `(서브쿼리) ${src.alias}` });
    // 다음: 쉼표 또는 …JOIN (ON·USING 조건은 건너뜀)
    const rest = fromTop.slice(s.pos);
    const next = /,|\bjoin\b/i.exec(rest);
    if (!next) break;
    s.pos += next.index + next[0].length;
  }
  if (sources.length < 2) return { need };

  const find = (q: string) => {
    const i = sources.findIndex((x) => x.alias && same(x.alias, q));
    if (i >= 0) return i;
    const j = sources.findIndex((x) => x.table && (same(x.table, q) || same(bare(x.table), bare(q))));
    return j >= 0 ? j : undefined;
  };
  const colsOf = (i: number) => {
    const t = sources[i].table;
    if (!t) return undefined;
    const c = columnsOf(t);
    if (!c && !need.includes(t)) need.push(t);
    return c;
  };

  // SELECT 목록을 괄호 밖 쉼표로 나눈다
  const listTop = top.slice(listStart, fromAt);
  const items: string[] = [];
  let at = 0;
  for (let i = 0; i <= listTop.length; i++) {
    if (i === listTop.length || listTop[i] === ',') {
      items.push(masked.slice(listStart + at, listStart + i).trim());
      at = i + 1;
    }
  }
  // DISTINCT·ALL·TOP 은 칸이 아니다
  if (items.length) items[0] = items[0].replace(/^(distinct|all|unique)\s+/i, '');

  const groups: (number | undefined)[] = [];
  let unknown = false;
  for (const item of items) {
    if (item === '*') {
      for (let i = 0; i < sources.length; i++) {
        const c = colsOf(i);
        if (!c) unknown = true;
        else c.forEach(() => groups.push(i));
      }
      continue;
    }
    const star = /^(.+?)\s*\.\s*\*$/.exec(item);
    if (star) {
      const i = find(star[1]);
      if (i === undefined) return { need };
      const c = colsOf(i);
      if (!c) unknown = true;
      else c.forEach(() => groups.push(i));
      continue;
    }
    // 앞에 붙은 이름(별칭.칸)이 가리키는 테이블이 하나면 그 테이블
    const quals = new Set<number>();
    for (const m of item.matchAll(/((?:"[^"]+"|`[^`]+`|[A-Za-z_ㄱ-힝][\w$#ㄱ-힝]*))\s*\.\s*(?="|`|[A-Za-z_ㄱ-힝])/g)) {
      const i = find(m[1]);
      if (i !== undefined) quals.add(i);
    }
    if (quals.size === 1) groups.push([...quals][0]);
    else if (quals.size > 1) groups.push(undefined);
    else {
      // 별칭 없이 칸 이름만: 그 칸이 있는 테이블이 하나뿐이면
      const col = /^((?:"[^"]+"|`[^`]+`|[A-Za-z_ㄱ-힝][\w$#ㄱ-힝]*))(\s+(as\s+)?\S+)?$/i.exec(item);
      if (!col) {
        groups.push(undefined);
        continue;
      }
      const hits: number[] = [];
      for (let i = 0; i < sources.length; i++) {
        const c = colsOf(i);
        if (c?.some((n) => same(n, col[1]))) hits.push(i);
      }
      groups.push(hits.length === 1 ? hits[0] : undefined);
    }
  }
  if (need.length) return { need };
  if (unknown || groups.length !== resultColumns.length) return { need };
  const used = new Set(groups.filter((g) => g !== undefined));
  if (used.size < 2) return { need };
  return { result: { sources, groups }, need };
}
