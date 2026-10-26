/**
 * 수집 결과(그리드 복사 텍스트 / CSV / JSON) → 스키마 조각 (vscode 의존 없음).
 * docs/SPEC-db-schema-v8 5장(결과 형식)과 7장(가져올 때 하는 일)을 구현한다.
 *
 * 받는 것
 *  - DevBoost 수집 쿼리 결과: 컬럼마다 한 행 + PK·UK·FK·인덱스를 묶은 칸 + META(행 수 검증) + DATA_DEFAULT(맨 끝)
 *  - 회사·인터넷에서 쓰는 컬럼 명세 쿼리 결과: 헤더 이름(영문·한글 별칭)으로 읽음 (META 가 없으면 행 수 검증은 생략)
 *  - 공통코드 결과 (CODE_GROUP, CODE, CODE_NAME …)
 *  - 저장 규격 JSON
 * 신경 쓴 것
 *  - 헤더가 없으면 META 칸 위치로 순서를 맞춰 읽음, 그리드가 맨 앞에 행 번호 칸을 붙여 복사한 경우
 *  - 빈 값 표시 (null), [NULL]
 *  - 기본값(LONG)에 줄바꿈이 섞여 행이 쪼개진 경우: 칸 수가 모자란 줄은 앞 행의 기본값에 이어 붙임
 */
import { detectDelimiter, parseDelimited } from './csv';
import {
  CodeInfo, ColumnInfo, ColumnType, ConstraintInfo, IndexInfo, SchemaFile, TableInfo,
} from './types';

/** DevBoost 수집 쿼리의 칸 순서 (헤더 없이 복사했을 때) */
export const COLLECT_COLUMNS = [
  'TABLE_NAME', 'TABLE_TYPE', 'TABLE_COMMENT', 'COLUMN_ID', 'COLUMN_NAME', 'COLUMN_COMMENT', 'DATA_TYPE', 'CHAR_LENGTH', 'CHAR_USED',
  'DATA_LENGTH', 'DATA_PRECISION', 'DATA_SCALE', 'NULLABLE', 'PK_POS', 'PK_NAME', 'UKS', 'FKS', 'IDXS', 'META', 'DATA_DEFAULT',
];
const META_AT = COLLECT_COLUMNS.indexOf('META');

/**
 * 헤더 이름 → 규격 이름. 다른 정의서 쿼리에서 흔히 쓰는 영문·한글 별칭
 * (공백·밑줄을 뺀 대문자로 비교: '테이블 설명' = '테이블설명', 'Column_Name' = 'COLUMNNAME')
 */
const ALIAS_LIST: [string, string[]][] = [
  ['TABLE_NAME', ['TABLE_NAME', '테이블명', '테이블', '테이블ID', '테이블영문명']],
  ['TABLE_TYPE', ['TABLE_TYPE', '객체유형']],
  ['TABLE_COMMENT', ['TABLE_COMMENT', 'TABLE_COMMENTS', 'TAB_CMT', '테이블설명', '테이블한글명', '테이블코멘트', '테이블주석']],
  ['COLUMN_ID', ['COLUMN_ID', 'SEQ', 'POSITION', '컬럼순서', '순서', '순번', '컬럼순번']],
  ['COLUMN_NAME', ['COLUMN_NAME', '컬럼명', '컬럼', '컬럼ID', '컬럼영문명', '칼럼명']],
  ['COLUMN_COMMENT', ['COLUMN_COMMENT', 'COLUMN_COMMENTS', 'COL_CMT', 'COMMENTS', 'COMMENT', '컬럼설명', '컬럼한글명', '컬럼코멘트', '컬럼주석', '칼럼설명', '설명']],
  ['DATA_TYPE', ['DATA_TYPE', '데이터유형', '데이터타입', '타입', '자료형']],
  ['CHAR_LENGTH', ['CHAR_LENGTH']],
  ['CHAR_USED', ['CHAR_USED']],
  ['DATA_LENGTH', ['DATA_LENGTH']],
  ['LENGTH_TEXT', ['LENGTH', '길이', '데이터길이', '자릿수']],
  ['DATA_PRECISION', ['DATA_PRECISION', 'PRECISION']],
  ['DATA_SCALE', ['DATA_SCALE', 'SCALE']],
  ['NULLABLE', ['NULLABLE', 'NULL여부', 'NULL', '널여부']],
  ['PK_POS', ['PK_POS', 'PK', 'PK여부']],
  ['PK_NAME', ['PK_NAME']],
  ['UKS', ['UKS', 'UK']],
  ['FKS', ['FKS', 'FK']],
  ['IDXS', ['IDXS', 'INDEXES', '인덱스']],
  ['META', ['META']],
  ['DATA_DEFAULT', ['DATA_DEFAULT', 'DEFAULT', '기본값', '디폴트', '초기값']],
  ['CODE_GROUP', ['CODE_GROUP', 'GROUP_CD', '코드그룹']],
  ['GROUP_NAME', ['GROUP_NAME', 'GROUP_NM', '코드그룹명']],
  ['CODE', ['CODE', '코드']],
  ['CODE_NAME', ['CODE_NAME', 'CODE_NM', '코드명']],
  ['SORT_ORDER', ['SORT_ORDER', '정렬순서']],
  ['USE_YN', ['USE_YN', '사용여부']],
];
const keyOf = (h: string) => h.trim().toUpperCase().replace(/[\s_]+/g, '');
const ALIASES = new Map<string, string>();
for (const [name, list] of ALIAS_LIST) for (const a of list) if (!ALIASES.has(keyOf(a))) ALIASES.set(keyOf(a), name);

export interface Summary {
  schema?: string;
  database?: string;
  collectedAt?: string;
  prefixes: string[];
  /** 전체 행 수 (= 컬럼 수) */
  rows?: number;
}

export interface ImportProblem {
  level: 'error' | 'warn';
  message: string;
}

export interface ImportPart {
  /** collect: DevBoost 수집 쿼리 / columns: META 없는 컬럼 명세 / codes: 공통코드 / json: 저장 규격 파일 */
  kind: 'collect' | 'columns' | 'codes' | 'json';
  summary?: Summary;
  /** 받은 데이터 행 수 */
  rows: number;
  tables: TableInfo[];
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
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

/** 스키마 이름은 저장할 때 정해진다 */
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
  if (dt === 'VARCHAR2' || dt === 'CHAR' || dt === 'VARCHAR') {
    const n = charLength || dataLength;
    return { type: 'string', typeText: n ? `${dt}(${n}${charUsed === 'C' ? ' CHAR' : ''})` : dt, length: n };
  }
  if (dt === 'NVARCHAR2' || dt === 'NCHAR') {
    const n = charLength || dataLength;
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

export function parseMeta(meta: string): Summary {
  const s: Summary = { prefixes: [] };
  for (const part of meta.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 'schema') s.schema = v || undefined;
    else if (k === 'db') s.database = v || undefined;
    else if (k === 'at') s.collectedAt = v || undefined;
    else if (k === 'prefix') s.prefixes = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
    else if (k === 'rows') s.rows = Number(v) || 0;
  }
  return s;
}

const isMeta = (v: string | undefined) => /^\s*schema=/.test(v ?? '');

/** 텍스트를 레코드(규격 이름 → 값) 목록으로 */
function toRecords(text: string, problems: ImportProblem[]): Rec[] {
  const delim = detectDelimiter(text);
  const rows = parseDelimited(text, delim);
  const recs: Rec[] = [];
  let names: string[] | null = null;
  /** 이 칸 수보다 적은 줄은 앞 행 기본값의 이어지는 줄 */
  let minCells = 0;
  let warnedNoHeader = false;

  for (const { cells, raw } of rows) {
    const mapped = cells.map((c) => ALIASES.get(keyOf(c)) ?? '');
    const known = mapped.filter(Boolean);
    // 헤더 줄: 알려진 이름이 3개 이상이고 테이블명·컬럼명(또는 코드)이 있음. 데이터 행에 이름 같은 값이 섞여도 오인하지 않게
    const isHeader =
      known.length >= 3 &&
      ((known.includes('TABLE_NAME') && known.includes('COLUMN_NAME')) || (known.includes('CODE_GROUP') && known.includes('CODE'))) &&
      !cells.some(isMeta);
    if (isHeader) {
      names = mapped;
      const metaIdx = mapped.indexOf('META');
      const defIdx = mapped.indexOf('DATA_DEFAULT');
      // 기본값이 맨 끝 칸이면 그 앞 칸까지는 있어야 한 행 (모자라면 기본값의 이어지는 줄)
      minCells = defIdx >= 0 && defIdx === mapped.length - 1 ? Math.max(metaIdx + 1, defIdx) : 2;
      continue;
    }
    const metaAt = cells.findIndex(isMeta);
    if (!names) {
      // 헤더 없이 복사: META 칸 위치로 순서 맞추기 (행 번호 칸이 붙었으면 한 칸 밀림)
      if (metaAt === META_AT || metaAt === META_AT + 1) {
        if (!warnedNoHeader) {
          problems.push({ level: 'warn', message: '헤더 없이 복사되어 정해진 칸 순서로 읽었습니다.' });
          warnedNoHeader = true;
        }
        const off = metaAt - META_AT;
        recs.push(mapCells(COLLECT_COLUMNS, cells.slice(off)));
        minCells = META_AT + off + 1;
        continue;
      }
      if (recs.length > 0 && cells.length < minCells) {
        appendDefault(recs, raw);
        continue;
      }
      problems.push({ level: 'error', message: '헤더를 찾지 못했습니다. 결과 그리드를 헤더(TABLE_NAME, COLUMN_NAME …)와 함께 복사하세요.' });
      return recs;
    }
    if (cells.length < minCells && recs.length > 0) {
      appendDefault(recs, raw);
      continue;
    }
    // 헤더와 칸 위치가 한 칸 어긋난 행 (행 번호 칸이 헤더나 데이터 한쪽에만 붙은 경우)
    const headerMeta = names.indexOf('META');
    if (headerMeta >= 0 && metaAt >= 0 && metaAt !== headerMeta) {
      const shift = metaAt - headerMeta;
      recs.push(mapCells(names, shift > 0 ? cells.slice(shift) : [...Array(-shift).fill(''), ...cells]));
      continue;
    }
    recs.push(mapCells(names, cells));
  }
  return recs;
}

function mapCells(names: string[], cells: string[]): Rec {
  const r: Rec = {};
  names.forEach((n, i) => {
    if (n && !(n in r)) r[n] = cells[i] ?? '';
  });
  return r;
}

/** 기본값에 줄바꿈이 섞여 쪼개진 줄: 앞 행의 기본값에 이어 붙임 */
function appendDefault(recs: Rec[], raw: string) {
  const prev = recs[recs.length - 1];
  if (!prev) return;
  prev.DATA_DEFAULT = `${prev.DATA_DEFAULT ?? ''}\n${raw}`;
}

function emptyPart(kind: ImportPart['kind']): ImportPart {
  return { kind, rows: 0, tables: [], columns: [], constraints: [], indexes: [], codes: [], problems: [] };
}

export function importText(text: string): ImportPart {
  const t = text.trim();
  if (t === '') {
    const p = emptyPart('collect');
    p.problems.push({ level: 'error', message: '클립보드가 비어 있습니다.' });
    return p;
  }
  if (t.startsWith('{')) return importJson(t);
  const probs: ImportProblem[] = [];
  const recs = toRecords(t, probs);
  if (probs.some((p) => p.level === 'error')) {
    const p = emptyPart('collect');
    p.problems = probs;
    return p;
  }
  if (recs.length === 0) {
    const p = emptyPart('collect');
    p.problems.push({ level: 'error', message: '데이터 행이 없습니다 (헤더만 복사되었거나 결과가 비어 있음).' });
    return p;
  }
  const p = 'CODE' in recs[0] && 'CODE_GROUP' in recs[0] && !('COLUMN_NAME' in recs[0]) ? importCodes(recs) : importColumns(recs);
  p.problems.unshift(...probs);
  return p;
}

// ───────────────────────── 컬럼 행 → 테이블·컬럼·제약·인덱스

const UK_RE = /^(.+?)\((\d+)\)$/;
const FK_RE = /^(.+?)\((\d+)\)=(.+?)\.([^.\s]+)(?: (.+))?$/;
const IX_RE = /^(.+?)\((\d+)( DESC)?( U)?\)$/;
const splitList = (v: string) => clean(v).split(/,\s+/).map((x) => x.trim()).filter(Boolean);

function importColumns(recs: Rec[]): ImportPart {
  const hasMeta = recs.some((r) => isMeta(r.META));
  const part = emptyPart(hasMeta ? 'collect' : 'columns');
  const tables = new Map<string, TableInfo>();
  const pks = new Map<string, { name: string; cols: [number, string][] }>();
  const uks = new Map<string, ConstraintInfo & { pos: [number, string][] }>();
  const fks = new Map<string, ConstraintInfo & { pos: [number, string, string][] }>();
  const idx = new Map<string, IndexInfo & { pos: [number, string, boolean][] }>();
  const perTable = new Map<string, number>();

  for (const r of recs) {
    const table = clean(r.TABLE_NAME).trim();
    const name = clean(r.COLUMN_NAME).trim();
    if (!table || !name) continue;
    part.rows++;
    if (!part.summary && isMeta(r.META)) part.summary = parseMeta(clean(r.META));
    if (!tables.has(table)) {
      const kind = clean(r.TABLE_TYPE).trim();
      tables.set(table, {
        schema: OWNER, name: table, kind: /VIEW|뷰/i.test(kind) ? 'view' : 'table',
        comment: clean(r.TABLE_COMMENT).trim() || undefined,
      });
    }
    const dataType = clean(r.DATA_TYPE).trim();
    let precision = num(r.DATA_PRECISION);
    let scale = num(r.DATA_SCALE);
    let charLength = num(r.CHAR_LENGTH);
    const dataLength = num(r.DATA_LENGTH);
    // 다른 정의서 쿼리의 '데이터길이' 칸: 숫자는 '10,2' / 문자는 '100'
    const lenText = clean(r.LENGTH_TEXT).trim();
    if (lenText && precision === undefined && charLength === undefined && dataLength === undefined) {
      const m = /^(\d+)\s*(?:,\s*(\d+))?$/.exec(lenText);
      if (m) {
        if (/NUMBER|FLOAT/i.test(dataType)) {
          precision = Number(m[1]);
          scale = m[2] !== undefined ? Number(m[2]) : 0;
        } else {
          charLength = Number(m[1]);
        }
      }
    }
    const t2 = normalizeOracleType(dataType, charLength, clean(r.CHAR_USED).trim().toUpperCase(), dataLength, precision, scale);
    const pos = num(r.COLUMN_ID) ?? (perTable.get(table) ?? 0) + 1;
    perTable.set(table, pos);
    const def = clean(r.DATA_DEFAULT, true).trim();
    const nullable = clean(r.NULLABLE).trim().toUpperCase();
    part.columns.push({
      schema: OWNER, table, name, position: pos,
      type: t2.type, rawType: dataType.toUpperCase(), typeText: t2.typeText,
      length: t2.length, precision, scale,
      nullable: !(nullable === 'N' || nullable === 'NOT NULL' || nullable === 'NO'),
      default: def || undefined,
      comment: clean(r.COLUMN_COMMENT).trim() || undefined,
    });

    // PK: 순서 숫자 (DevBoost) 또는 'PK1', 'Y' (다른 쿼리)
    const pkRaw = clean(r.PK_POS).trim();
    if (pkRaw) {
      const n = /(\d+)/.exec(pkRaw);
      if (n || /^(Y|PK|YES|TRUE)$/i.test(pkRaw)) {
        const pk = pks.get(table) ?? { name: clean(r.PK_NAME).trim() || `PK_${table}`, cols: [] };
        pk.cols.push([n ? Number(n[1]) : pk.cols.length + 1, name]);
        pks.set(table, pk);
      }
    }
    for (const u of splitList(r.UKS ?? '')) {
      const m = UK_RE.exec(u);
      if (!m) continue;
      const key = `${table}|${m[1]}`;
      const c = uks.get(key) ?? { schema: OWNER, table, name: m[1], kind: 'unique' as const, columns: [], pos: [] };
      c.pos.push([Number(m[2]), name]);
      uks.set(key, c);
    }
    for (const f of splitList(r.FKS ?? '')) {
      const m = FK_RE.exec(f);
      if (!m) continue;
      const key = `${table}|${m[1]}`;
      const c = fks.get(key) ?? { schema: OWNER, table, name: m[1], kind: 'foreign' as const, columns: [], pos: [] };
      if (m[3] !== '?') c.refTable = m[3];
      c.onDelete = m[5] ? m[5].toLowerCase() : 'no action';
      c.pos.push([Number(m[2]), name, m[4] === '?' ? '' : m[4]]);
      fks.set(key, c);
    }
    for (const x of splitList(r.IDXS ?? '')) {
      const m = IX_RE.exec(x);
      if (!m) continue;
      const key = `${table}|${m[1]}`;
      const c = idx.get(key) ?? { schema: OWNER, table, name: m[1], unique: !!m[4], columns: [], pos: [] };
      c.pos.push([Number(m[2]), name, !!m[3]]);
      idx.set(key, c);
    }
  }

  part.tables = [...tables.values()];
  for (const [table, pk] of pks) {
    pk.cols.sort((a, b) => a[0] - b[0]);
    part.constraints.push({ schema: OWNER, table, name: pk.name, kind: 'primary', columns: pk.cols.map((c) => c[1]) });
  }
  for (const c of uks.values()) {
    c.pos.sort((a, b) => a[0] - b[0]);
    const { pos, ...info } = c;
    part.constraints.push({ ...info, columns: pos.map((p) => p[1]) });
  }
  for (const c of fks.values()) {
    c.pos.sort((a, b) => a[0] - b[0]);
    const { pos, ...info } = c;
    const refColumns = pos.map((p) => p[2]);
    part.constraints.push({ ...info, columns: pos.map((p) => p[1]), ...(refColumns.some(Boolean) ? { refColumns } : {}) });
  }
  for (const c of idx.values()) {
    c.pos.sort((a, b) => a[0] - b[0]);
    const { pos, ...info } = c;
    part.indexes.push({ ...info, columns: pos.map((p) => ({ name: p[1], desc: p[2] })) });
  }
  part.columns.sort((a, b) => (a.table === b.table ? a.position - b.position : a.table < b.table ? -1 : 1));

  if (part.rows === 0) {
    part.problems.push({ level: 'error', message: '테이블명·컬럼명이 있는 행이 없습니다. 접두어에 맞는 테이블이 없거나 헤더만 복사되었습니다.' });
  } else if (part.kind === 'collect') {
    const expected = part.summary?.rows;
    if (expected !== undefined && expected !== part.rows) {
      part.problems.push({
        level: 'error',
        message: `컬럼 ${expected}개 중 ${part.rows}개만 받았습니다. 결과 그리드를 끝까지 내리거나 모든 행을 가져온 뒤 다시 복사하세요. (행이 많으면 CSV 로 내보내 [파일에서 가져오기])`,
      });
    }
  } else {
    part.problems.push({
      level: 'warn',
      message: 'DevBoost 수집 쿼리 결과가 아니라 컬럼 명세로 읽었습니다. 일부만 복사됐는지는 확인하지 못하고, FK·UK·인덱스가 없을 수 있습니다.',
    });
  }
  return part;
}

function importCodes(recs: Rec[]): ImportPart {
  const part = emptyPart('codes');
  for (const r of recs) {
    const code = clean(r.CODE).trim();
    const group = clean(r.CODE_GROUP).trim();
    if (!group || !code) continue;
    part.rows++;
    const use = clean(r.USE_YN).trim().toUpperCase();
    part.codes.push({
      group, groupName: clean(r.GROUP_NAME).trim() || undefined, code, name: clean(r.CODE_NAME).trim(),
      order: num(r.SORT_ORDER), use: use ? use === 'Y' || use === '1' || use === 'TRUE' : undefined,
    });
  }
  if (part.rows === 0) part.problems.push({ level: 'error', message: '공통코드 행이 없습니다.' });
  return part;
}

function importJson(text: string): ImportPart {
  const part = emptyPart('json');
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
    part.rows = j.columns.length;
  } catch (e) {
    part.problems.push({ level: 'error', message: `JSON 을 읽을 수 없습니다: ${(e as Error).message}` });
  }
  return part;
}
