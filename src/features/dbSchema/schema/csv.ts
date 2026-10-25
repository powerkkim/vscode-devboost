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
 * 행 단위로 읽는다. 칸이 "로 시작하면 다음 "까지 한 칸 ("" 는 " 하나).
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
    if (c === '"' && atCellStart) {
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

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 행 목록 → Excel 용 CSV (BOM + CRLF) */
export function toCsv(rows: unknown[][]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
