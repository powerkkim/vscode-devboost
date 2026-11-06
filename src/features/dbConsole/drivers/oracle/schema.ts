import type { Connection } from 'oracledb';
import type { CollectedSchema, Relation, SchemaObjects, SchemaReader, TableColumn } from '../../driver/types';
import type { ConstraintInfo as SchemaConstraint, IndexInfo as SchemaIndex } from '../../../dbSchema/schema/types';
import { normalizeOracleType } from '../../../dbSchema/schema/importer';

/**
 * Oracle 딕셔너리 조회 (사이드바 트리·자동 완성·JOIN 만들기). vscode 모듈에 의존하지 않는다.
 * ALL_* 뷰로 읽어 권한이 있는 다른 스키마도 볼 수 있다. 시노님은 가리키는 테이블·뷰로 따라간다.
 */

const names = (rows: unknown[][] | undefined) => (rows ?? []).map((r) => String(r[0]));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** IN (:t0, :t1 …) 자리와 값 */
function inList(prefix: string, values: string[]): { sql: string; binds: Record<string, string> } {
  const binds: Record<string, string> = {};
  values.forEach((v, i) => (binds[`${prefix}${i}`] = v));
  return { sql: values.map((_, i) => `:${prefix}${i}`).join(', '), binds };
}

/** Oracle 이 IN 목록에 받는 최대 개수 */
const MAX_IN = 1000;

export async function loadSchemas(connection: Connection): Promise<string[]> {
  // ORACLE_MAINTAINED 는 12.1 부터 (Thin 모드도 12.1 이상만 접속) → SYS·SYSTEM 같은 관리용 스키마는 뺀다
  const r = await connection.execute(`SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N' ORDER BY USERNAME`);
  return names(r.rows);
}

export async function loadObjects(connection: Connection, owner: string): Promise<SchemaObjects> {
  const tables = await connection.execute(`SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME NOT LIKE 'BIN$%' ORDER BY TABLE_NAME`, { o: owner });
  const views = await connection.execute(`SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = :o ORDER BY VIEW_NAME`, { o: owner });
  // 이 스키마에 만든 시노님 중 다른 DB(DB 링크)를 가리키지 않는 것
  const syn = await connection.execute(
    `SELECT SYNONYM_NAME, TABLE_OWNER, TABLE_NAME FROM ALL_SYNONYMS WHERE OWNER = :o AND DB_LINK IS NULL ORDER BY SYNONYM_NAME`,
    { o: owner }
  );
  return {
    tables: names(tables.rows),
    views: names(views.rows),
    synonyms: (syn.rows ?? []).map((r) => ({ name: String(r[0]), targetOwner: String(r[1] ?? owner), targetName: String(r[2]) })),
  };
}

/** 칸 타입을 사람이 읽는 모양으로: 길이·자릿수를 붙인다 */
export function columnTypeText(dataType: string, length: number | null, precision: number | null, scale: number | null): string {
  if (/^N?(VAR)?CHAR2?$/.test(dataType) || dataType === 'RAW') return length ? `${dataType}(${length})` : dataType;
  if (dataType === 'NUMBER' && precision !== null) return scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  return dataType;
}

/** 테이블이나 뷰의 칸 (정의된 순서) */
export async function loadColumns(connection: Connection, owner: string, table: string): Promise<TableColumn[]> {
  const r = await connection.execute(
    'SELECT COLUMN_NAME, DATA_TYPE, CHAR_LENGTH, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM ALL_TAB_COLUMNS WHERE OWNER = :o AND TABLE_NAME = :t ORDER BY COLUMN_ID',
    { o: owner, t: table }
  );
  return (r.rows ?? []).map((row) => {
    const type = String(row[1]);
    // 글자 칸은 글자 수(CHAR_LENGTH), RAW 는 바이트 수
    const length = /CHAR/.test(type) ? num(row[2]) : num(row[3]);
    return { name: String(row[0]), type: columnTypeText(type, length, num(row[4]), num(row[5])), nullable: String(row[6]) === 'Y' };
  });
}

export async function loadPrimaryKeys(connection: Connection, owner: string, tables: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < tables.length; i += MAX_IN) {
    const t = inList('t', tables.slice(i, i + MAX_IN));
    const r = await connection.execute(
      `SELECT cc.TABLE_NAME, cc.COLUMN_NAME
         FROM ALL_CONSTRAINTS c
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
        WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = :o AND c.TABLE_NAME IN (${t.sql})
        ORDER BY cc.TABLE_NAME, cc.POSITION`,
      { o: owner, ...t.binds }
    );
    for (const row of r.rows ?? []) (out[String(row[0])] ??= []).push(String(row[1]));
  }
  return out;
}

/** 주어진 테이블들끼리의 참조 관계 (같은 스키마 안). 칸 순서는 제약의 POSITION 으로 맞춘다 */
export async function loadRelations(connection: Connection, owner: string, tables: string[]): Promise<Relation[]> {
  if (tables.length < 2 || tables.length > MAX_IN) return [];
  const t = inList('t', tables);
  const r = await connection.execute(
    `SELECT c.CONSTRAINT_NAME, c.TABLE_NAME, cc.COLUMN_NAME, p.TABLE_NAME, pc.COLUMN_NAME
       FROM ALL_CONSTRAINTS c
       JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
       JOIN ALL_CONSTRAINTS p ON p.OWNER = c.R_OWNER AND p.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
       JOIN ALL_CONS_COLUMNS pc ON pc.OWNER = p.OWNER AND pc.CONSTRAINT_NAME = p.CONSTRAINT_NAME AND pc.POSITION = cc.POSITION
      WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = :o AND p.OWNER = :o
        AND c.TABLE_NAME IN (${t.sql}) AND p.TABLE_NAME IN (${t.sql})
      ORDER BY c.CONSTRAINT_NAME, cc.POSITION`,
    { o: owner, ...t.binds }
  );
  const byName = new Map<string, Relation>();
  for (const row of r.rows ?? []) {
    const key = String(row[0]);
    let rel = byName.get(key);
    if (!rel) byName.set(key, (rel = { fromTable: String(row[1]), fromColumns: [], toTable: String(row[3]), toColumns: [] }));
    rel.fromColumns.push(String(row[2]));
    rel.toColumns.push(String(row[4]));
  }
  return [...byName.values()];
}

export function oracleSchemaReader(connection: Connection): SchemaReader {
  return {
    schemas: () => loadSchemas(connection),
    objects: (owner) => loadObjects(connection, owner),
    columns: (owner, table) => loadColumns(connection, owner, table),
    primaryKeys: (owner, tables) => (tables.length ? loadPrimaryKeys(connection, owner, tables) : Promise.resolve({})),
    relations: (owner, tables) => loadRelations(connection, owner, tables),
    collect: (owner, tables) => collectSchema(connection, owner, tables),
    ddl: (owner, name, kind) => loadDdl(connection, owner, name, kind),
    referencedBy: (owner, table) => loadReferencedBy(connection, owner, table),
  };
}

// ───────── 테이블 정의 (테이블 정보 화면·테이블 정의서) ─────────

const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

/** IN 목록 한도(1000)씩 나눠 같은 쿼리를 돌리고 행을 모은다 */
async function chunked(connection: Connection, owner: string, tables: string[], sql: (inSql: string) => string): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for (let i = 0; i < tables.length; i += MAX_IN) {
    const t = inList('t', tables.slice(i, i + MAX_IN));
    const r = await connection.execute(sql(t.sql), { o: owner, ...t.binds });
    out.push(...(r.rows ?? []));
  }
  return out;
}

export async function collectSchema(connection: Connection, owner: string, tables: string[]): Promise<CollectedSchema> {
  const empty: CollectedSchema = { tables: [], columns: [], constraints: [], indexes: [] };
  if (!tables.length) return empty;

  const tabRows = await chunked(
    connection,
    owner,
    tables,
    (t) => `SELECT TABLE_NAME, TABLE_TYPE, COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = :o AND TABLE_NAME IN (${t}) ORDER BY TABLE_NAME`
  );
  const result: CollectedSchema = {
    tables: tabRows.map((r) => ({ schema: owner, name: String(r[0]), kind: String(r[1]) === 'VIEW' ? 'view' : 'table', comment: str(r[2]) })),
    columns: [],
    constraints: [],
    indexes: [],
  };

  // DATA_DEFAULT 는 LONG 이라 문자열로 온다 (앞뒤 공백·줄바꿈을 정리)
  const colRows = await chunked(
    connection,
    owner,
    tables,
    (t) => `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_ID, c.DATA_TYPE, c.CHAR_LENGTH, c.CHAR_USED, c.DATA_LENGTH,
                   c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE, c.DATA_DEFAULT, m.COMMENTS
              FROM ALL_TAB_COLUMNS c
              LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
             WHERE c.OWNER = :o AND c.TABLE_NAME IN (${t})
             ORDER BY c.TABLE_NAME, c.COLUMN_ID`
  );
  for (const r of colRows) {
    const t = normalizeOracleType(String(r[3]), n(r[4]), str(r[5]), n(r[6]), n(r[7]), n(r[8]));
    const def = str(r[10])?.trim();
    result.columns.push({
      schema: owner,
      table: String(r[0]),
      name: String(r[1]),
      position: Number(r[2]),
      type: t.type,
      rawType: String(r[3]),
      typeText: t.typeText,
      length: t.length,
      precision: n(r[7]),
      scale: n(r[8]),
      nullable: String(r[9]) === 'Y',
      default: def || undefined,
      comment: str(r[11]),
    });
  }

  const conRows = await chunked(
    connection,
    owner,
    tables,
    (t) => `SELECT c.TABLE_NAME, c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, cc.COLUMN_NAME, r.TABLE_NAME, rc.COLUMN_NAME, c.DELETE_RULE, c.STATUS
              FROM ALL_CONSTRAINTS c
              JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
              LEFT JOIN ALL_CONSTRAINTS r ON r.OWNER = c.R_OWNER AND r.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
              LEFT JOIN ALL_CONS_COLUMNS rc ON rc.OWNER = r.OWNER AND rc.CONSTRAINT_NAME = r.CONSTRAINT_NAME AND rc.POSITION = cc.POSITION
             WHERE c.OWNER = :o AND c.CONSTRAINT_TYPE IN ('P', 'U', 'R') AND c.TABLE_NAME IN (${t})
             ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`
  );
  const cons = new Map<string, SchemaConstraint>();
  for (const r of conRows) {
    const key = `${r[0]}.${r[1]}`;
    let c = cons.get(key);
    if (!c) {
      const type = String(r[2]);
      c = {
        schema: owner,
        table: String(r[0]),
        name: String(r[1]),
        kind: type === 'P' ? 'primary' : type === 'U' ? 'unique' : 'foreign',
        columns: [],
        enabled: String(r[7]) === 'ENABLED',
      };
      if (type === 'R') {
        c.refTable = str(r[4]);
        c.refColumns = [];
        c.onDelete = str(r[6]);
      }
      cons.set(key, c);
    }
    c.columns.push(String(r[3]));
    if (c.refColumns && r[5] != null) c.refColumns.push(String(r[5]));
  }
  result.constraints = [...cons.values()];

  const idxRows = await chunked(
    connection,
    owner,
    tables,
    (t) => `SELECT i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE, ic.COLUMN_NAME, ic.DESCEND
              FROM ALL_INDEXES i
              JOIN ALL_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
             WHERE i.TABLE_OWNER = :o AND i.TABLE_NAME IN (${t})
             ORDER BY i.TABLE_NAME, i.INDEX_NAME, ic.COLUMN_POSITION`
  );
  const idx = new Map<string, SchemaIndex>();
  for (const r of idxRows) {
    const key = `${r[0]}.${r[1]}`;
    let x = idx.get(key);
    if (!x) idx.set(key, (x = { schema: owner, table: String(r[0]), name: String(r[1]), unique: String(r[2]) === 'UNIQUE', kind: str(r[3]), columns: [] }));
    const col = String(r[4]);
    // 함수 기반·내림차순 인덱스의 칸은 SYS_NC… 로 보인다 (식)
    x.columns.push({ name: col, desc: String(r[5]) === 'DESC', expr: /^SYS_NC\d/.test(col) || undefined });
  }
  result.indexes = [...idx.values()];
  return result;
}

/** DBMS_METADATA 로 만든 DDL (권한이 없으면 오류) */
export async function loadDdl(connection: Connection, owner: string, name: string, kind: 'table' | 'view'): Promise<string> {
  const oracledb = require('oracledb') as typeof import('oracledb');
  const r = await connection.execute(`SELECT DBMS_METADATA.GET_DDL(:k, :n, :o) FROM DUAL`, { k: kind === 'view' ? 'VIEW' : 'TABLE', n: name, o: owner }, {
    fetchTypeHandler: (meta) => (meta.dbType === oracledb.DB_TYPE_CLOB ? { type: oracledb.STRING } : undefined),
  });
  return String(r.rows?.[0]?.[0] ?? '').trim();
}

/** 이 테이블(의 PK·UK)을 참조하는 FK 들 */
export async function loadReferencedBy(connection: Connection, owner: string, table: string): Promise<{ table: string; constraint: string; columns: string[] }[]> {
  const r = await connection.execute(
    `SELECT c.TABLE_NAME, c.CONSTRAINT_NAME, cc.COLUMN_NAME
       FROM ALL_CONSTRAINTS c
       JOIN ALL_CONSTRAINTS p ON p.OWNER = c.R_OWNER AND p.CONSTRAINT_NAME = c.R_CONSTRAINT_NAME
       JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
      WHERE c.CONSTRAINT_TYPE = 'R' AND p.OWNER = :o AND p.TABLE_NAME = :t
      ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`,
    { o: owner, t: table }
  );
  const by = new Map<string, { table: string; constraint: string; columns: string[] }>();
  for (const row of r.rows ?? []) {
    const key = `${row[0]}.${row[1]}`;
    let e = by.get(key);
    if (!e) by.set(key, (e = { table: String(row[0]), constraint: String(row[1]), columns: [] }));
    e.columns.push(String(row[2]));
  }
  return [...by.values()];
}
