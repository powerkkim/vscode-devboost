import type { Relation } from '../driver/types';

/**
 * 트리에서 고른 테이블들로 쿼리를 만든다 (vscode·드라이버 모듈에 의존하지 않아 단독 테스트 가능).
 *
 * JOIN 조건을 찾는 순서:
 *  1) 참조 제약(FK) — 가장 확실하다
 *  2) 기본 키 칸 이름: 한 테이블의 기본 키 칸이 다른 테이블에 같은 이름으로 모두 있으면 그것으로 잇는다 (FK 를 만들지 않는 DB가 많다).
 *     짐작한 것이므로 줄 끝에 표시한다
 *  3) 못 찾으면 CROSS JOIN 으로 두고 표시한다 (사용자가 조건을 채운다)
 */

export interface JoinTable {
  /** 테이블 이름 (DB에 저장된 그대로) */
  name: string;
  /** 쿼리에 쓸 이름: 다른 스키마면 OWNER.NAME */
  qualified: string;
  /** 칸 이름 (정의 순서) */
  columns: string[];
  /** 기본 키 칸 (없으면 []) */
  primaryKey: string[];
}

export interface JoinResult {
  sql: string;
  /** 칸 이름으로 짐작해서 이은 테이블 */
  guessed: string[];
  /** 잇는 조건을 찾지 못한 테이블 */
  unresolved: string[];
}

/** 흔한 테이블 이름 앞머리 (별칭을 만들 때 뺀다) */
const PREFIX = /^(?:TBL?|TB|T)_/i;

/** 별칭: 앞머리를 빼고 낱말의 첫 글자들 (TB_PART_MASTER → PM). 겹치면 숫자를 붙인다 */
export function aliasFor(name: string, used: Set<string>): string {
  const words = name.replace(PREFIX, '').split(/[_$#]+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? name).slice(0, 1);
  base = base.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'T';
  if (/^\d/.test(base)) base = 'T' + base;
  let alias = base;
  for (let n = 2; used.has(alias); n++) alias = `${base}${n}`;
  used.add(alias);
  return alias;
}

const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
const hasAll = (cols: string[], want: string[]) => want.length > 0 && want.every((w) => cols.some((c) => same(c, w)));

interface Link {
  /** 새로 붙일 테이블 칸 = 이미 놓인 테이블 칸 */
  pairs: { mine: string; theirs: string }[];
  /** 이미 놓인 쪽 */
  other: JoinTable;
  guessed: boolean;
}

/** 이미 놓인 테이블 중 t 와 이을 수 있는 것 */
function findLink(t: JoinTable, placed: JoinTable[], relations: Relation[]): Link | undefined {
  for (const p of placed) {
    for (const r of relations) {
      if (same(r.fromTable, t.name) && same(r.toTable, p.name)) {
        return { other: p, guessed: false, pairs: r.fromColumns.map((c, i) => ({ mine: c, theirs: r.toColumns[i] })) };
      }
      if (same(r.fromTable, p.name) && same(r.toTable, t.name)) {
        return { other: p, guessed: false, pairs: r.toColumns.map((c, i) => ({ mine: c, theirs: r.fromColumns[i] })) };
      }
    }
  }
  for (const p of placed) {
    if (hasAll(t.columns, p.primaryKey)) return { other: p, guessed: true, pairs: p.primaryKey.map((c) => ({ mine: c, theirs: c })) };
    if (hasAll(p.columns, t.primaryKey)) return { other: p, guessed: true, pairs: t.primaryKey.map((c) => ({ mine: c, theirs: c })) };
  }
  return undefined;
}

/** 고른 순서를 지키되, 이을 수 있는 테이블부터 붙인다 */
export function buildJoin(tables: JoinTable[], relations: Relation[]): JoinResult {
  if (!tables.length) return { sql: '', guessed: [], unresolved: [] };
  const used = new Set<string>();
  const alias = new Map<JoinTable, string>(tables.map((t) => [t, aliasFor(t.name, used)]));
  const placed = [tables[0]];
  const rest = tables.slice(1);
  // 줄마다 SQL 과 덧붙일 설명 (끝의 ; 는 설명 앞에 와야 한다 — 주석 안에 들어가면 문장이 끝나지 않는다)
  const lines: { sql: string; note?: string }[] = [
    { sql: `SELECT ${tables.map((t) => `${alias.get(t)}.*`).join(', ')}` },
    { sql: `  FROM ${tables[0].qualified} ${alias.get(tables[0])}` },
  ];
  const guessed: string[] = [];
  const unresolved: string[] = [];
  while (rest.length) {
    let i = rest.findIndex((t) => findLink(t, placed, relations));
    if (i < 0) i = 0;
    const t = rest.splice(i, 1)[0];
    const link = findLink(t, placed, relations);
    const a = alias.get(t)!;
    if (!link) {
      unresolved.push(t.name);
      lines.push({ sql: `  CROSS JOIN ${t.qualified} ${a}`, note: '잇는 칸을 찾지 못했습니다' });
    } else {
      const b = alias.get(link.other)!;
      const on = link.pairs.map((p) => `${a}.${p.mine} = ${b}.${p.theirs}`).join(' AND ');
      if (link.guessed) guessed.push(t.name);
      lines.push({ sql: `  JOIN ${t.qualified} ${a} ON ${on}`, note: link.guessed ? '기본 키 칸 이름으로 짐작' : undefined });
    }
    placed.push(t);
  }
  const last = lines.length - 1;
  const sql = lines.map((l, i) => `${l.sql}${i === last ? ';' : ''}${l.note ? ` -- ${l.note}` : ''}`).join('\n');
  return { sql, guessed, unresolved };
}

/** 테이블 하나의 SELECT: 칸을 다 적는다 (칸을 모르면 *) */
export function buildSelect(t: JoinTable): string {
  if (!t.columns.length) return `SELECT *\n  FROM ${t.qualified};`;
  return `SELECT ${t.columns.join(', ')}\n  FROM ${t.qualified};`;
}

export function buildCount(t: JoinTable): string {
  return `SELECT COUNT(*) FROM ${t.qualified};`;
}
