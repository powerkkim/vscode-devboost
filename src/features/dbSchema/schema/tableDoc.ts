/**
 * 테이블 정의서 CSV 만들기 (vscode 의존 없음). Excel 에서 바로 열리게 UTF-8 BOM + CRLF.
 *  - 목차: 테이블 한 줄씩 (No, 테이블명, 설명, 구분, 컬럼 수, PK, FK 수, 인덱스 수)
 *  - 정의서: 테이블마다 머리(테이블명·설명·PK) + 컬럼 명세 표 + 인덱스 목록, 테이블 사이 빈 줄
 */
import { toCsv } from './csv';
import { ColumnInfo, ConstraintInfo, IndexInfo, SchemaFile, TableInfo } from './types';

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
  const idxRows: unknown[][] = [
    ...header(schema, '테이블 정의서 목차', today),
    ['No', '테이블명', '테이블 설명', '구분', '컬럼 수', 'PK', 'FK 수', '인덱스 수'],
  ];
  facts.forEach((f, i) => {
    idxRows.push([
      i + 1, f.t.name, f.t.comment ?? '', f.t.kind === 'view' ? '뷰' : '테이블', f.cols.length,
      f.pk ? f.pk.columns.join(', ') : '', f.fks.length || '', f.idx.length || '',
    ]);
  });

  // ── 정의서
  const rows: unknown[][] = [...header(schema, '테이블 정의서', today)];
  facts.forEach((f, i) => {
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

    rows.push([`${i + 1}. ${f.t.name}`, f.t.comment ?? '']);
    rows.push(['테이블명', f.t.name, '테이블 설명', f.t.comment ?? '', '구분', f.t.kind === 'view' ? '뷰' : '테이블']);
    rows.push(['PK', f.pk ? f.pk.columns.join(', ') : '', 'PK 이름', f.pk?.name ?? '']);
    rows.push(['No', '컬럼명', '컬럼 설명', '데이터 타입', 'NULL', '기본값', 'PK', 'UK', 'FK 참조', '인덱스']);
    f.cols.forEach((c, n) => {
      const pk = pkPos.get(c.name);
      rows.push([
        n + 1, c.name, c.comment ?? '', c.typeText, c.nullable ? 'Y' : 'N', c.default ?? '',
        pk ? (f.pk!.columns.length > 1 ? `Y(${pk})` : 'Y') : '',
        ukOf(c.name).join(', '), fkOf(c.name).join(', '), ixOf(c.name).join(', '),
      ]);
    });
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

/** 파일 이름: 테이블정의서_목차_PLM_20261026.csv / 테이블정의서_PLM_20261026.csv */
export function tableDocFileNames(schema: SchemaFile, today = localDate()): { index: string; detail: string } {
  const tag = `${schema.source.schema}${schema.source.label ? '_' + schema.source.label : ''}_${today.replace(/-/g, '')}`.replace(/[\\/:*?"<>|\s]+/g, '_');
  return { index: `테이블정의서_목차_${tag}.csv`, detail: `테이블정의서_${tag}.csv` };
}
