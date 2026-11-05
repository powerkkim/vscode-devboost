import type { Connection } from 'oracledb';

/**
 * 접속한 계정의 테이블·뷰·칸 목록 (사이드바 트리와 콘솔의 자동 완성에 쓴다). vscode 모듈에 의존하지 않는다.
 * 접속한 계정이 가진 것(USER_*)만 본다.
 */

export interface SchemaObjects {
  tables: string[];
  views: string[];
}

export interface TableColumn {
  name: string;
  /** VARCHAR2(10), NUMBER(10,2), DATE … */
  type: string;
  nullable: boolean;
}

const names = (rows: unknown[][] | undefined) => (rows ?? []).map((r) => String(r[0]));

export async function loadObjects(connection: Connection): Promise<SchemaObjects> {
  const tables = await connection.execute('SELECT TABLE_NAME FROM USER_TABLES ORDER BY TABLE_NAME');
  const views = await connection.execute('SELECT VIEW_NAME FROM USER_VIEWS ORDER BY VIEW_NAME');
  return { tables: names(tables.rows), views: names(views.rows) };
}

/** 칸 타입을 사람이 읽는 모양으로: 길이·자릿수를 붙인다 */
export function columnTypeText(dataType: string, length: number | null, precision: number | null, scale: number | null): string {
  if (/^N?(VAR)?CHAR2?$/.test(dataType) || dataType === 'RAW') return length ? `${dataType}(${length})` : dataType;
  if (dataType === 'NUMBER' && precision !== null) return scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  return dataType;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 테이블이나 뷰의 칸 (정의된 순서) */
export async function loadColumns(connection: Connection, table: string): Promise<TableColumn[]> {
  const r = await connection.execute(
    'SELECT COLUMN_NAME, DATA_TYPE, CHAR_LENGTH, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t ORDER BY COLUMN_ID',
    { t: table }
  );
  return (r.rows ?? []).map((row) => {
    const type = String(row[1]);
    // 글자 칸은 글자 수(CHAR_LENGTH), RAW 는 바이트 수
    const length = /CHAR/.test(type) ? num(row[2]) : num(row[3]);
    return { name: String(row[0]), type: columnTypeText(type, length, num(row[4]), num(row[5])), nullable: String(row[6]) === 'Y' };
  });
}
