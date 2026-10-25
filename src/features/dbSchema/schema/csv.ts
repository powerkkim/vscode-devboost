/**
 * 구분자 텍스트 읽기·쓰기 (vscode 의존 없음).
 *  - 읽기: DB 도구 그리드에서 복사한 탭 구분 텍스트, CSV 파일 모두. "로 감싼 칸(쉼표·줄바꿈 포함)도 처리
 *  - 쓰기: Excel 에서 한글이 깨지지 않게 UTF-8 BOM + CRLF
 */

export type Delimiter = '\t' | ',';

/** 첫 몇 줄을 보고 구분자 판단: 탭이 있으면 탭 (그리드 복사), 아니면 쉼표 */
export function detectDelimiter(text: string): Delimiter {
  const head = text.split(/\r?\n/, 5).join('\n');
  return head.includes('\t') ? '\t' : ',';
}

/**
 * 행 단위로 읽는다.
 *  - CSV(쉼표): 칸이 "로 시작하면 다음 "까지 한 칸 ("" 는 " 하나)
 *  - 탭 구분(그리드 복사): 따옴표를 특별 취급하지 않음. DB 도구의 그리드 복사는 칸을 따옴표로 감싸지 않으므로
 *    "고객 구분 처럼 따옴표로 시작하는 코멘트나 "PLM"."ISEQ$$_1".nextval 같은 기본값을 그대로 읽어야 한다
 * 각 행에 원래 줄 텍스트(raw)도 같이 돌려준다: 따옴표 없이 줄바꿈이 섞인 값을 복구할 때 쓴다.
 */
export function parseDelimited(text: string, delim: Delimiter): { cells: string[]; raw: string }[] {
  const src = text.replace(/^﻿/, '');
  const rows: { cells: string[]; raw: string }[] = [];
  let cells: string[] = [];
  let cell = '';
  let i = 0;
  let rowStart = 0;
  let quoted = false;
  let atCellStart = true;
  const endRow = (end: number) => {
    cells.push(cell);
    rows.push({ cells, raw: src.slice(rowStart, end) });
    cells = [];
    cell = '';
    atCellStart = true;
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && atCellStart && delim === ',') {
      quoted = true;
      atCellStart = false;
      i++;
      continue;
    }
    if (c === delim) {
      cells.push(cell);
      cell = '';
      atCellStart = true;
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRow(i);
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      rowStart = i;
      continue;
    }
    cell += c;
    atCellStart = false;
    i++;
  }
  if (cell !== '' || cells.length > 0) endRow(src.length);
  // 끝의 빈 줄 제거
  return rows.filter((r) => r.cells.some((x) => x.trim() !== ''));
}

const needsQuote = /[",\r\n]/;
/** Excel 이 수식으로 읽는 시작 글자 (=, +, -, @). 숫자(-1 등)는 그대로 둔다 */
const FORMULA_START = /^[=+\-@]/;
const NUMBER = /^[+-]?\d+(\.\d+)?$/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // "- 삭제예정", "=> 미사용" 같은 코멘트가 수식(#NAME?)으로 열리지 않게 앞에 공백 하나
  if (FORMULA_START.test(s) && !NUMBER.test(s)) s = ` ${s}`;
  return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 파일 바이트 → 문자열. UTF-8 이 아니면 한국어 Windows 기본(CP949)으로 읽는다 (Excel 에서 다시 저장한 CSV) */
export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'cp949' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'cp949' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
    }
  }
}

/** 행 목록 → Excel 용 CSV (BOM + CRLF) */
export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
