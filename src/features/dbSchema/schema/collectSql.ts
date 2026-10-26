/**
 * Oracle 스키마 수집 SQL 만들기 (vscode 의존 없음). docs/SPEC-db-schema-v8 6장과 같은 SQL.
 *
 * 한 번 실행·한 번 복사로 끝나는 "컬럼 1행" 쿼리:
 *  - 테이블·컬럼 정보 + 기본값(DATA_DEFAULT) + PK 순서 + UK/FK/인덱스(컬럼별로 LISTAGG 로 묶은 글)
 *  - DATA_DEFAULT 는 LONG 타입이라 UNION·함수·WITH 안에 쓸 수 없다. 그래서
 *      · UNION 을 쓰지 않고 (컬럼마다 한 행)
 *      · WITH 대신 FROM 안의 인라인 뷰로 쓰고
 *      · 바깥 조인은 Oracle (+) 문법으로 쓴다 (ANSI 조인은 내부적으로 뷰로 바뀌어 LONG 오류가 나는 버전이 있음)
 *      · DATA_DEFAULT 는 맨 끝 칸 (줄바꿈이 섞여 복사가 쪼개져도 DevBoost 가 이어 붙일 수 있게)
 *  - META 칸: 스키마·수집 시각·접두어·전체 행 수. 그리드가 일부 행만 복사한 경우를 잡는 데 씀
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

/** 접두어 목록 인라인 뷰 (prefix 한 칸). 없으면 NULL 한 줄 = 전체 */
function prefixView(prefixes: string[], indent: string): string {
  const ps = normalizePrefixes(prefixes);
  if (ps.length === 0) return `(SELECT CAST(NULL AS VARCHAR2(128)) AS prefix FROM dual)`;
  return `(${ps.map((p, i) => (i === 0 ? `SELECT ${lit(p)} AS prefix FROM dual` : `\n${indent} UNION ALL SELECT ${lit(p)} FROM dual`)).join('')})`;
}

/** 대상 테이블 조건 (table_name 컬럼에 대해) */
function scopeCond(col: string, prefixes: string[], indent: string): string {
  return `EXISTS (SELECT 1 FROM ${prefixView(prefixes, indent + '                ')} p
${indent}         WHERE p.prefix IS NULL OR SUBSTR(${col}, 1, LENGTH(p.prefix)) = p.prefix)`;
}

const clean = (expr: string) => `REPLACE(REPLACE(REPLACE(${expr}, CHR(13), ' '), CHR(10), ' '), CHR(9), ' ')`;

export function buildCollectSql(prefixes: string[]): string {
  const ps = normalizePrefixes(prefixes);
  const title = ps.length ? `접두어 ${ps.join(', ')}` : '전체';
  return `-- DevBoost 스키마 수집 (${title}) — 실행(Ctrl+Enter) 후 결과 그리드 전체를 헤더와 함께 복사 → DevBoost [클립보드에서 가져오기]
-- 컬럼마다 한 행. 기본값(DATA_DEFAULT, LONG)까지 한 번에 나오도록 UNION·WITH 없이 씀
SELECT tc.table_name,
       t.table_type,
       t.table_comment,
       tc.column_id,
       tc.column_name,
       ${clean('cc.comments')} AS column_comment,
       tc.data_type,
       tc.char_length,
       tc.char_used,
       tc.data_length,
       tc.data_precision,
       tc.data_scale,
       tc.nullable,
       pk.pk_pos,
       pk.pk_name,
       uk.uks,
       fk.fks,
       ix.idxs,
       m.meta,
       tc.data_default
  FROM user_tab_columns tc,
       -- 대상 테이블·뷰 (접두어, 휴지통 제외)
       (SELECT table_name, table_type, ${clean('comments')} AS table_comment
          FROM user_tab_comments
         WHERE table_type IN ('TABLE', 'VIEW')
           AND table_name NOT LIKE 'BIN$%'
           AND ${scopeCond('table_name', prefixes, '          ')}) t,
       user_col_comments cc,
       -- PK: 컬럼별 순서
       (SELECT cc2.table_name, cc2.column_name, cc2.position AS pk_pos, c.constraint_name AS pk_name
          FROM user_constraints c, user_cons_columns cc2
         WHERE c.constraint_type = 'P' AND cc2.constraint_name = c.constraint_name) pk,
       -- UK: 이름(순서), …
       (SELECT cc2.table_name, cc2.column_name,
               LISTAGG(c.constraint_name || '(' || cc2.position || ')', ', ') WITHIN GROUP (ORDER BY c.constraint_name) AS uks
          FROM user_constraints c, user_cons_columns cc2
         WHERE c.constraint_type = 'U' AND cc2.constraint_name = c.constraint_name
         GROUP BY cc2.table_name, cc2.column_name) uk,
       -- FK: 이름(순서)=참조테이블.참조컬럼 [삭제규칙], …
       (SELECT cc2.table_name, cc2.column_name,
               LISTAGG(c.constraint_name || '(' || cc2.position || ')=' || NVL(rc.table_name, '?') || '.' || NVL(rcc.column_name, '?')
                       || CASE WHEN c.delete_rule <> 'NO ACTION' THEN ' ' || c.delete_rule END, ', ')
                 WITHIN GROUP (ORDER BY c.constraint_name) AS fks
          FROM user_constraints c, user_cons_columns cc2, user_constraints rc, user_cons_columns rcc
         WHERE c.constraint_type = 'R' AND cc2.constraint_name = c.constraint_name
           AND rc.owner(+) = c.r_owner AND rc.constraint_name(+) = c.r_constraint_name
           AND rcc.owner(+) = c.r_owner AND rcc.constraint_name(+) = c.r_constraint_name AND rcc.position(+) = cc2.position
         GROUP BY cc2.table_name, cc2.column_name) fk,
       -- 인덱스: 이름(순서[ DESC][ U]), …   (U = 유니크 인덱스)
       (SELECT ic.table_name, ic.column_name,
               LISTAGG(ic.index_name || '(' || ic.column_position || CASE WHEN ic.descend = 'DESC' THEN ' DESC' END
                       || CASE WHEN i.uniqueness = 'UNIQUE' THEN ' U' END || ')', ', ') WITHIN GROUP (ORDER BY ic.index_name) AS idxs
          FROM user_ind_columns ic, user_indexes i
         WHERE i.index_name = ic.index_name
         GROUP BY ic.table_name, ic.column_name) ix,
       -- 수집 정보 + 전체 행 수 (일부만 복사됐는지 확인용, 모든 행에 같은 값)
       (SELECT 'schema=' || USER
               || ';db=' || SYS_CONTEXT('USERENV', 'DB_NAME')
               || ';at=' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM')
               || ';prefix=' || pl.prefixes
               || ';rows=' || n.cnt AS meta
          FROM (SELECT LISTAGG(prefix, ',') WITHIN GROUP (ORDER BY prefix) AS prefixes
                  FROM ${prefixView(prefixes, '                      ')}) pl,
               (SELECT COUNT(*) AS cnt
                  FROM user_tab_columns x, user_tab_comments y
                 WHERE y.table_name = x.table_name
                   AND y.table_type IN ('TABLE', 'VIEW')
                   AND y.table_name NOT LIKE 'BIN$%'
                   AND ${scopeCond('y.table_name', prefixes, '                  ')}) n) m
 WHERE t.table_name = tc.table_name
   AND cc.table_name(+) = tc.table_name AND cc.column_name(+) = tc.column_name
   AND pk.table_name(+) = tc.table_name AND pk.column_name(+) = tc.column_name
   AND uk.table_name(+) = tc.table_name AND uk.column_name(+) = tc.column_name
   AND fk.table_name(+) = tc.table_name AND fk.column_name(+) = tc.column_name
   AND ix.table_name(+) = tc.table_name AND ix.column_name(+) = tc.column_name
 ORDER BY tc.table_name, tc.column_id;
`;
}
