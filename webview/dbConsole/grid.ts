// 결과 표 (쿼리 아래·하단 패널이 함께 쓴다).
//  - 칸 너비를 내용에 맞춘다: 머리글과 앞쪽 행들의 글자 수로 정하고(한글은 두 칸), 표가 화면 전체로 늘어나지 않는다
//  - 보이는 행만 그린다: 수만 행이어도 DOM 은 화면에 보이는 만큼 (스크롤하면 바꿔 그린다)
//  - 칸을 누르면 고르고 Ctrl+C 로 그 값을 복사, 머리글을 누르면 정렬

export type Cell = string | null;
export interface Col {
  name: string;
  type: string;
  numeric: boolean;
}
export interface GridData {
  columns: Col[];
  rows: Cell[][];
}
/** 칸마다 어느 테이블에서 왔는지 (여러 테이블 JOIN 결과를 테이블별 색으로) */
export interface ColumnGroups {
  /** 칸마다 테이블 번호 (모르면 undefined) */
  groups: (number | undefined)[];
  /** 테이블 번호 → 이름 (머리글 도움말) */
  labels: string[];
}
/** 테이블 색 가짓수 (넘으면 돌려 쓴다) */
const GROUP_COLORS = 6;
export interface Sort {
  col: number;
  dir: 1 | -1;
}

export interface GridOptions {
  /** 지금 정렬 (주인이 들고 있다) */
  sort(): Sort | undefined;
  /** 머리글을 눌렀다: 오름 → 내림 → 원래 순서 */
  onSort(col: number): void;
  onCopy(text: string): void;
  /** 머리글에 타입을 보일지 */
  showTypes?: boolean;
}

export interface Grid {
  /** 스크롤되는 상자 (높이는 쓰는 쪽이 CSS 로 정한다) */
  root: HTMLElement;
  /** 행이 붙었거나 정렬이 바뀌었다 */
  refresh(): void;
  /** 화면 순서의 원래 행 번호 */
  order(): number[];
  /** 칸별 테이블 색을 바꾼다 (칸 정보를 나중에 받았을 때) */
  setGroups(g: ColumnGroups | undefined): void;
}

/** 칸 너비를 셀 때 볼 앞쪽 행 수 (전부 보면 큰 결과에서 느리다) */
const SAMPLE_ROWS = 300;
/** 칸 너비 한도 (글자 수) */
const MIN_CH = 4;
const MAX_CH = 60;
/** 화면 밖에 미리 그려 둘 행 수 (빠르게 스크롤할 때 빈칸이 보이지 않게) */
const OVERSCAN = 30;

/** 글자 폭: 한글·한자·전각은 두 칸 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

export function sortedOrder(d: GridData, s: Sort | undefined): number[] {
  const idx = d.rows.map((_, i) => i);
  if (!s) return idx;
  const numeric = d.columns[s.col]?.numeric;
  return idx.sort((a, b) => {
    const x = d.rows[a][s.col];
    const y = d.rows[b][s.col];
    if (x === y) return a - b;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = numeric ? Number(x) - Number(y) : x < y ? -1 : 1;
    return (c || a - b) * s.dir;
  });
}

/** 탭 구분 글 (엑셀에 붙여 넣기 좋게). NULL 은 빈 칸 */
export function toTsv(d: GridData, order: number[], header: boolean): string {
  const lines = header ? [d.columns.map((c) => c.name).join('\t')] : [];
  for (const i of order) lines.push(d.rows[i].map((v) => (v === null ? '' : v.replace(/[\t\r\n]+/g, ' '))).join('\t'));
  return lines.join('\n');
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function createGrid(d: GridData, opts: GridOptions, initialGroups?: ColumnGroups): Grid {
  const root = el('div', 'grid');
  root.tabIndex = -1;
  if (!d.columns.length) {
    root.appendChild(el('div', 'grid-empty', '칸이 없는 결과입니다.'));
    return { root, refresh() {}, order: () => [], setGroups() {} };
  }

  // ── 칸 너비 (한 번 정한다: 스크롤하며 바뀌지 않게) ──
  const chars = d.columns.map((c) => Math.max(width(c.name) + (opts.showTypes ? width(c.type) + 1 : 0) + 2, MIN_CH));
  const sample = d.rows.slice(0, SAMPLE_ROWS);
  for (const r of sample) r.forEach((v, i) => (chars[i] = Math.max(chars[i], Math.min(MAX_CH, width(v ?? 'NULL')))));
  const rownumCh = Math.max(3, String(d.rows.length).length + 1);
  const table = el('table');
  const colgroup = el('colgroup');
  const addCol = (ch: number) => {
    const c = el('col');
    c.style.width = `calc(${ch}ch + 18px)`;
    colgroup.appendChild(c);
  };
  addCol(rownumCh);
  chars.forEach(addCol);
  table.appendChild(colgroup);

  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  root.appendChild(table);

  let order = sortedOrder(d, opts.sort());
  /** 칸마다 붙일 class (테이블 색·테이블이 바뀌는 경계) */
  let colClass: string[] = [];
  let groups: ColumnGroups | undefined;
  const applyGroups = (g: ColumnGroups | undefined) => {
    groups = g;
    colClass = d.columns.map((_, i) => {
      const n = g?.groups[i];
      const prev = i > 0 ? g?.groups[i - 1] : undefined;
      const edge = g && i > 0 && n !== prev ? ' tgb' : '';
      return (n === undefined ? '' : ` tg tg${n % GROUP_COLORS}`) + edge;
    });
  };
  applyGroups(initialGroups);
  /** 고른 칸: 원래 행 번호와 칸 번호 (다시 그려도 남게) */
  let picked: { row: number; col: number } | undefined;
  let rowHeight = 0;
  let drawn = { from: -1, to: -1, n: -1 };

  const drawHead = () => {
    const tr = el('tr');
    tr.appendChild(el('th', 'rownum', '#'));
    const s = opts.sort();
    d.columns.forEach((c, i) => {
      const th = el('th', (c.numeric ? 'num' : '') + (colClass[i] ?? ''));
      th.appendChild(document.createTextNode(c.name));
      if (opts.showTypes && c.type) th.appendChild(el('span', 'type', c.type));
      if (s?.col === i) th.appendChild(el('span', 'sort', s.dir > 0 ? ' ▲' : ' ▼'));
      const g = groups?.groups[i];
      th.title = `${g !== undefined ? groups!.labels[g] + ' · ' : ''}${c.name} · ${c.type} · 눌러서 정렬 (가져온 행 안에서)`;
      th.addEventListener('mousedown', (e) => e.preventDefault());
      th.addEventListener('click', () => opts.onSort(i));
      tr.appendChild(th);
    });
    thead.textContent = '';
    thead.appendChild(tr);
  };

  const spacer = (h: number) => {
    const tr = el('tr', 'grid-spacer');
    const td = el('td');
    td.colSpan = d.columns.length + 1;
    td.style.height = `${h}px`;
    tr.appendChild(td);
    return tr;
  };

  const drawRows = (force = false) => {
    const n = order.length;
    const rh = rowHeight || 22;
    const view = root.clientHeight || 300;
    const from = Math.max(0, Math.floor(root.scrollTop / rh) - OVERSCAN);
    const to = Math.min(n, Math.ceil((root.scrollTop + view) / rh) + OVERSCAN);
    if (!force && from === drawn.from && to === drawn.to && n === drawn.n) return;
    drawn = { from, to, n };
    const frag = document.createDocumentFragment();
    if (from > 0) frag.appendChild(spacer(from * rh));
    for (let k = from; k < to; k++) {
      const ri = order[k];
      const tr = el('tr');
      tr.appendChild(el('td', 'rownum', String(k + 1)));
      d.rows[ri].forEach((v, ci) => {
        const td = el('td', (v === null ? 'null' : '') + (d.columns[ci]?.numeric ? ' num' : '') + (colClass[ci] ?? ''), v === null ? 'NULL' : v);
        if (v !== null && width(v) > MAX_CH) td.title = v.length > 2000 ? v.slice(0, 2000) + '…' : v;
        td.dataset.r = String(ri);
        td.dataset.c = String(ci);
        if (picked && picked.row === ri && picked.col === ci) td.classList.add('picked');
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    }
    if (to < n) frag.appendChild(spacer((n - to) * rh));
    tbody.textContent = '';
    tbody.appendChild(frag);
    // 처음 그릴 때 실제 행 높이를 재고 다시 맞춘다
    if (!rowHeight) {
      const first = tbody.querySelector('tr:not(.grid-spacer)') as HTMLElement | null;
      if (first && first.offsetHeight) {
        rowHeight = first.offsetHeight;
        drawRows(true);
      }
    }
  };

  let frame = 0;
  root.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawRows();
    });
  });
  root.addEventListener('mousedown', (e) => {
    const td = (e.target as HTMLElement).closest('td') as HTMLElement | null;
    if (!td || td.dataset.r === undefined) return;
    e.preventDefault();
    root.querySelector('td.picked')?.classList.remove('picked');
    picked = { row: Number(td.dataset.r), col: Number(td.dataset.c) };
    td.classList.add('picked');
    root.focus({ preventScroll: true });
  });
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && picked) {
      e.preventDefault();
      e.stopPropagation();
      const v = d.rows[picked.row]?.[picked.col];
      opts.onCopy(v ?? '');
    }
  });

  drawHead();
  // 화면에 붙은 뒤에야 높이를 알 수 있다
  requestAnimationFrame(() => drawRows(true));
  drawRows(true);

  return {
    root,
    refresh() {
      order = sortedOrder(d, opts.sort());
      drawHead();
      drawRows(true);
    },
    order: () => order,
    setGroups(g) {
      applyGroups(g);
      drawHead();
      drawRows(true);
    },
  };
}
