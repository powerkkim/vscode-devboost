import { skipQuoted } from './statements';
import type { DbKind } from '../driver/types';
import { rulesOf } from '../driver/dialects';

/**
 * 조회 결과를 INSERT 문으로 바꾼다 ("INSERT문으로 복사"). vscode·oracledb 모듈에 의존하지 않는다.
 */

interface Col {
  name: string;
  /** VARCHAR2, NUMBER, DATE, TIMESTAMP … */
  type: string;
  numeric: boolean;
}

/**
 * 조회 문장에서 테이블 이름을 짐작한다: 첫 FROM 뒤의 이름 (스키마.테이블 포함).
 * 서브쿼리(FROM 뒤가 괄호)면 알 수 없다 → undefined
 */
export function guessTable(sql: string, kind?: DbKind): string | undefined {
  const rules = rulesOf(kind);
  // 문자열·주석을 지운 글에서 찾는다
  let bare = '';
  let i = 0;
  while (i < sql.length) {
    const q = skipQuoted(sql, i, rules);
    // 따옴표 이름("My Table", `t`)은 이름이므로 그대로 둔다
    if (q >= 0 && sql[i] !== '"' && sql[i] !== '`') {
      bare += ' ';
      i = q;
    } else if (q >= 0) {
      bare += sql.slice(i, q);
      i = q;
    } else {
      bare += sql[i++];
    }
  }
  // 첫 FROM 바로 뒤가 이름일 때만 (괄호면 서브쿼리 → 안쪽 FROM 을 테이블로 착각하지 않게)
  const from = /\bfrom\s+/i.exec(bare);
  if (!from) return undefined;
  const m = /^((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$#]*))?)/.exec(bare.slice(from.index + from[0].length));
  return m ? m[1].replace(/\s*\.\s*/, '.') : undefined; // 점 둘레의 공백만 정리 (따옴표 이름 안의 공백은 그대로)
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * 칸 값 하나 → SQL 글자. 화면에 보이는 값(글자)과 칸 타입으로 정한다.
 * Oracle 은 날짜 글자를 바로 넣으면 NLS 설정에 따라 실패하므로 TO_DATE/TO_TIMESTAMP 로 감싼다.
 * PostgreSQL·MySQL 은 'YYYY-MM-DD HH:MI:SS' 글자를 날짜 칸에 그대로 넣을 수 있다
 */
export function sqlLiteral(value: string | null, col: Col, kind: DbKind = 'oracle'): string {
  if (value === null) return 'NULL';
  const type = col.type.toUpperCase();
  if (col.numeric && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return value;
  // MySQL 이진 칸은 화면에 0xCAFE 로 보인다 → 그대로 쓰면 이진 값
  if (kind === 'mysql' && /BLOB|BINARY/.test(type) && /^0x[0-9A-Fa-f]*$/.test(value)) return value === '0x' ? "''" : value;
  if (kind === 'mysql') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`; // 백슬래시가 탈출 문자
  if (kind !== 'oracle') return quote(value);
  if (type === 'DATE') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `TO_DATE(${quote(value)}, 'YYYY-MM-DD')` : `TO_DATE(${quote(value.slice(0, 19))}, 'YYYY-MM-DD HH24:MI:SS')`;
  }
  if (type.startsWith('TIMESTAMP')) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `TO_TIMESTAMP(${quote(value)}, 'YYYY-MM-DD')`;
    return /\.\d+$/.test(value) ? `TO_TIMESTAMP(${quote(value)}, 'YYYY-MM-DD HH24:MI:SS.FF')` : `TO_TIMESTAMP(${quote(value)}, 'YYYY-MM-DD HH24:MI:SS')`;
  }
  return quote(value);
}

/**
 * 칸 이름: 그 DB 가 따옴표 없이 같은 칸으로 읽는 이름이면 그대로, 아니면 감싼다.
 * Oracle 은 대문자, PostgreSQL 은 소문자가 기본. MySQL 은 대소문자를 가리지 않고 백틱으로 감싼다
 */
function ident(name: string, kind: DbKind): string {
  if (kind === 'mysql') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`';
  const plain = kind === 'postgres' ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Z_][A-Z0-9_$#]*$/;
  return plain.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** 행마다 INSERT 문 하나 (세미콜론으로 끝남) */
export function toInsertSql(table: string, columns: Col[], rows: (string | null)[][], kind: DbKind = 'oracle'): string {
  const cols = columns.map((c) => ident(c.name, kind)).join(', ');
  return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => sqlLiteral(v, columns[i], kind)).join(', ')});`).join('\n');
}
