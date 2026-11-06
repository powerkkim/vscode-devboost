import type { Connection } from 'oracledb';
import type { Relation, SchemaObjects, SchemaReader, TableColumn } from '../../driver/types';

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
  };
}
