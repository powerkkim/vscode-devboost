import type { CollectedSchema, Relation, SchemaReader, TableColumn } from '../../driver/types';
import type { ColumnType, ConstraintInfo, IndexInfo } from '../../../dbSchema/schema/types';

/**
 * PostgreSQL 딕셔너리 조회 (pg_catalog). vscode·pg 모듈에 의존하지 않는다 — 쿼리 함수를 받는다.
 * 스키마 = 네임스페이스(public 등). 시노님은 없다.
 */
type Query = (sql: string, values?: unknown[]) => Promise<unknown[][]>;

const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
const list = (v: unknown) => (v === null || v === undefined || v === '' ? [] : String(v).split('\u001f'));

/** 테이블(일반·파티션·외부)과 뷰(일반·구체화) */
const TABLE_KINDS = `('r','p','f')`;
const VIEW_KINDS = `('v','m')`;

/** format_type() 글 → 정의서 규격의 형 분류·길이 */
export function normalizePgType(text: string): { type: ColumnType; length?: number; precision?: number; scale?: number } {
  const t = text.toLowerCase();
  const nums = /\((\d+)(?:,\s*(\d+))?\)/.exec(t);
  if (/^(character varying|varchar|character|char|bpchar|name|citext|text)\b/.test(t)) return { type: 'string', length: nums ? Number(nums[1]) : undefined };
  if (/^(numeric|decimal)\b/.test(t)) return { type: 'number', precision: nums ? Number(nums[1]) : undefined, scale: nums?.[2] !== undefined ? Number(nums[2]) : undefined };
  if (/^(smallint|integer|bigint|real|double precision|money|smallserial|serial|bigserial)\b/.test(t)) return { type: 'number' };
  if (t === 'date') return { type: 'date' };
  if (t.startsWith('timestamp')) return { type: 'timestamp' };
  if (t === 'bytea') return { type: 'binary' };
  return { type: 'other' };
}

export function postgresSchemaReader(q: Query): SchemaReader {
  const objects = async (owner: string) => {
    const rows = await q(
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ${TABLE_KINDS.slice(0, -1)},${VIEW_KINDS.slice(1)} AND NOT c.relispartition
        ORDER BY c.relname`,
      [owner]
    );
    const tables: string[] = [];
    const views: string[] = [];
    for (const r of rows) (String(r[1]) === 'v' || String(r[1]) === 'm' ? views : tables).push(String(r[0]));
    return { tables, views, synonyms: [] };
  };

  const columns = async (owner: string, table: string): Promise<TableColumn[]> => {
    const rows = await q(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [owner, table]
    );
    return rows.map((r) => ({ name: String(r[0]), type: String(r[1]), nullable: String(r[2]) === 't' }));
  };

  /** 제약 (P·U·F). 칸 이름은 \u001f 로 이어 받는다 (배열 형을 글로 받으므로) */
  const constraintRows = (owner: string, tables: string[]) =>
    q(
      `SELECT c.relname, con.conname, con.contype,
              (SELECT string_agg(a.attname, E'\\x1f' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
              rc.relname,
              (SELECT string_agg(a.attname, E'\\x1f' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum),
              con.confdeltype, con.convalidated
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class rc ON rc.oid = con.confrelid
        WHERE n.nspname = $1 AND c.relname = ANY($2) AND con.contype IN ('p', 'u', 'f')
        ORDER BY c.relname, con.conname`,
      [owner, tables]
    );

  const DELETE_RULE: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

  const collect = async (owner: string, tables: string[]): Promise<CollectedSchema> => {
    const out: CollectedSchema = { tables: [], columns: [], constraints: [], indexes: [] };
    if (!tables.length) return out;
    const tabs = await q(
      `SELECT c.relname, c.relkind, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2) ORDER BY c.relname`,
      [owner, tables]
    );
    out.tables = tabs.map((r) => ({ schema: owner, name: String(r[0]), kind: String(r[1]) === 'v' || String(r[1]) === 'm' ? 'view' : 'table', comment: s(r[2]) }));

    const cols = await q(
      `SELECT c.relname, a.attname, a.attnum, format_type(a.atttypid, a.atttypmod), t.typname, NOT a.attnotnull,
              pg_get_expr(d.adbin, d.adrelid), col_description(c.oid, a.attnum)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = ANY($2) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`,
      [owner, tables]
    );
    out.columns = cols.map((r) => {
      const typeText = String(r[3]);
      const n = normalizePgType(typeText);
      return {
        schema: owner,
        table: String(r[0]),
        name: String(r[1]),
        position: Number(r[2]),
        type: n.type,
        rawType: String(r[4]),
        typeText,
        length: n.length,
        precision: n.precision,
        scale: n.scale,
        nullable: String(r[5]) === 't',
        default: s(r[6]),
        comment: s(r[7]),
      };
    });

    out.constraints = (await constraintRows(owner, tables)).map((r): ConstraintInfo => {
      const kind = String(r[2]) === 'p' ? 'primary' : String(r[2]) === 'u' ? 'unique' : 'foreign';
      const c: ConstraintInfo = { schema: owner, table: String(r[0]), name: String(r[1]), kind, columns: list(r[3]), enabled: String(r[7]) !== 'f' };
      if (kind === 'foreign') {
        c.refTable = s(r[4]);
        c.refColumns = list(r[5]);
        c.onDelete = DELETE_RULE[String(r[6])] ?? undefined;
      }
      return c;
    });

    const idx = await q(
      `SELECT t.relname, i.relname, ix.indisunique, am.amname,
              (SELECT string_agg(pg_get_indexdef(ix.indexrelid, k, true) || CASE WHEN (ix.indoption[k - 1] & 1) = 1 THEN ' DESC' ELSE '' END, E'\\x1f' ORDER BY k)
                 FROM generate_series(1, ix.indnkeyatts) k)
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am ON am.oid = i.relam
        WHERE n.nspname = $1 AND t.relname = ANY($2)
        ORDER BY t.relname, i.relname`,
      [owner, tables]
    );
    out.indexes = idx.map(
      (r): IndexInfo => ({
        schema: owner,
        table: String(r[0]),
        name: String(r[1]),
        unique: String(r[2]) === 't',
        kind: s(r[3]),
        columns: list(r[4]).map((c) => {
          const desc = / DESC$/.test(c);
          const name = c.replace(/ DESC$/, '');
          return { name, desc, expr: !/^"?[\w$]+"?$/.test(name) || undefined };
        }),
      })
    );
    return out;
  };

  return {
    schemas: async () =>
      (await q(`SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname`)).map((r) => String(r[0])),
    objects,
    columns,
    primaryKeys: async (owner, tables) => {
      const out: Record<string, string[]> = {};
      for (const r of await constraintRows(owner, tables)) if (String(r[2]) === 'p') out[String(r[0])] = list(r[3]);
      return out;
    },
    relations: async (owner, tables): Promise<Relation[]> => {
      if (tables.length < 2) return [];
      const set = new Set(tables);
      return (await constraintRows(owner, tables))
        .filter((r) => String(r[2]) === 'f' && set.has(String(r[4])))
        .map((r) => ({ fromTable: String(r[0]), fromColumns: list(r[3]), toTable: String(r[4]), toColumns: list(r[5]) }));
    },
    collect,
    referencedBy: async (owner, table) => {
      const rows = await q(
        `SELECT c.relname, con.conname,
                (SELECT string_agg(a.attname, E'\\x1f' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_class rc ON rc.oid = con.confrelid
           JOIN pg_namespace n ON n.oid = rc.relnamespace
          WHERE con.contype = 'f' AND n.nspname = $1 AND rc.relname = $2
          ORDER BY c.relname, con.conname`,
        [owner, table]
      );
      return rows.map((r) => ({ table: String(r[0]), constraint: String(r[1]), columns: list(r[2]) }));
    },
    /** 뷰는 서버가 주는 정의로, 테이블은 칸·기본값·제약으로 만든다 (주석 포함) */
    ddl: async (owner, name, kind) => {
      const qn = (x: string) => (/^[a-z_][a-z0-9_$]*$/.test(x) ? x : `"${x.replace(/"/g, '""')}"`);
      const full = `${qn(owner)}.${qn(name)}`;
      if (kind === 'view') {
        const r = await q(`SELECT pg_get_viewdef(c.oid, true) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [owner, name]);
        return `CREATE OR REPLACE VIEW ${full} AS\n${String(r[0]?.[0] ?? '').trim()}`;
      }
      const c = await collect(owner, [name]);
      const lines = c.columns.map((col) => `  ${qn(col.name)} ${col.typeText}${col.default ? ` DEFAULT ${col.default}` : ''}${col.nullable ? '' : ' NOT NULL'}`);
      const defs = await q(
        `SELECT con.conname, pg_get_constraintdef(con.oid, true) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 ORDER BY con.contype, con.conname`,
        [owner, name]
      );
      for (const d of defs) lines.push(`  CONSTRAINT ${qn(String(d[0]))} ${String(d[1])}`);
      const out = [`CREATE TABLE ${full} (\n${lines.join(',\n')}\n);`];
      const t = c.tables[0];
      if (t?.comment) out.push(`COMMENT ON TABLE ${full} IS '${t.comment.replace(/'/g, "''")}';`);
      for (const col of c.columns) if (col.comment) out.push(`COMMENT ON COLUMN ${full}.${qn(col.name)} IS '${col.comment.replace(/'/g, "''")}';`);
      const idx = await q(
        `SELECT pg_get_indexdef(ix.indexrelid) FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid)`,
        [owner, name]
      );
      for (const r of idx) out.push(`${String(r[0])};`);
      return out.join('\n');
    },
  };
}
