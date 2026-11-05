/**
 * SQL 글을 문장으로 나누고 종류를 가린다 (vscode·oracledb 모듈에 의존하지 않아 단독 테스트 가능).
 *
 * 나누는 규칙 (SQL Developer·DataGrip 과 같은 관례):
 *  - 보통 문장은 `;` 또는 `/` 만 있는 줄에서 끝난다. 문자열·따옴표 이름·주석(한 줄 주석, 블록 주석) 안의 `;` 는 세지 않는다
 *  - PL/SQL 블록(BEGIN·DECLARE·CREATE PROCEDURE 등)은 안에 `;` 가 많으므로, `/` 만 있는 줄에서 끝난다 (없으면 글 끝까지)
 *  - DB 에 보낼 때: 보통 문장은 끝의 `;` 를 떼고, PL/SQL 블록은 `;` 를 그대로 둔다 (오라클이 그렇게 받는다)
 */

export interface Statement {
  /** DB 에 보낼 글 */
  sql: string;
  /** 원문에서 이 문장이 시작하는 자리 (앞의 공백·주석 뒤) */
  start: number;
  /** 원문에서 이 문장이 끝나는 자리 (끝의 `;` 나 `/` 줄 포함, 그 다음 글자) */
  end: number;
}

export type StatementKind = 'query' | 'dml' | 'ddl' | 'plsql' | 'tx' | 'other';

export interface StatementInfo {
  kind: StatementKind;
  /** 첫 낱말 (대문자): SELECT, UPDATE … */
  verb: string;
  /** UPDATE·DELETE 인데 WHERE 가 없다 (테이블 전체가 바뀐다) */
  noWhere: boolean;
  /** SELECT … FOR UPDATE (행을 잠근다) */
  forUpdate: boolean;
}

const BLOCK_START = /^(?:declare|begin)\b|^create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:procedure|function|package|trigger|type|library)\b/i;

/**
 * pos 에서 시작하는 "문장이 아닌 것"(공백·주석)을 건너뛴 자리.
 * 주석이 끝나지 않았으면 글 끝
 */
function skipBlank(text: string, pos: number): number {
  for (;;) {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (text.startsWith('--', pos)) {
      const nl = text.indexOf('\n', pos);
      pos = nl < 0 ? text.length : nl + 1;
    } else if (text.startsWith('/*', pos)) {
      const close = text.indexOf('*/', pos + 2);
      pos = close < 0 ? text.length : close + 2;
    } else {
      return pos;
    }
  }
}

/** pos 가 문자열·따옴표 이름·주석의 시작이면 그 끝 다음 자리, 아니면 -1 */
export function skipQuoted(text: string, pos: number): number {
  const c = text[pos];
  if (c === "'" || c === '"') {
    for (let i = pos + 1; i < text.length; i++) {
      if (text[i] !== c) continue;
      if (c === "'" && text[i + 1] === "'") i++; // '' 는 따옴표 한 글자
      else return i + 1;
    }
    return text.length;
  }
  // q'[ … ]' — 여는 글자에 맞는 닫는 글자 + ' 에서 끝난다
  if ((c === 'q' || c === 'Q') && text[pos + 1] === "'" && pos + 2 < text.length && !/[\w$#]/.test(text[pos - 1] ?? ' ')) {
    const open = text[pos + 2];
    const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] ?? open;
    const end = text.indexOf(close + "'", pos + 3);
    return end < 0 ? text.length : end + 2;
  }
  if (text.startsWith('--', pos)) {
    const nl = text.indexOf('\n', pos);
    return nl < 0 ? text.length : nl;
  }
  if (text.startsWith('/*', pos)) {
    const close = text.indexOf('*/', pos + 2);
    return close < 0 ? text.length : close + 2;
  }
  return -1;
}

/** `/` 만 있는 줄이면 그 줄 끝(줄바꿈 다음) 자리, 아니면 -1. pos 는 줄의 첫 글자 */
function slashLineEnd(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos);
  const end = nl < 0 ? text.length : nl;
  return text.slice(pos, end).trim() === '/' ? (nl < 0 ? text.length : nl + 1) : -1;
}

export function splitStatements(text: string): Statement[] {
  const out: Statement[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = skipBlank(text, pos);
    if (start >= text.length) break;
    // 문장 사이에 남은 `/` 줄이나 `;` 는 건너뛴다
    if (text[start] === ';') {
      pos = start + 1;
      continue;
    }
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (text[start] === '/' && text.slice(lineStart, start).trim() === '') {
      const afterSlash = slashLineEnd(text, lineStart);
      if (afterSlash >= 0) {
        pos = afterSlash;
        continue;
      }
    }

    const block = BLOCK_START.test(text.slice(start, start + 80));
    let i = start;
    let end = text.length; // 끝 표시(;, /) 다음 자리
    let bodyEnd = text.length; // 보낼 글의 끝
    while (i < text.length) {
      const q = skipQuoted(text, i);
      if (q >= 0) {
        i = q;
        continue;
      }
      if (block) {
        // 줄 맨 앞의 `/` 한 글자만 있는 줄에서 끝
        if (text[i] === '\n') {
          const after = slashLineEnd(text, i + 1);
          if (after >= 0) {
            bodyEnd = i;
            end = after;
            break;
          }
        }
      } else if (text[i] === ';') {
        bodyEnd = i;
        end = i + 1;
        break;
      } else if (text[i] === '\n') {
        // SQL*Plus 식으로 `;` 없이 `/` 줄로 끝낸 문장
        const after = slashLineEnd(text, i + 1);
        if (after >= 0) {
          bodyEnd = i;
          end = after;
          break;
        }
      }
      i++;
    }
    const sql = text.slice(start, bodyEnd).trim();
    if (sql) out.push({ sql, start, end });
    pos = end;
  }
  return out;
}

/**
 * 커서가 있는 문장. 문장 사이(공백·빈 줄)에 있으면: 같은 줄에서 끝난 앞 문장, 아니면 다음 문장, 그것도 없으면 마지막 문장.
 * 문장이 하나도 없으면 undefined
 */
export function statementAt(text: string, offset: number): Statement | undefined {
  const list = splitStatements(text);
  if (!list.length) return undefined;
  const inside = list.find((s) => offset >= s.start && offset <= s.end);
  if (inside) return inside;
  const before = [...list].reverse().find((s) => s.end <= offset);
  if (before && !text.slice(before.end, offset).includes('\n')) return before;
  return list.find((s) => s.start >= offset) ?? before ?? list[0];
}

/** 문자열·주석을 빼고 낱말만 남긴 글 (종류 판정용, 소문자) */
function bare(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const q = skipQuoted(sql, i);
    if (q >= 0) {
      out += ' ';
      i = q;
    } else {
      out += sql[i++];
    }
  }
  return out.toLowerCase();
}

const QUERY = new Set(['select', 'with']);
const DML = new Set(['insert', 'update', 'delete', 'merge']);
const TX = new Set(['commit', 'rollback', 'savepoint']);
const DDL = new Set(['create', 'alter', 'drop', 'truncate', 'rename', 'grant', 'revoke', 'comment', 'purge', 'flashback', 'analyze', 'audit', 'noaudit']);

export function classify(sql: string): StatementInfo {
  const text = bare(sql).trim();
  const verb = /^[a-z]+/.exec(text)?.[0] ?? '';
  const info: StatementInfo = { kind: 'other', verb: verb.toUpperCase(), noWhere: false, forUpdate: false };
  if (BLOCK_START.test(text) || verb === 'call') {
    info.kind = 'plsql';
  } else if (QUERY.has(verb)) {
    // WITH … 로 시작해도 본문이 INSERT·UPDATE·DELETE·MERGE 일 수는 없다(오라클). 괄호로 시작한 SELECT 는 아래 other 로 가지 않게 따로 본다
    info.kind = 'query';
    info.forUpdate = /\bfor\s+update\b/.test(text);
  } else if (DML.has(verb)) {
    info.kind = 'dml';
    info.noWhere = (verb === 'update' || verb === 'delete') && !/\bwhere\b/.test(text);
  } else if (TX.has(verb)) {
    info.kind = 'tx';
  } else if (DDL.has(verb)) {
    info.kind = 'ddl';
  } else if (/^\(+\s*(select|with)\b/.test(text)) {
    info.kind = 'query';
    info.verb = 'SELECT';
    info.forUpdate = /\bfor\s+update\b/.test(text);
  }
  return info;
}

/** 데이터나 구조를 바꾸는 문장인가 (읽기 전용 연결에서 막을 것) */
export function changesData(info: StatementInfo): boolean {
  return info.kind !== 'query' || info.forUpdate;
}
