/**
 * Oracle 스키마 수집 SQL 만들기 (vscode 의존 없음). docs/SPEC-db-schema 6장·6.1 과 같은 SQL.
 *  - 본 쿼리: 테이블·뷰, 컬럼, PK/UK/FK, 인덱스 + 행 수 검증용 SUMMARY
 *  - 기본값 쿼리: DATA_DEFAULT 가 LONG 이라 본 쿼리와 합칠 수 없어 따로
 * 두 쿼리에 같은 접두어가 들어가도록 여기서 함께 만든다.
 */

/** 접두어 정리: 공백 제거, 대문자, 빈 값·중복 제거 */
export function normalizePrefixes(prefixes: string[]): string[] {
  const out: string[] = [];
  for (const p of prefixes) {
    const v = p.trim().toUpperCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** p 의 행들: 접두어마다 한 줄. 없으면 NULL 한 줄(전체) */
function prefixRows(prefixes: string[], indent: string): string {
  const ps = normalizePrefixes(prefixes);
  if (ps.length === 0) return `SELECT CAST(NULL AS VARCHAR2(128)) AS prefix FROM dual   -- 전체`;
  return ps.map((p, i) => (i === 0 ? `SELECT ${lit(p)} AS prefix FROM dual` : `${indent}UNION ALL SELECT ${lit(p)} FROM dual`)).join('\n');
}

export function buildMainSql(prefixes: string[]): string {
  const ps = normalizePrefixes(prefixes);
  const title = ps.length ? `접두어 ${ps.join(', ')}` : '전체';
  return `-- DevBoost 스키마 수집 ① 본 쿼리 (${title})
-- 실행(Ctrl+Enter) 후 결과 그리드 전체를 헤더와 함께 복사 → DevBoost 화면의 [클립보드에서 가져오기]
WITH p AS (
  ${prefixRows(prefixes, '  ')}
),
t AS (
  SELECT table_name, table_type, comments
    FROM user_tab_comments
   WHERE table_type IN ('TABLE', 'VIEW')
     AND table_name NOT LIKE 'BIN$%'
     AND EXISTS (SELECT 1 FROM p
                  WHERE p.prefix IS NULL
                     OR SUBSTR(table_name, 1, LENGTH(p.prefix)) = p.prefix)
),
c AS (
  SELECT tc.table_name, tc.column_name, tc.column_id, tc.data_type, tc.char_length, tc.char_used,
         tc.data_length, tc.data_precision, tc.data_scale, tc.nullable, cc.comments
    FROM user_tab_columns tc
    JOIN t ON t.table_name = tc.table_name
    LEFT JOIN user_col_comments cc
      ON cc.table_name = tc.table_name AND cc.column_name = tc.column_name
),
k AS (
  SELECT con.table_name, con.constraint_name, con.constraint_type, con.status, con.delete_rule,
         col.position, col.column_name,
         rcon.table_name AS ref_table, rcol.column_name AS ref_column
    FROM user_constraints con
    JOIN t ON t.table_name = con.table_name
    JOIN user_cons_columns col ON col.constraint_name = con.constraint_name
    LEFT JOIN user_constraints rcon ON rcon.constraint_name = con.r_constraint_name
    LEFT JOIN user_cons_columns rcol
      ON rcol.constraint_name = con.r_constraint_name AND rcol.position = col.position
   WHERE con.constraint_type IN ('P', 'U', 'R')
),
x AS (
  SELECT ix.table_name, ix.index_name, ix.index_type, ix.uniqueness,
         ic.column_position, ic.column_name, ic.descend
    FROM user_indexes ix
    JOIN t ON t.table_name = ix.table_name
    JOIN user_ind_columns ic ON ic.index_name = ix.index_name
)
SELECT * FROM (
  SELECT 'SUMMARY' rec, CAST(NULL AS VARCHAR2(128)) table_name, 'devboost-schema/1' name,
         TO_NUMBER(NULL) seq, CAST(NULL AS VARCHAR2(128)) column_name, CAST(NULL AS VARCHAR2(30)) kind,
         CAST(NULL AS VARCHAR2(128)) data_type, TO_NUMBER(NULL) char_length, CAST(NULL AS VARCHAR2(1)) char_used,
         TO_NUMBER(NULL) data_length, TO_NUMBER(NULL) data_precision, TO_NUMBER(NULL) data_scale,
         CAST(NULL AS VARCHAR2(1)) nullable, CAST(NULL AS VARCHAR2(9)) uniqueness, CAST(NULL AS VARCHAR2(4)) descend,
         CAST(NULL AS VARCHAR2(128)) ref_table, CAST(NULL AS VARCHAR2(128)) ref_column,
         CAST(NULL AS VARCHAR2(9)) delete_rule, CAST(NULL AS VARCHAR2(8)) status,
         'schema=' || SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
           || ';db=' || SYS_CONTEXT('USERENV', 'DB_NAME')
           || ';at=' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM')
           || ';prefix=' || (SELECT LISTAGG(prefix, ',') WITHIN GROUP (ORDER BY prefix) FROM p)
           || ';TABLE=' || (SELECT COUNT(*) FROM t)
           || ';COLUMN=' || (SELECT COUNT(*) FROM c)
           || ';CONS=' || (SELECT COUNT(*) FROM k)
           || ';INDEX=' || (SELECT COUNT(*) FROM x)
           || ';DEFAULT=' || (SELECT COUNT(*) FROM user_tab_columns d JOIN t ON t.table_name = d.table_name
                               WHERE d.data_default IS NOT NULL) AS comments
    FROM dual
  UNION ALL
  SELECT 'TABLE', table_name, NULL, NULL, NULL, table_type,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         REPLACE(REPLACE(REPLACE(comments, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ')
    FROM t
  UNION ALL
  SELECT 'COLUMN', table_name, column_name, column_id, NULL, NULL,
         data_type, char_length, char_used, data_length, data_precision, data_scale, nullable,
         NULL, NULL, NULL, NULL, NULL, NULL,
         REPLACE(REPLACE(REPLACE(comments, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ')
    FROM c
  UNION ALL
  SELECT 'CONS', table_name, constraint_name, position, column_name, constraint_type,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         ref_table, ref_column, delete_rule, status, NULL
    FROM k
  UNION ALL
  SELECT 'INDEX', table_name, index_name, column_position, column_name, index_type,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, uniqueness, descend,
         NULL, NULL, NULL, NULL, NULL
    FROM x
)
ORDER BY DECODE(rec, 'SUMMARY', 0, 'TABLE', 1, 'COLUMN', 2, 'CONS', 3, 4), table_name, name, seq;
`;
}

export function buildDefaultSql(prefixes: string[]): string {
  const ps = normalizePrefixes(prefixes);
  const title = ps.length ? `접두어 ${ps.join(', ')}` : '전체';
  return `-- DevBoost 스키마 수집 ② 기본값 쿼리 (${title}, ①과 같은 범위)
-- DATA_DEFAULT 가 LONG 타입이라 ①과 합칠 수 없어 따로 받는다. 실행 후 결과 그리드 전체 복사 → [클립보드에서 가져오기]
SELECT 'DEFAULT' AS rec, tc.table_name, tc.column_name AS name, tc.data_default AS comments
  FROM user_tab_columns tc
  JOIN user_tab_comments t ON t.table_name = tc.table_name
 WHERE t.table_type IN ('TABLE', 'VIEW')
   AND t.table_name NOT LIKE 'BIN$%'
   AND EXISTS (SELECT 1
                 FROM (${prefixRows(prefixes, '                       ')}
                      ) p
                WHERE p.prefix IS NULL
                   OR SUBSTR(tc.table_name, 1, LENGTH(p.prefix)) = p.prefix)
   AND tc.data_default IS NOT NULL
 ORDER BY tc.table_name, tc.column_id;
`;
}
