/**
 * 작은 .xlsx 작성기 (vscode 의존 없음, 외부 라이브러리 없음).
 * 테이블 정의서처럼 "시트 여러 개 + 표 모양 + 시트 사이 링크" 정도만 필요해서 직접 만든다.
 *  - 글자는 inlineStr (sharedStrings 없이), 숫자는 숫자 칸
 *  - 스타일: 제목 / 머리글(굵게·회색 바탕·테두리) / 본문(테두리) / 라벨(굵게·옅은 바탕·테두리) / 링크
 *  - 같은 파일 안의 다른 시트로 가는 링크 (목차 → 테이블 시트)
 *  - 인쇄: A4 가로, 너비를 한 장에 맞춤
 *  - zip 은 Node 의 zlib(deflate)으로 직접 묶음
 */
import { deflateRawSync } from 'zlib';

export type CellStyle = 'plain' | 'title' | 'header' | 'body' | 'label' | 'link' | 'muted';

export interface XCell {
  v: string | number | null | undefined;
  s?: CellStyle;
  /** 같은 파일의 시트로 가는 링크 (시트 이름) */
  sheetLink?: string;
}

export interface XSheet {
  name: string;
  rows: XCell[][];
  /** 열 너비 (글자 수 기준). 없으면 내용으로 계산 */
  widths?: number[];
  /** 머리글 행(0부터)에 자동 필터 */
  autoFilterRow?: number;
  /** 이 행(0부터)까지 위를 고정 */
  freezeRows?: number;
}

const STYLE_ID: Record<CellStyle, number> = { plain: 0, title: 1, header: 2, body: 3, label: 4, link: 5, muted: 6 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
<font><b/><sz val="14"/><name val="맑은 고딕"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
<font><u/><sz val="10"/><color rgb="FF0563C1"/><name val="맑은 고딕"/><family val="2"/></font>
<font><sz val="9"/><color rgb="FF808080"/><name val="맑은 고딕"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** XML 에 쓸 수 없는 제어 문자 제거 + 이스케이프 */
export function xmlText(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA */
export function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 시트 이름 규칙: 31자 이하, [ ] : * ? / \ 금지, 따옴표로 시작·끝 금지, 중복 금지(대소문자 무시) */
export function safeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    let base = raw.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toUpperCase()); n++) {
      const tail = `_${n}`;
      name = base.slice(0, 31 - tail.length) + tail;
    }
    used.add(name.toUpperCase());
    return name;
  });
}

/** 화면 폭: 한글 등 넓은 글자는 2칸 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function sheetXml(sheet: XSheet): string {
  const out: string[] = [];
  const links: string[] = [];
  const widths: number[] = sheet.widths ? [...sheet.widths] : [];
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((cell, c) => {
      if (!sheet.widths && cell.v !== null && cell.v !== undefined && cell.s !== 'title') {
        const longest = String(cell.v)
          .split('\n')
          .reduce((m, line) => Math.max(m, textWidth(line)), 0);
        widths[c] = Math.max(widths[c] ?? 4, Math.min(60, longest + 2));
      }
      const ref = `${colName(c)}${r + 1}`;
      const style = STYLE_ID[cell.s ?? 'plain'];
      const v = cell.v;
      if (v === null || v === undefined || v === '') {
        if (style) cells.push(`<c r="${ref}" s="${style}"/>`);
        return;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        cells.push(`<c r="${ref}" s="${style}"><v>${v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(String(v))}</t></is></c>`);
      }
      if (cell.sheetLink) {
        const loc = `'${cell.sheetLink.replace(/'/g, "''")}'!A1`;
        links.push(`<hyperlink ref="${ref}" location="${xmlText(loc)}" display="${xmlText(String(v))}"/>`);
      }
    });
    out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${(w ?? 8).toFixed(1)}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const freeze =
    sheet.freezeRows && sheet.freezeRows > 0
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const filterRow = sheet.autoFilterRow;
  const lastCol = Math.max(1, ...sheet.rows.map((r) => r.length));
  const filter =
    filterRow !== undefined && sheet.rows.length > filterRow + 1
      ? `<autoFilter ref="A${filterRow + 1}:${colName(lastCol - 1)}${sheet.rows.length}"/>`
      : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${freeze}<sheetFormatPr defaultRowHeight="16.5"/>${cols}<sheetData>${out.join('')}</sheetData>${filter}${links.length ? `<hyperlinks>${links.join('')}</hyperlinks>` : ''}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

export function buildXlsx(sheets: XSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('시트가 없습니다');
  const files: [string, string][] = [];
  files.push([
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
  ]);
  files.push([
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  ]);
  files.push([
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets
      .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  ]);
  files.push([
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  ]);
  files.push(['xl/styles.xml', STYLES_XML]);
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]));
  return zip(files.map(([n, t]) => [n, Buffer.from(t, 'utf8')]));
}

// ───────────────────────── zip (deflate)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries: [string, Buffer][]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 고정 날짜 (1980-01-01): 같은 내용이면 같은 파일
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 이름
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, end]));
}
