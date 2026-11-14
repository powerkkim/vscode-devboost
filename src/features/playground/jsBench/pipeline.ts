/**
 * "고르기로 만들기": 고른 단계로 배열 가공 코드를 만든다.
 * 순서는 거르기 → 중복 빼기 → 묶기 · 집계 → 정렬 → 앞에서 N개로 고정이고, 쓰지 않는 단계는 비워 둔다.
 * 같음 · 다름 · 포함 · 시작 · 끝은 글로 비교해 숫자 1 과 글 "1" 을 같게 보고, 큼 · 작음은 숫자로 비교한다.
 * 만든 코드는 입력 데이터(data)를 rows 로 받아 console.table(rows) 로 끝난다.
 */
export const OPS = {
  EQ: '같음',
  NE: '다름',
  CONTAINS: '포함',
  STARTS: '~로 시작',
  ENDS: '~로 끝남',
  GT: '보다 큼',
  GE: '크거나 같음',
  LT: '보다 작음',
  LE: '작거나 같음',
  EMPTY: '비었음',
  NOT_EMPTY: '비지 않음',
} as const;
export type Op = keyof typeof OPS;

export const AGGS = { COUNT: '개수', SUM: '합계', AVG: '평균', MAX: '최대', MIN: '최소' } as const;
export type Agg = keyof typeof AGGS;

/** 고른 단계. 칸 이름이 비었으면 그 단계를 쓰지 않는다. aggregate 가 COUNT 가 아니면 aggColumn 이 있어야 한다. limit 이 0 이하면 자르지 않는다 */
export interface PipelineSpec {
  filterColumn?: string;
  filterOp?: Op;
  filterValue?: string;
  distinctColumn?: string;
  groupColumn?: string;
  aggregate?: Agg;
  aggColumn?: string;
  sortColumn?: string;
  sortDescending?: boolean;
  limit?: number;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const needsValue = (op: Op) => op !== 'EMPTY' && op !== 'NOT_EMPTY';

/** 작은따옴표 JS 글. 역슬래시 · 따옴표 · 줄바꿈 · 줄 구분 문자(U+2028 · U+2029)를 이스케이프한다 */
export function quote(text: string): string {
  const esc: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  return "'" + text.replace(/[\\'\n\r\t\u2028\u2029]/g, (c) => esc[c]) + "'";
}

export const field = (row: string, column: string) => (IDENTIFIER.test(column) ? `${row}.${column}` : `${row}[${quote(column)}]`);
const key = (column: string) => (IDENTIFIER.test(column) ? column : quote(column));

/** 숫자로 읽히면 그 글 그대로(쉼표는 뗀다), 아니면 Number('…') 로 감싸 실행 때 NaN 이 되게 한다 */
function number(value: string): string {
  const plain = value.trim().replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(plain) ? plain : `Number(${quote(value)})`;
}

function condition(column: string, op: Op, value: string): string {
  const f = field('r', column);
  const text = `String(${f} ?? '')`;
  switch (op) {
    case 'EQ': return `${text} === ${quote(value)}`;
    case 'NE': return `${text} !== ${quote(value)}`;
    case 'CONTAINS': return `${text}.includes(${quote(value)})`;
    case 'STARTS': return `${text}.startsWith(${quote(value)})`;
    case 'ENDS': return `${text}.endsWith(${quote(value)})`;
    case 'GT': return `Number(${f}) > ${number(value)}`;
    case 'GE': return `Number(${f}) >= ${number(value)}`;
    case 'LT': return `Number(${f}) < ${number(value)}`;
    case 'LE': return `Number(${f}) <= ${number(value)}`;
    case 'EMPTY': return `${f} == null || ${f} === ''`;
    case 'NOT_EMPTY': return `${f} != null && ${f} !== ''`;
  }
}

/** 집계 결과 칸 이름. 개수는 칸과 상관없이 COUNT */
const aggName = (agg: Agg, of?: string) => (agg === 'COUNT' ? 'COUNT' : `${agg}_${of}`);

function group(s: PipelineSpec, agg: Agg): string {
  const result = aggName(agg, s.aggColumn);
  const value = agg === 'COUNT' ? '' : `Number(${field('r', s.aggColumn!)} ?? 0)`;
  // 펼침(...)은 줄이 수십만이면 호출 스택을 넘으므로 reduce 로 센다. 빈 목록은 null
  const reduce = {
    COUNT: 'list.length',
    SUM: `list.reduce((sum, r) => sum + ${value}, 0)`,
    AVG: `list.length ? list.reduce((sum, r) => sum + ${value}, 0) / list.length : 0`,
    MAX: `list.length ? list.reduce((max, r) => Math.max(max, ${value}), -Infinity) : null`,
    MIN: `list.length ? list.reduce((min, r) => Math.min(min, ${value}), Infinity) : null`,
  }[agg];
  const of = agg === 'COUNT' ? '' : s.aggColumn;
  if (!s.groupColumn) {
    return `\n// 전체 ${AGGS[agg]}${of ? ': ' + of : ''}\nconst list = rows;\nrows = [{ ${key(result)}: ${reduce} }];\n`;
  }
  return (
    `\n// 묶기: ${s.groupColumn} 가 같은 줄끼리 ${AGGS[agg]}${of ? `(${of})` : ''}\n` +
    'const groups = new Map();\n' +
    'for (const r of rows) {\n' +
    `  const key = ${field('r', s.groupColumn)};\n` +
    '  if (!groups.has(key)) groups.set(key, []);\n' +
    '  groups.get(key).push(r);\n' +
    '}\n' +
    `rows = [...groups].map(([key, list]) => ({ ${key(s.groupColumn)}: key, ${key(result)}: ${reduce} }));\n`
  );
}

export function generatePipeline(s: PipelineSpec): string {
  let out = 'let rows = Array.isArray(data) ? data : [];\n';
  if (s.filterColumn && s.filterOp) {
    const v = s.filterValue ?? '';
    out += `\n// 거르기: ${s.filterColumn} ${OPS[s.filterOp]}${needsValue(s.filterOp) ? ' ' + quote(v) : ''}\n`;
    out += `rows = rows.filter(r => ${condition(s.filterColumn, s.filterOp, v)});\n`;
  }
  if (s.distinctColumn) {
    const f = field('r', s.distinctColumn);
    out += `\n// 중복 빼기: ${s.distinctColumn} 가 같은 줄은 처음 것만 남긴다\n`;
    out += 'const seen = new Set();\n';
    out += `rows = rows.filter(r => !seen.has(${f}) && seen.add(${f}));\n`;
  }
  if (s.aggregate && (s.aggregate === 'COUNT' || s.aggColumn)) out += group(s, s.aggregate);
  if (s.sortColumn) {
    const a = field('a', s.sortColumn);
    const b = field('b', s.sortColumn);
    out += `\n// 정렬: ${s.sortColumn}${s.sortDescending ? ' 큰 것부터' : ' 작은 것부터'} (숫자는 숫자로, 글은 가나다 · 숫자 순으로)\n`;
    out += "const compare = (x, y) => typeof x === 'number' && typeof y === 'number'\n  ? x - y\n  : String(x ?? '').localeCompare(String(y ?? ''), 'ko', { numeric: true });\n";
    out += `rows = [...rows].sort((a, b) => ${s.sortDescending ? `compare(${b}, ${a})` : `compare(${a}, ${b})`});\n`;
  }
  if (s.limit && s.limit > 0) {
    out += `\n// 앞에서 ${s.limit}개만\nrows = rows.slice(0, ${s.limit});\n`;
  }
  return out + '\nconsole.table(rows);\n';
}
