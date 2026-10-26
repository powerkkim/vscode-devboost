/**
 * 테이블 정의서 만들기 (vscode 의존 없음).
 *  - Excel(.xlsx, 기본): 목차 시트 + 테이블마다 시트 하나. 목차의 테이블명을 누르면 그 시트로, 각 시트의 '◀ 목차'로 돌아옴
 *  - CSV: 목차 파일 + 정의서 파일 (UTF-8 BOM + CRLF)
 * 내용
 *  - 목차: 테이블 한 줄씩 (No, 테이블명, 설명, 구분, 컬럼 수, PK, FK 수, 인덱스 수)
 *  - 테이블: 머리(테이블명·설명·구분·PK) + 컬럼 명세 표 + 인덱스 목록
 */
import { toCsv } from './csv';
import { ColumnInfo, ConstraintInfo, IndexInfo, SchemaFile, TableInfo } from './types';
import { buildXlsx, safeSheetNames, XCell, XSheet } from './xlsx';

export interface TableDocOptions {
  /** 대상 테이블 이름. 없으면 전체 테이블(뷰 제외) */
  tables?: string[];
  includeViews?: boolean;
  /** 표지 줄에 넣을 날짜 (기본: 오늘) */
  today?: string;
}

export interface TableDoc {
  index: string;
  detail: string;
  tableCount: number;
  columnCount: number;
}

interface TableFacts {
  t: TableInfo;
  cols: ColumnInfo[];
  pk?: ConstraintInfo;
  uks: ConstraintInfo[];
  fks: ConstraintInfo[];
  idx: IndexInfo[];
}

function collect(schema: SchemaFile, opts: TableDocOptions): TableFacts[] {
  const wanted = opts.tables ? new Set(opts.tables) : undefined;
  const tables = schema.tables.filter((t) => (wanted ? wanted.has(t.name) : opts.includeViews || t.kind === 'table'));
  const byTable = <T extends { table: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.table, [...(m.get(x.table) ?? []), x]);
    return m;
  };
  const cols = byTable(schema.columns);
  const cons = byTable(schema.constraints);
  const idx = byTable(schema.indexes);
  return tables.map((t) => {
    const cs = cons.get(t.name) ?? [];
    return {
      t,
      cols: [...(cols.get(t.name) ?? [])].sort((a, b) => a.position - b.position),
      pk: cs.find((c) => c.kind === 'primary'),
      uks: cs.filter((c) => c.kind === 'unique'),
      fks: cs.filter((c) => c.kind === 'foreign'),
      idx: idx.get(t.name) ?? [],
    };
  });
}

/** 로컬 날짜 YYYY-MM-DD (toISOString 은 UTC 라 한국 시간 자정 전후로 하루가 틀어짐) */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const COLUMN_HEADER = ['No', '컬럼명', '컬럼 설명', '데이터 타입', 'NULL', '기본값', 'PK', 'UK', 'FK 참조', '인덱스'];
const INDEX_HEADER = ['No', '테이블명', '테이블 설명', '구분', '컬럼 수', 'PK', 'FK 수', '인덱스 수'];

/** 컬럼 명세 표의 행들 (정의서 형식 공통) */
function columnRows(f: TableFacts): (string | number)[][] {
  const pkPos = new Map((f.pk?.columns ?? []).map((c, n) => [c, n + 1]));
  const ukOf = (col: string) => f.uks.filter((u) => u.columns.includes(col)).map((u) => u.name);
  const fkOf = (col: string) =>
    f.fks
      .filter((k) => k.columns.includes(col))
      .map((k) => {
        const at = k.columns.indexOf(col);
        const ref = k.refColumns?.[at];
        return k.refTable ? `${k.refTable}${ref ? '.' + ref : ''}` : k.name;
      });
  const ixOf = (col: string) =>
    f.idx
      .filter((x) => !(f.pk && x.name === f.pk.name)) // PK 인덱스는 PK 칸으로 충분
      .map((x) => {
        const at = x.columns.findIndex((c) => c.name === col);
        return at < 0 ? '' : `${x.name}(${at + 1}${x.columns[at].desc ? ' DESC' : ''})`;
      })
      .filter(Boolean);
  return f.cols.map((c, n) => {
    const pk = pkPos.get(c.name);
    return [
      n + 1, c.name, c.comment ?? '', c.typeText, c.nullable ? 'Y' : 'N', c.default ?? '',
      pk ? (f.pk!.columns.length > 1 ? `Y(${pk})` : 'Y') : '',
      ukOf(c.name).join(', '), fkOf(c.name).join(', '), ixOf(c.name).join(', '),
    ];
  });
}

const indexRow = (f: TableFacts, i: number): (string | number)[] => [
  i + 1, f.t.name, f.t.comment ?? '', f.t.kind === 'view' ? '뷰' : '테이블', f.cols.length,
  f.pk ? f.pk.columns.join(', ') : '', f.fks.length || '', f.idx.length || '',
];

function header(schema: SchemaFile, title: string, today: string): unknown[][] {
  const s = schema.source;
  return [
    [title],
    ['스키마', s.schema, '환경', s.label ?? '', '수집일', (s.collectedAt ?? '').slice(0, 10), '작성일', today],
    [],
  ];
}

export function buildTableDoc(schema: SchemaFile, opts: TableDocOptions = {}): TableDoc {
  const today = opts.today ?? localDate();
  const facts = collect(schema, opts);

  // ── 목차
  const idxRows: unknown[][] = [...header(schema, '테이블 정의서 목차', today), INDEX_HEADER];
  facts.forEach((f, i) => idxRows.push(indexRow(f, i)));

  // ── 정의서
  const rows: unknown[][] = [...header(schema, '테이블 정의서', today)];
  facts.forEach((f, i) => {
    rows.push([`${i + 1}. ${f.t.name}`, f.t.comment ?? '']);
    rows.push(['테이블명', f.t.name, '테이블 설명', f.t.comment ?? '', '구분', f.t.kind === 'view' ? '뷰' : '테이블']);
    rows.push(['PK', f.pk ? f.pk.columns.join(', ') : '', 'PK 이름', f.pk?.name ?? '']);
    rows.push(COLUMN_HEADER);
    rows.push(...columnRows(f));
    if (f.idx.length) {
      rows.push([]);
      rows.push(['', '인덱스', '유니크', '컬럼']);
      for (const x of f.idx) {
        rows.push(['', x.name, x.unique ? 'Y' : 'N', x.columns.map((c) => `${c.name}${c.desc ? ' DESC' : ''}`).join(', ')]);
      }
    }
    rows.push([]);
    rows.push([]);
  });

  return {
    index: toCsv(idxRows),
    detail: toCsv(rows),
    tableCount: facts.length,
    columnCount: facts.reduce((n, f) => n + f.cols.length, 0),
  };
}

const fileTag = (schema: SchemaFile, today: string) =>
  `${schema.source.schema}${schema.source.label ? '_' + schema.source.label : ''}_${today.replace(/-/g, '')}`.replace(/[\\/:*?"<>|\s]+/g, '_');

/** 파일 이름: 테이블정의서_목차_PLM_20261026.csv / 테이블정의서_PLM_20261026.csv */
export function tableDocFileNames(schema: SchemaFile, today = localDate()): { index: string; detail: string } {
  const tag = fileTag(schema, today);
  return { index: `테이블정의서_목차_${tag}.csv`, detail: `테이블정의서_${tag}.csv` };
}

/** Excel 파일 이름: 테이블정의서_PLM_개발_20261026.xlsx */
export function tableDocXlsxName(schema: SchemaFile, today = localDate()): string {
  return `테이블정의서_${fileTag(schema, today)}.xlsx`;
}

/** 테이블 시트의 열 너비 (No, 컬럼명, 설명, 타입, NULL, 기본값, PK, UK, FK, 인덱스) */
const TABLE_WIDTHS = [10, 24, 32, 20, 7, 18, 7, 18, 28, 26];

/**
 * Excel 정의서: 목차 시트 + 테이블마다 시트.
 * 시트 이름은 테이블 이름 (31자 넘거나 쓸 수 없는 글자가 있으면 바꿈, 목차와 겹치지 않게).
 */
export function buildTableDocXlsx(schema: SchemaFile, opts: TableDocOptions = {}): { data: Uint8Array; tableCount: number; columnCount: number } {
  const today = opts.today ?? localDate();
  const facts = collect(schema, opts);
  const INDEX_SHEET = '목차';
  const sheetNames = safeSheetNames([INDEX_SHEET, ...facts.map((f) => f.t.name)]).slice(1);
  const s = schema.source;
  const metaLine = `스키마 ${s.schema}${s.label ? ' · ' + s.label : ''}${s.database ? ' · ' + s.database : ''} · 수집일 ${(s.collectedAt ?? '').slice(0, 10)} · 작성일 ${today}`;
  const cell = (v: string | number | undefined, st: XCell['s'] = 'body'): XCell => ({ v, s: st });

  const index: XSheet = {
    name: INDEX_SHEET,
    rows: [
      [cell('테이블 정의서', 'title')],
      [cell(metaLine, 'muted')],
      [],
      INDEX_HEADER.map((h) => cell(h, 'header')),
      ...facts.map((f, i) => indexRow(f, i).map((v, c) => (c === 1 ? { v, s: 'link' as const, sheetLink: sheetNames[i] } : cell(v)))),
    ],
    widths: [6, 28, 36, 8, 9, 30, 7, 9],
    autoFilterRow: 3,
    freezeRows: 4,
  };

  const tables: XSheet[] = facts.map((f, i) => {
    const kind = f.t.kind === 'view' ? '뷰' : '테이블';
    const rows: XCell[][] = [
      [cell(f.t.comment ? `${f.t.name}  ${f.t.comment}` : f.t.name, 'title')],
      [{ v: '◀ 목차', s: 'link', sheetLink: INDEX_SHEET }, cell(metaLine, 'muted')],
      [],
      [cell('테이블명', 'label'), cell(f.t.name), cell('테이블 설명', 'label'), cell(f.t.comment ?? ''), cell('구분', 'label'), cell(kind)],
      [cell('PK', 'label'), cell(f.pk ? f.pk.columns.join(', ') : ''), cell('PK 이름', 'label'), cell(f.pk?.name ?? ''), cell('컬럼 수', 'label'), cell(f.cols.length)],
      [],
      COLUMN_HEADER.map((h) => cell(h, 'header')),
      ...columnRows(f).map((r) => r.map((v) => cell(v))),
    ];
    if (f.idx.length) {
      rows.push([], [cell('No', 'header'), cell('인덱스', 'header'), cell('컬럼', 'header'), cell('유니크', 'header')]);
      f.idx.forEach((x, n) => rows.push([cell(n + 1), cell(x.name), cell(x.columns.map((c) => `${c.name}${c.desc ? ' DESC' : ''}`).join(', ')), cell(x.unique ? 'Y' : 'N')]));
    }
    return { name: sheetNames[i], rows, widths: TABLE_WIDTHS, freezeRows: 7 };
  });

  return {
    data: buildXlsx([index, ...tables]),
    tableCount: facts.length,
    columnCount: facts.reduce((n, f) => n + f.cols.length, 0),
  };
}
