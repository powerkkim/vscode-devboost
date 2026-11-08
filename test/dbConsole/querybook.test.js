// 쿼리 사전: 항목 파일 읽기 · 바꿀 자리 · 검색 · 설명 그리기 · 내장 항목 점검
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'dbConsole');
const { parseEntry, placeholders, fillQuery, toSnippet, matches, fitsDb, newEntryText } = require(path.join(OUT, 'querybook', 'entry.js'));
const { renderMarkdown } = require(path.join(OUT, 'querybook', 'markdown.js'));
const { splitStatements, classify } = require(path.join(OUT, 'sql', 'statements.js'));
const { rulesOf } = require(path.join(OUT, 'driver', 'dialects.js'));

const SAMPLE = `---
title: 부서 합계
category: 집계·분석
db: oracle
tags: 분석함수, SUM OVER
---
## 상황
사원 옆에 부서 합계.

## 쿼리
\`\`\`sql
SELECT \${묶는칸:DEPT_NO}, SUM(\${값칸:SAL}) OVER (PARTITION BY \${묶는칸}) AS S
  FROM \${테이블:EMP} WHERE X = #{mybatis}
\`\`\`

## 연습 실행
\`\`\`sql
SELECT 1 FROM DUAL
\`\`\`
`;

test('항목 파일: 머리 정보·섹션·코드 블록', () => {
  const e = parseEntry(SAMPLE, 'project', '/p/a.md');
  assert.equal(e.title, '부서 합계');
  assert.equal(e.category, '집계·분석');
  assert.deepEqual(e.db, ['oracle']);
  assert.deepEqual(e.tags, ['분석함수', 'SUM OVER']);
  assert.equal(e.situation, '사원 옆에 부서 합계.');
  assert.match(e.query, /^SELECT \$\{묶는칸:DEPT_NO\}/);
  assert.equal(e.practice, 'SELECT 1 FROM DUAL');
  assert.equal(e.id, 'project:/p/a.md');
  assert.equal(parseEntry('---\ntitle: x\n---\n## 상황\n쿼리 없음', 'user', '/x.md'), undefined, '쿼리가 없으면 항목이 아니다');
  assert.ok(fitsDb(e, 'oracle') && !fitsDb(e, 'mysql'));
  assert.ok(fitsDb({ ...e, db: [] }, 'mysql'), 'db 를 비우면 모든 DB');
});

test('바꿀 자리: 이름·기본값, 채우기, 스니펫 틀 (같은 이름 같은 번호, 다른 중괄호는 글자로)', () => {
  const q = parseEntry(SAMPLE, 'builtin', 'a').query;
  assert.deepEqual(placeholders(q), [
    { name: '묶는칸', value: 'DEPT_NO' },
    { name: '값칸', value: 'SAL' },
    { name: '테이블', value: 'EMP' },
  ]);
  assert.equal(fillQuery(q, { 테이블: 'TB_EMP' }), 'SELECT DEPT_NO, SUM(SAL) OVER (PARTITION BY DEPT_NO) AS S\n  FROM TB_EMP WHERE X = #{mybatis}');
  assert.equal(toSnippet(q, { 테이블: 'TB_EMP' }), 'SELECT ${1:DEPT_NO}, SUM(${2:SAL}) OVER (PARTITION BY ${1:DEPT_NO}) AS S\n  FROM ${3:TB_EMP} WHERE X = #\\{mybatis\\}');
});

test('검색: 낱말마다 제목·분류·태그·상황 중 어디든 (띄어쓰기 무시)', () => {
  const e = parseEntry(SAMPLE, 'builtin', 'a');
  assert.ok(matches(e, '부서 합계'));
  assert.ok(matches(e, 'sum over'));
  assert.ok(matches(e, '부서합계'));
  assert.ok(!matches(e, '중복'));
});

test('설명 그리기: 표·목록·코드·굵게, HTML 은 글자로', () => {
  const h = renderMarkdown('줄 **굵게** `코드` <script>x</script>\n\n| A | B |\n|---|---:|\n| 1 | 2 |\n\n- 가\n- 나\n\n```sql\nSELECT 1 < 2\n```');
  assert.match(h, /<p>줄 <b>굵게<\/b> <code>코드<\/code> &lt;script&gt;x&lt;\/script&gt;<\/p>/);
  assert.match(h, /<table class="ex"><thead><tr><th>A<\/th><th class="r">B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td class="r">2<\/td><\/tr>/);
  assert.match(h, /<ul><li>가<\/li><li>나<\/li><\/ul>/);
  assert.match(h, /<pre class="code" data-lang="sql">SELECT 1 &lt; 2<\/pre>/);
  assert.ok(!/<script>/.test(h));
});

test('사전에 추가 틀: 다시 읽으면 같은 항목', () => {
  const text = newEntryText({ title: 'BOM 중복', category: '데이터 점검', db: 'oracle', query: 'SELECT 1 FROM DUAL;' });
  const e = parseEntry(text, 'user', '/u.md');
  assert.equal(e.title, 'BOM 중복');
  assert.equal(e.query, 'SELECT 1 FROM DUAL');
});

test('내장 Oracle 사전: 모든 파일이 읽히고, 쿼리·연습 실행은 문장 하나, 연습은 조회만', () => {
  const dir = path.join(__dirname, '..', '..', 'resources', 'querybook', 'oracle');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 10);
  const rules = rulesOf('oracle');
  const titles = new Set();
  for (const f of files) {
    const e = parseEntry(fs.readFileSync(path.join(dir, f), 'utf8'), 'builtin', f);
    assert.ok(e, `${f}: 읽히지 않음`);
    assert.ok(!titles.has(e.title), `${f}: 제목 겹침`);
    titles.add(e.title);
    assert.ok(e.situation && e.example && e.result, `${f}: 상황·예제·결과 필요`);
    assert.deepEqual(e.db, ['oracle'], f);
    const q = fillQuery(e.query);
    assert.equal(splitStatements(q, rules).length, 1, `${f}: 쿼리는 문장 하나`);
    assert.ok(!/\$\{/.test(q), `${f}: 채운 뒤 자리 표시가 남음`);
    // 자리 표시는 처음 나올 때 기본값이 있어야 한다 (넣었을 때 빈칸이 되지 않게)
    for (const p of placeholders(e.query)) assert.ok(p.value, `${f}: ${p.name} 기본값 없음`);
    if (e.practice) {
      const st = splitStatements(e.practice, rules);
      assert.equal(st.length, 1, `${f}: 연습은 문장 하나`);
      assert.equal(classify(st[0].sql, rules).kind, 'query', `${f}: 연습은 조회만`);
    }
  }
});
