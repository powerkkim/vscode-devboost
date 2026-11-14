/**
 * DevBoost DB 스키마 저장 규격 (devboost-schema v1). docs/SPEC-db-schema 문서 3·4장과 같다.
 * 수집 결과를 가져와 .devboost/schema/<스키마>.json 으로 저장하고, 정의서·호버 등이 이 모양을 읽는다.
 */

export interface SchemaSource {
  dbms: string;
  database?: string;
  schema: string;
  collectedAt?: string;
  /** 개발 / 검증 / 운영 같은 환경 이름 */
  label?: string;
  /** 접두어로 받았으면 그 목록. 없으면 전체 */
  prefixes?: string[];
}

export type TableKind = 'table' | 'view';

export interface TableInfo {
  schema: string;
  name: string;
  kind: TableKind;
  comment?: string;
}

export type ColumnType = 'string' | 'number' | 'date' | 'timestamp' | 'lob' | 'binary' | 'other';

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  position: number;
  type: ColumnType;
  rawType: string;
  typeText: string;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  default?: string;
  comment?: string;
}

export type ConstraintKind = 'primary' | 'unique' | 'foreign';

export interface ConstraintInfo {
  schema: string;
  table: string;
  name: string;
  kind: ConstraintKind;
  columns: string[];
  refTable?: string;
  refColumns?: string[];
  onDelete?: string;
  enabled?: boolean;
}

export interface IndexColumn {
  name: string;
  desc: boolean;
  expr?: boolean;
}

export interface IndexInfo {
  schema: string;
  table: string;
  name: string;
  unique: boolean;
  kind?: string;
  columns: IndexColumn[];
}

export interface CodeInfo {
  group: string;
  groupName?: string;
  code: string;
  name: string;
  order?: number;
  use?: boolean;
}

export interface SchemaFile {
  format: 'devboost-schema';
  version: 1;
  source: SchemaSource;
  tables: TableInfo[];
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  codes?: CodeInfo[];
}

export function emptySchema(source: SchemaSource): SchemaFile {
  return { format: 'devboost-schema', version: 1, source, tables: [], columns: [], constraints: [], indexes: [] };
}
