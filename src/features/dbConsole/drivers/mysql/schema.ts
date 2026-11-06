import type { CollectedSchema, Relation, SchemaReader, TableColumn } from '../../driver/types';
import type { ColumnType, ConstraintInfo, IndexInfo } from '../../../dbSchema/schema/types';

/**
 * MySQL·MariaDB 딕셔너리 조회 (information_schema). vscode·mysql2 모듈에 의존하지 않는다 — 쿼리 함수를 받는다.
 * 스키마 = 데이터베이스. 시노님은 없다. ? 에 배열을 넣으면 IN 목록으로 펼쳐진다.
 */
type Query = (sql: string, values?: unknown[]) => Promise<unknown[][]>;

const s = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v));
const n = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : Number(v));

const SYSTEM = ['mysql', 'information_schema', 'performance_schema', 'sys'];

export function normalizeMysqlType(dataType: string): ColumnType {
  const t = dataType.toLowerCase();
  if (/^(varchar|char|enum|set|tinytext|text|mediumtext|longtext|json)$/.test(t)) return t.endsWith('text') && t !== 'text' && t !== 'tinytext' ? 'lob' : 'string';
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/.test(t)) return 'number';
  if (t === 'date') return 'date';
  if (t === 'datetime' || t === 'timestamp') return 'timestamp';
  if (/blob$/.test(t)) return 'lob';
  if (/binary$/.test(t)) return 'binary';
  return 'other';
}

export function mysqlSchemaReader(q: Query): SchemaReader {
  const constraintRows = (owner: string, tables: string[]) =>
    q(
      `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, rc.DELETE_RULE
         FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_NAME = tc.TABLE_NAME
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND rc.TABLE_NAME = tc.TABLE_NAME
        WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME IN (?) AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
        ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [owner, tables]
    );

  const constraints = async (owner: string, tables: string[]): Promise<ConstraintInfo[]> => {
    const by = new Map<string, ConstraintInfo>();
    for (const r of await constraintRows(owner, tables)) {
      const key = `${r[0]}.${r[1]}.${r[2]}`;
      let c = by.get(key);
      if (!c) {
        const type = String(r[2]);
        c = { schema: owner, table: String(r[0]), name: String(r[1]), kind: type === 'PRIMARY KEY' ? 'primary' : type === 'UNIQUE' ? 'unique' : 'foreign', columns: [] };
        if (c.kind === 'foreign') {
          c.refTable = s(r[4]);
          c.refColumns = [];
          c.onDelete = s(r[6]);
        }
        by.set(key, c);
      }
      c.columns.push(String(r[3]));
      if (c.refColumns && r[5] != null) c.refColumns.push(String(r[5]));
    }
    return [...by.values()];
  };

  const collect = async (owner: string, tables: string[]): Promise<CollectedSchema> => {
    const out: CollectedSchema = { tables: [], columns: [], constraints: [], indexes: [] };
    if (!tables.length) return out;
    const tabs = await q(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?) ORDER BY TABLE_NAME`,
      [owner, tables]
    );
    out.tables = tabs.map((r) => ({ schema: owner, name: String(r[0]), kind: /VIEW/.test(String(r[1])) ? 'view' : 'table', comment: /VIEW/.test(String(r[1])) ? undefined : s(r[2]) }));
    const cols = await q(
      `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
              IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [owner, tables]
    );
    out.columns = cols.map((r) => {
      const type = normalizeMysqlType(String(r[3]));
      return {
        schema: owner,
        table: String(r[0]),
        name: String(r[1]),
        position: Number(r[2]),
        type,
        rawType: String(r[3]).toUpperCase(),
        typeText: String(r[4]),
        length: type === 'string' ? n(r[5]) : undefined,
        precision: type === 'number' ? n(r[6]) : undefined,
        scale: type === 'number' ? n(r[7]) : undefined,
        nullable: String(r[8]) === 'YES',
        // MariaDB 는 기본값이 없으면 글자 NULL 을 준다
        default: String(r[9] ?? '') === 'NULL' ? undefined : s(r[9]),
        comment: s(r[10]),
      };
    });
    out.constraints = await constraints(owner, tables);
    const idx = await q(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, COLLATION
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [owner, tables]
    );
    const by = new Map<string, IndexInfo>();
    for (const r of idx) {
      const key = `${r[0]}.${r[1]}`;
      let x = by.get(key);
      if (!x) by.set(key, (x = { schema: owner, table: String(r[0]), name: String(r[1]), unique: String(r[2]) === '0', kind: s(r[3]), columns: [] }));
      // 식 인덱스(8.0.13+)는 칸 이름이 비어 있다
      x.columns.push({ name: s(r[4]) ?? '(식)', desc: String(r[5]) === 'D', expr: r[4] == null || undefined });
    }
    out.indexes = [...by.values()];
    return out;
  };

  return {
    schemas: async () =>
      (await q(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (?) ORDER BY SCHEMA_NAME`, [SYSTEM])).map((r) => String(r[0])),
    objects: async (owner) => {
      const rows = await q(`SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [owner]);
      const tables: string[] = [];
      const views: string[] = [];
      for (const r of rows) (/VIEW/.test(String(r[1])) ? views : tables).push(String(r[0]));
      return { tables, views, synonyms: [] };
    },
    columns: async (owner, table): Promise<TableColumn[]> =>
      (
        await q(
          `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          [owner, table]
        )
      ).map((r) => ({ name: String(r[0]), type: String(r[1]), nullable: String(r[2]) === 'YES' })),
    primaryKeys: async (owner, tables) => {
      const out: Record<string, string[]> = {};
      if (!tables.length) return out;
      for (const c of await constraints(owner, tables)) if (c.kind === 'primary') out[c.table] = c.columns;
      return out;
    },
    relations: async (owner, tables): Promise<Relation[]> => {
      if (tables.length < 2) return [];
      const set = new Set(tables);
      return (await constraints(owner, tables))
        .filter((c) => c.kind === 'foreign' && c.refTable && set.has(c.refTable))
        .map((c) => ({ fromTable: c.table, fromColumns: c.columns, toTable: c.refTable!, toColumns: c.refColumns ?? [] }));
    },
    collect,
    referencedBy: async (owner, table) => {
      const rows = await q(
        `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        [owner, table]
      );
      const by = new Map<string, { table: string; constraint: string; columns: string[] }>();
      for (const r of rows) {
        const key = `${r[0]}.${r[1]}`;
        let e = by.get(key);
        if (!e) by.set(key, (e = { table: String(r[0]), constraint: String(r[1]), columns: [] }));
        e.columns.push(String(r[2]));
      }
      return [...by.values()];
    },
    ddl: async (owner, name, kind) => {
      const id = (x: string) => '`' + x.replace(/`/g, '``') + '`';
      const rows = await q(`SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${id(owner)}.${id(name)}`);
      return String(rows[0]?.[1] ?? '');
    },
  };
}
