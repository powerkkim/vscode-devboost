/**
 * 가져온 조각(수집 결과·공통코드)을 저장 파일로 합치기 (vscode 의존 없음).
 *  - 접두어로 받은 결과는 기존 파일에서 그 접두어 테이블만 교체, 다른 테이블은 유지
 *  - 전체로 받은 결과는 파일 전체 교체 (공통코드는 유지)
 *  - 공통코드만 가져오면 기존 파일에 공통코드만 채움
 */
import { ImportPart, ImportProblem } from './importer';
import { emptySchema, SchemaFile } from './types';

export interface MergeInput {
  existing?: SchemaFile;
  main?: ImportPart;
  codes?: ImportPart;
  /** 개발 / 검증 / 운영 */
  label?: string;
  /** 결과에 스키마 정보(META)가 없을 때 (다른 컬럼 명세 쿼리) */
  fallbackSchema?: string;
}

export interface MergeResult {
  schema: SchemaFile;
  notes: ImportProblem[];
  /** 이번에 바뀐 테이블 수 */
  replacedTables: number;
  keptTables: number;
  /** 기존 파일을 통째로 바꾸는지 (접두어 없이 받았을 때). 화면에서 확인을 받는다 */
  fullReplace: boolean;
  /** 바뀌기 전 기존 파일의 테이블 수 */
  existingTables: number;
}

const startsWithAny = (name: string, prefixes: string[]) => prefixes.some((p) => name.startsWith(p));

export function mergeImport(input: MergeInput): MergeResult {
  const notes: ImportProblem[] = [];
  const { existing, main, codes } = input;
  let schema: SchemaFile;
  let replacedTables = 0;
  let keptTables = 0;
  let fullReplace = false;

  if (main?.json) {
    schema = structuredClone(main.json);
    replacedTables = schema.tables.length;
    fullReplace = !!existing && existing.source.schema === schema.source.schema && (existing.source.label ?? '') === (schema.source.label ?? '');
  } else if (main) {
    const s = main.summary;
    const owner = s?.schema ?? input.fallbackSchema ?? existing?.source.schema ?? 'SCHEMA';
    const prefixes = s?.prefixes ?? [];
    const sameSchema = existing && existing.source.schema === owner;
    schema = emptySchema({
      dbms: 'oracle',
      database: s?.database ?? (sameSchema ? existing!.source.database : undefined),
      schema: owner,
      collectedAt: s?.collectedAt,
      label: input.label ?? (sameSchema ? existing!.source.label : undefined),
      prefixes: prefixes.length ? prefixes : undefined,
    });
    fullReplace = !!sameSchema && prefixes.length === 0;
    if (sameSchema && prefixes.length > 0) {
      // 접두어 밖의 테이블은 기존 것을 그대로 둔다
      const keep = (t: string) => !startsWithAny(t, prefixes);
      schema.tables = existing!.tables.filter((x) => keep(x.name));
      schema.columns = existing!.columns.filter((x) => keep(x.table));
      schema.constraints = existing!.constraints.filter((x) => keep(x.table));
      schema.indexes = existing!.indexes.filter((x) => keep(x.table));
      keptTables = schema.tables.length;
      const allPrefixes = new Set([...(existing!.source.prefixes ?? []), ...prefixes]);
      // 기존 파일이 전체였다면 계속 전체
      schema.source.prefixes = existing!.source.prefixes && existing!.source.prefixes.length ? [...allPrefixes].sort() : undefined;
    }
    const set = <T extends { schema: string }>(xs: T[]) => xs.map((x) => ({ ...x, schema: owner }));
    schema.tables.push(...set(main.tables));
    schema.columns.push(...set(main.columns));
    schema.constraints.push(...set(main.constraints));
    schema.indexes.push(...set(main.indexes));
    replacedTables = main.tables.length || new Set(main.columns.map((c) => c.table)).size;
    if (sameSchema && existing!.codes) schema.codes = existing!.codes;
  } else if (existing) {
    schema = structuredClone(existing);
    if (input.label) schema.source.label = input.label;
  } else {
    schema = emptySchema({ dbms: 'oracle', schema: input.fallbackSchema ?? 'SCHEMA', label: input.label });
    notes.push({ level: 'error', message: '스키마 수집 결과를 먼저 가져오세요 (공통코드는 저장된 스키마에 합쳐집니다).' });
  }

  const codeRows = codes?.codes ?? [];
  if (codeRows.length) {
    schema.codes = codeRows;
  }

  schema.tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  schema.columns.sort((a, b) => (a.table === b.table ? a.position - b.position : a.table < b.table ? -1 : 1));
  // 테이블 정보 없이 컬럼만 있는 경우도 테이블로 등록
  const known = new Set(schema.tables.map((t) => t.name));
  for (const c of schema.columns) {
    if (!known.has(c.table)) {
      schema.tables.push({ schema: c.schema, name: c.table, kind: 'table' });
      known.add(c.table);
    }
  }
  return { schema, notes, replacedTables, keptTables, fullReplace, existingTables: existing?.tables.length ?? 0 };
}

/** 저장 파일 이름: 스키마 이름 + 환경 (같은 스키마의 개발/운영을 따로 두기 위해) */
export function schemaFileName(source: { schema: string; label?: string }): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_');
  return `${safe(source.schema)}${source.label ? `@${safe(source.label)}` : ''}.json`;
}
