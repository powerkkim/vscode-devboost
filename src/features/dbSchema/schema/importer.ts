/**
 * 수집 결과(그리드 복사 텍스트 / CSV / JSON) → 스키마 조각 (vscode 의존 없음).
 * docs/SPEC-db-schema 5장(결과 형식)과 7장(가져올 때 하는 일)을 구현한다.
 *
 * 신경 쓴 것
 *  - 헤더가 있으면 이름으로, 없으면 정해진 순서로 읽는다. 여러 결과를 이어 붙여도 헤더마다 나눠 읽음
 *  - 그리드가 맨 앞에 행 번호 칸을 붙여 복사하는 경우 (REC 위치를 찾아 맞춤)
 *  - 빈 값 표시: (null), [NULL]
 *  - 기본값(LONG)에 줄바꿈이 섞여 행이 쪼개진 경우: 알려진 REC 로 시작하지 않는 줄은 앞 행의 마지막 칸에 이어 붙임
 *  - SUMMARY 의 행 수와 실제 받은 행 수 비교 → 일부만 복사된 경우를 잡는다
 */
import { detectDelimiter, parseDelimited } from './csv';
import {
  CodeInfo, ColumnInfo, ColumnType, ConstraintInfo, ConstraintKind, IndexInfo, SchemaFile, TableInfo,
} from './types';

export const REC_KINDS = ['SUMMARY', 'TABLE', 'COLUMN', 'CONS', 'INDEX', 'DEFAULT', 'CODE'] as const;
export type RecKind = (typeof REC_KINDS)[number];
const REC_SET = new Set<string>(REC_KINDS);

/** 헤더 없이 복사했을 때의 칸 순서 */
const POSITIONAL: Record<string, string[]> = {
  main: [
    'REC', 'TABLE_NAME', 'NAME', 'SEQ', 'COLUMN_NAME', 'KIND', 'DATA_TYPE', 'CHAR_LENGTH', 'CHAR_USED', 'DATA_LENGTH',
    'DATA_PRECISION', 'DATA_SCALE', 'NULLABLE', 'UNIQUENESS', 'DESCEND', 'REF_TABLE', 'REF_COLUMN', 'DELETE_RULE', 'STATUS', 'COMMENTS',
  ],
  DEFAULT: ['REC', 'TABLE_NAME', 'NAME', 'COMMENTS'],
  CODE: ['REC', 'CODE_GROUP', 'GROUP_NAME', 'CODE', 'CODE_NAME', 'SORT_ORDER', 'USE_YN'],
};

/** 기존 정의서 쿼리에서 흔히 쓰는 별칭 → 규격 이름 (REC 가 없는 결과용) */
const ALIASES: Record<string, string> = {
  COLUMN_ID: 'SEQ',
  POSITION: 'SEQ',
  DATA_DEFAULT: 'DEFAULT_VALUE',
  COMMENT: 'COMMENTS',
  TABLE_COMMENTS: 'TABLE_COMMENT',
};

export interface Summary {
  schema?: string;
  database?: string;
  collectedAt?: string;
  prefixes: string[];
  counts: Partial<Record<RecKind, number>>;
}

export interface ImportProblem {
  level: 'error' | 'warn';
  message: string;
}

export interface DefaultValue {
  table: string;
  column: string;
  value: string;
}

export interface ImportPart {
  /** main: 본 쿼리 / defaults: 기본값 쿼리 / codes: 공통코드 / columns: REC 없는 컬럼 명세 / json: 저장 규격 파일 */
  kind: 'main' | 'defaults' | 'codes' | 'columns' | 'json';
  summary?: Summary;
  received: Partial<Record<RecKind, number>>;
  tables: TableInfo[];
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  defaults: DefaultValue[];
  codes: CodeInfo[];
  json?: SchemaFile;
  problems: ImportProblem[];
}

type Rec = Record<string, string>;

const NULLISH = /^\s*(\(null\)|\[null\])\s*$/i;

function clean(v: string | undefined, keepNullWord = false): string {
  if (v === undefined) return '';
  if (NULLISH.test(v)) return '';
  if (!keepNullWord && /^\s*null\s*$/i.test(v)) return '';
  return v;
}

function num(v: string | undefined): number | undefined {
  const s = clean(v).replace(/[,\s]/g, '');
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** 스키마 이름 결정 전에 쓰는 자리표시. 저장할 때 실제 스키마로 바뀐다 */
const OWNER = '';

// ───────────────────────── 타입 정규화 (Oracle → 규격)

export function normalizeOracleType(
  dataType: string,
  charLength?: number,
  charUsed?: string,
  dataLength?: number,
  precision?: number,
  scale?: number
): { type: ColumnType; typeText: string; length?: number } {
  const dt = dataType.trim().toUpperCase();
  if (dt === 'VARCHAR2' || dt === 'CHAR') {
    const n = charLength ?? dataLength;
    return { type: 'string', typeText: n ? `${dt}(${n}${charUsed === 'C' ? ' CHAR' : ''})` : dt, length: n };
  }
  if (dt === 'NVARCHAR2' || dt === 'NCHAR') {
    const n = charLength ?? dataLength;
    return { type: 'string', typeText: n ? `${dt}(${n})` : dt, length: n };
  }
  if (dt === 'NUMBER') {
    if (precision !== undefined) return { type: 'number', typeText: scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})` };
    if (scale === 0) return { type: 'number', typeText: 'INTEGER' };
    return { type: 'number', typeText: 'NUMBER' };
  }
  if (dt === 'FLOAT') return { type: 'number', typeText: precision !== undefined ? `FLOAT(${precision})` : 'FLOAT' };
  if (dt === 'BINARY_FLOAT' || dt === 'BINARY_DOUBLE' || dt === 'INTEGER') return { type: 'number', typeText: dt };
  if (dt === 'DATE') return { type: 'date', typeText: 'DATE' };
  if (dt.startsWith('TIMESTAMP')) return { type: 'timestamp', typeText: dt };
  if (dt === 'CLOB' || dt === 'NCLOB' || dt === 'BLOB' || dt === 'LONG') return { type: 'lob', typeText: dt };
  if (dt === 'RAW') return { type: 'binary', typeText: dataLength ? `RAW(${dataLength})` : 'RAW' };
  if (dt === 'LONG RAW') return { type: 'binary', typeText: dt };
  return { type: 'other', typeText: dt };
}

// ───────────────────────── 읽기

export function parseSummary(comments: string): Summary {
  const s: Summary = { prefixes: [], counts: {} };
  for (const part of comments.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 'schema') s.schema = v || undefined;
    else if (k === 'db') s.database = v || undefined;
    else if (k === 'at') s.collectedAt = v || undefined;
    else if (k === 'prefix') s.prefixes = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
    else if (REC_SET.has(k)) s.counts[k as RecKind] = Number(v) || 0;
  }
  return s;
}

/** 텍스트를 레코드(헤더 이름 → 값) 목록으로 */
function toRecords(text: string, problems: ImportProblem[]): { recs: Rec[]; hasRec: boolean } {
  const delim = detectDelimiter(text);
  const rows = parseDelimited(text, delim);
  const recs: Rec[] = [];
  let header: string[] | null = null;
  let recIdx = -1; // 헤더 기준 REC 칸 위치
  let hasRec = false;
  let warnedNoHeader = false;

  for (const { cells, raw } of rows) {
    const upper = cells.map((c) => c.trim().toUpperCase());
    // REC 값 위치 (행 번호 칸이 붙은 경우 1)
    const at = REC_SET.has(upper[0]) ? 0 : REC_SET.has(upper[1] ?? '') ? 1 : -1;
    // 헤더 줄? REC 는 맨 앞(또는 행 번호 다음)에만 본다: 'REC' 라는 컬럼·코멘트가 있는 데이터 행을 헤더로 오인하지 않게
    const ri = at >= 0 ? -1 : upper[0] === 'REC' ? 0 : upper[1] === 'REC' ? 1 : -1;
    // REC 없는 컬럼 명세(6.6)의 헤더는 첫 줄에만
    const legacyHeader = ri < 0 && at < 0 && !header && recs.length === 0 && upper.includes('TABLE_NAME');
    if (ri >= 0 || legacyHeader) {
      header = upper.map((h) => ALIASES[h] ?? h);
      recIdx = ri;
      if (ri >= 0) hasRec = true;
      continue;
    }

    if (header) {
      if (recIdx >= 0) {
        const recVal = upper[recIdx] ?? '';
        if (!REC_SET.has(recVal)) {
          // 헤더와 칸 위치가 어긋난 행(행 번호 칸 유무 차이)
          if (at >= 0) {
            const shift = at - recIdx;
            recs.push(mapCells(header, shift > 0 ? cells.slice(shift) : [...Array(-shift).fill(''), ...cells]));
            continue;
          }
          appendContinuation(recs, raw);
          continue;
        }
      }
      recs.push(mapCells(header, cells));
      continue;
    }
    // 헤더 없음: REC 값으로 순서 결정
    if (at >= 0) {
      if (!warnedNoHeader) {
        problems.push({ level: 'warn', message: '헤더 없이 복사되어 정해진 칸 순서로 읽었습니다. 다른 쿼리 결과라면 헤더와 함께 복사하세요.' });
        warnedNoHeader = true;
      }
      hasRec = true;
      const rec = upper[at];
      const order = POSITIONAL[rec] ?? POSITIONAL.main;
      recs.push(mapCells(order, cells.slice(at)));
      continue;
    }
    if (recs.length > 0) {
      appendContinuation(recs, raw);
      continue;
    }
    // 첫 줄부터 알 수 없는 형식
    problems.push({ level: 'error', message: '수집 결과 형식이 아닙니다. 헤더(REC, TABLE_NAME …)와 함께 복사했는지 확인하세요.' });
    break;
  }
  return { recs, hasRec };
}

function mapCells(names: string[], cells: string[]): Rec {
  const r: Rec = {};
  names.forEach((n, i) => {
    if (n) r[n] = cells[i] ?? '';
  });
  return r;
}

/** 줄바꿈 때문에 쪼개진 행: 앞 행의 마지막 칸(COMMENTS)에 이어 붙임 */
function appendContinuation(recs: Rec[], raw: string) {
  const prev = recs[recs.length - 1];
  if (!prev) return;
  const key = 'COMMENTS' in prev ? 'COMMENTS' : Object.keys(prev).pop()!;
  prev[key] = `${prev[key] ?? ''}\n${raw}`;
}

export function importText(text: string): ImportPart {
  const part: ImportPart = {
    kind: 'main', received: {}, tables: [], columns: [], constraints: [], indexes: [], defaults: [], codes: [], problems: [],
  };
  const t = text.trim();
  if (t === '') {
    part.problems.push({ level: 'error', message: '클립보드가 비어 있습니다.' });
    return part;
  }
  if (t.startsWith('{')) {
    return importJson(t, part);
  }
  const { recs, hasRec } = toRecords(t, part.problems);
  if (part.problems.some((p) => p.level === 'error')) return part;
  if (recs.length === 0) {
    part.problems.push({ level: 'error', message: '데이터 행이 없습니다 (헤더만 복사되었거나 결과가 비어 있음).' });
    return part;
  }
  if (!hasRec) return importColumnsOnly(recs, part);

  const cons = new Map<string, { info: ConstraintInfo; cols: [number, string, string][] }>();
  const idx = new Map<string, { info: IndexInfo; cols: [number, string, string][] }>();
  for (const r of recs) {
    const rec = clean(r.REC).trim().toUpperCase() as RecKind;
    if (!REC_SET.has(rec)) continue;
    part.received[rec] = (part.received[rec] ?? 0) + 1;
    const table = clean(r.TABLE_NAME).trim();
    const name = clean(r.NAME).trim();
    switch (rec) {
      case 'SUMMARY':
        part.summary = parseSummary(clean(r.COMMENTS));
        break;
      case 'TABLE':
        part.tables.push({
          schema: OWNER, name: table, kind: clean(r.KIND).trim().toUpperCase() === 'VIEW' ? 'view' : 'table',
          comment: clean(r.COMMENTS).trim() || undefined,
        });
        break;
      case 'COLUMN': {
        const dataType = clean(r.DATA_TYPE).trim();
        const precision = num(r.DATA_PRECISION);
        const scale = num(r.DATA_SCALE);
        const t2 = normalizeOracleType(dataType, num(r.CHAR_LENGTH), clean(r.CHAR_USED).trim().toUpperCase(), num(r.DATA_LENGTH), precision, scale);
        part.columns.push({
          schema: OWNER, table, name, position: num(r.SEQ) ?? 0,
          type: t2.type, rawType: dataType.toUpperCase(), typeText: t2.typeText,
          length: t2.length, precision, scale,
          nullable: clean(r.NULLABLE).trim().toUpperCase() !== 'N',
          comment: clean(r.COMMENTS).trim() || undefined,
        });
        break;
      }
      case 'CONS': {
        const kindMap: Record<string, ConstraintKind> = { P: 'primary', U: 'unique', R: 'foreign' };
        const kind = kindMap[clean(r.KIND).trim().toUpperCase()];
        if (!kind) break;
        const key = `${table}|${name}`;
        let c = cons.get(key);
        if (!c) {
          const status = clean(r.STATUS).trim().toUpperCase();
          c = {
            info: {
              schema: OWNER, table, name, kind, columns: [],
              onDelete: kind === 'foreign' ? clean(r.DELETE_RULE).trim().toLowerCase() || undefined : undefined,
              enabled: status ? status === 'ENABLED' : undefined,
            },
            cols: [],
          };
          cons.set(key, c);
        }
        const refTable = clean(r.REF_TABLE).trim();
        if (refTable) c.info.refTable = refTable;
        c.cols.push([num(r.SEQ) ?? c.cols.length + 1, clean(r.COLUMN_NAME).trim(), clean(r.REF_COLUMN).trim()]);
        break;
      }
      case 'INDEX': {
        const key = `${table}|${name}`;
        let x = idx.get(key);
        if (!x) {
          x = {
            info: {
              schema: OWNER, table, name, unique: clean(r.UNIQUENESS).trim().toUpperCase() === 'UNIQUE',
              kind: clean(r.KIND).trim().toLowerCase() || undefined, columns: [],
            },
            cols: [],
          };
          idx.set(key, x);
        }
        x.cols.push([num(r.SEQ) ?? x.cols.length + 1, clean(r.COLUMN_NAME).trim(), clean(r.DESCEND).trim().toUpperCase()]);
        break;
      }
      case 'DEFAULT': {
        // 기본값은 'NULL' 이라는 글자도 의미 있는 값 (DEFAULT NULL)
        const value = clean(r.COMMENTS, true).trim();
        if (table && name && value !== '') part.defaults.push({ table, column: name, value });
        break;
      }
      case 'CODE': {
        const code = clean(r.CODE).trim();
        const group = clean(r.CODE_GROUP).trim();
        if (!group || !code) break;
        const use = clean(r.USE_YN).trim().toUpperCase();
        part.codes.push({
          group, groupName: clean(r.GROUP_NAME).trim() || undefined, code, name: clean(r.CODE_NAME).trim(),
          order: num(r.SORT_ORDER), use: use ? use === 'Y' || use === '1' || use === 'TRUE' : undefined,
        });
        break;
      }
    }
  }
  for (const { info, cols } of cons.values()) {
    cols.sort((a, b) => a[0] - b[0]);
    info.columns = cols.map((c) => c[1]);
    if (info.kind === 'foreign' && cols.some((c) => c[2])) info.refColumns = cols.map((c) => c[2]);
    part.constraints.push(info);
  }
  for (const { info, cols } of idx.values()) {
    cols.sort((a, b) => a[0] - b[0]);
    info.columns = cols.map((c) => ({ name: c[1], desc: c[2] === 'DESC', ...(/^SYS_NC/i.test(c[1]) ? { expr: true } : {}) }));
    part.indexes.push(info);
  }
  part.columns.sort((a, b) => (a.table === b.table ? a.position - b.position : a.table < b.table ? -1 : 1));

  // 종류 판정
  const r = part.received;
  if (r.SUMMARY || r.TABLE || r.COLUMN || r.CONS || r.INDEX) part.kind = 'main';
  else if (r.DEFAULT) part.kind = 'defaults';
  else if (r.CODE) part.kind = 'codes';
  validateCounts(part);
  return part;
}

/** SUMMARY 행 수와 실제 받은 행 수 비교 (기본값은 저장할 때 따로 확인) */
function validateCounts(part: ImportPart) {
  if (part.kind !== 'main') return;
  if (!part.summary) {
    // SUMMARY 가 없으면 접두어·스키마도 모르고 일부 복사도 못 잡는다 → 저장하면 기존 파일 전체를 덮을 수 있어 막는다
    part.problems.push({ level: 'error', message: '첫 행(SUMMARY)이 없습니다. 결과 그리드의 첫 행부터 전체를 헤더와 함께 복사하세요.' });
    return;
  }
  if (!part.received.TABLE && !part.received.COLUMN) {
    part.problems.push({ level: 'error', message: '테이블·컬럼 행이 없습니다. 접두어에 맞는 테이블이 없거나, 헤더만 복사되었습니다.' });
    return;
  }
  const label: Record<string, string> = { TABLE: '테이블', COLUMN: '컬럼', CONS: '제약조건 컬럼', INDEX: '인덱스 컬럼' };
  for (const k of ['TABLE', 'COLUMN', 'CONS', 'INDEX'] as RecKind[]) {
    const expected = part.summary.counts[k];
    const got = part.received[k] ?? 0;
    if (expected !== undefined && expected !== got) {
      part.problems.push({
        level: 'error',
        message: `${label[k]} ${expected}개 중 ${got}개만 받았습니다. 결과 그리드를 끝까지 내리거나 모든 행을 가져온 뒤 다시 복사하세요. (행이 많으면 CSV 로 내보내 [파일에서 가져오기])`,
      });
    }
  }
}

/** REC 없는 결과: 회사에서 쓰던 컬럼 명세 쿼리 (6.6) */
function importColumnsOnly(recs: Rec[], part: ImportPart): ImportPart {
  part.kind = 'columns';
  const tables = new Map<string, TableInfo>();
  const pks = new Map<string, string[]>();
  for (const r of recs) {
    const table = clean(r.TABLE_NAME).trim();
    const name = (clean(r.NAME) || clean(r.COLUMN_NAME)).trim();
    if (!table || !name) continue;
    part.received.COLUMN = (part.received.COLUMN ?? 0) + 1;
    if (!tables.has(table)) {
      tables.set(table, { schema: OWNER, name: table, kind: 'table', comment: clean(r.TABLE_COMMENT).trim() || undefined });
    }
    const dataType = clean(r.DATA_TYPE).trim();
    const precision = num(r.DATA_PRECISION);
    const scale = num(r.DATA_SCALE);
    const t2 = normalizeOracleType(dataType, num(r.CHAR_LENGTH) ?? num(r.DATA_LENGTH), clean(r.CHAR_USED).trim().toUpperCase(), num(r.DATA_LENGTH), precision, scale);
    const def = clean(r.DEFAULT_VALUE, true).trim();
    part.columns.push({
      schema: OWNER, table, name, position: num(r.SEQ) ?? part.columns.filter((c) => c.table === table).length + 1,
      type: t2.type, rawType: dataType.toUpperCase(), typeText: t2.typeText, length: t2.length, precision, scale,
      nullable: clean(r.NULLABLE).trim().toUpperCase() !== 'N',
      default: def || undefined,
      comment: clean(r.COMMENTS).trim() || undefined,
    });
    if (/^(Y|PK|1|TRUE)$/i.test(clean(r.PK).trim())) {
      pks.set(table, [...(pks.get(table) ?? []), name]);
    }
  }
  part.tables = [...tables.values()];
  for (const [table, cols] of pks) {
    part.constraints.push({ schema: OWNER, table, name: `PK_${table}`, kind: 'primary', columns: cols });
  }
  if (part.columns.length === 0) {
    part.problems.push({ level: 'error', message: 'TABLE_NAME 과 컬럼명(NAME 또는 COLUMN_NAME) 칸을 찾지 못했습니다.' });
  } else {
    part.problems.push({ level: 'warn', message: 'REC 칸이 없는 결과라 컬럼 명세로 읽었습니다. 제약조건·인덱스는 없고, 행 수 검증도 하지 않았습니다.' });
  }
  return part;
}

function importJson(text: string, part: ImportPart): ImportPart {
  part.kind = 'json';
  try {
    const j = JSON.parse(text) as SchemaFile;
    if (j.format !== 'devboost-schema' || !j.source?.schema || !Array.isArray(j.tables) || !Array.isArray(j.columns)) {
      part.problems.push({ level: 'error', message: 'devboost-schema 형식의 JSON 이 아닙니다 (format, source.schema, tables, columns 필요).' });
      return part;
    }
    // 빠진 목록은 빈 목록으로 (화면·정의서가 목록이 있다고 보고 읽으므로)
    j.constraints = Array.isArray(j.constraints) ? j.constraints : [];
    j.indexes = Array.isArray(j.indexes) ? j.indexes : [];
    part.json = j;
    part.received = { TABLE: j.tables.length, COLUMN: j.columns.length };
  } catch (e) {
    part.problems.push({ level: 'error', message: `JSON 을 읽을 수 없습니다: ${(e as Error).message}` });
  }
  return part;
}
