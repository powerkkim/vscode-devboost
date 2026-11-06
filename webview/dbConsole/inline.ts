// 쿼리 아래 결과: 실행한 문장이 끝나는 줄 바로 밑에 결과 표·메시지를 끼워 넣는다 (CodeMirror 블록 위젯).
// 글을 고쳐도 결과는 그 문장을 따라 움직이고, 같은 줄에서 다시 실행하면 새 결과로 바뀐다.
import { EditorView, WidgetType, Decoration, type DecorationSet } from '@codemirror/view';
import { StateField, StateEffect, MapMode, type EditorState, type Range } from '@codemirror/state';

type Cell = string | null;
interface Col {
  name: string;
  type: string;
  numeric: boolean;
}

export interface InlineData {
  key: string;
  status: 'running' | 'rows' | 'done' | 'error' | 'cancel' | 'skip';
  text?: string;
  resultId?: number;
  columns?: Col[];
  rows?: Cell[][];
  done?: boolean;
  capped?: boolean;
  ms?: number;
  output?: string[];
  /** 다음 실행으로 패널의 결과가 지워져 더 가져올 수 없다 */
  dropped?: boolean;
  loading?: boolean;
  failed?: string;
  collapsed?: boolean;
  /** 정렬 (화면에서만) */
  sort?: { col: number; dir: 1 | -1 };
}

/** 쿼리 아래 표에 그리는 최대 행 수 (더 많으면 하단 패널에서) */
const MAX_INLINE_ROWS = 1000;

export interface InlineActions {
  more(resultId: number): void;
  toPanel(resultId: number): void;
  copy(text: string): void;
  copyInsert(resultId: number): void;
}

const data = new Map<string, InlineData>();
/** 결과마다 다시 그릴 때 올리는 번호 (위젯 비교에 쓴다) */
const versions = new Map<string, number>();
let actions: InlineActions;

const addEffect = StateEffect.define<{ key: string; pos: number }>();
const refreshEffect = StateEffect.define<string>();
const removeEffect = StateEffect.define<string>();
const clearEffect = StateEffect.define<null>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (n: number) => n.toLocaleString('ko-KR');
const secs = (ms: number) => `${(ms / 1000).toFixed(2)}초`;

function order(d: InlineData): number[] {
  const rows = d.rows ?? [];
  const idx = rows.map((_, i) => i);
  const s = d.sort;
  if (!s) return idx;
  const numeric = d.columns?.[s.col]?.numeric;
  return idx.sort((a, b) => {
    const x = rows[a][s.col];
    const y = rows[b][s.col];
    if (x === y) return a - b;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = numeric ? Number(x) - Number(y) : x < y ? -1 : 1;
    return (c || a - b) * s.dir;
  });
}

function tsv(d: InlineData, header: boolean): string {
  const lines = header ? [(d.columns ?? []).map((c) => c.name).join('\t')] : [];
  for (const i of order(d)) lines.push((d.rows ?? [])[i].map((v) => (v === null ? '' : v.replace(/[\t\r\n]+/g, ' '))).join('\t'));
  return lines.join('\n');
}

function button(text: string, title: string, onClick: () => void, disabled = false) {
  const b = el('button', 'ir-btn', text);
  b.type = 'button';
  b.title = title;
  b.disabled = disabled;
  // 편집기가 누름을 가져가 커서를 옮기지 않게
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function refresh(view: EditorView, key: string) {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  view.dispatch({ effects: refreshEffect.of(key) });
}

function renderTable(view: EditorView, d: InlineData): HTMLElement {
  const box = el('div', 'ir-table');
  const cols = d.columns ?? [];
  if (!cols.length) {
    box.appendChild(el('div', 'ir-empty', '칸이 없는 결과입니다.'));
    return box;
  }
  const table = el('table');
  const head = el('tr');
  head.appendChild(el('th', 'rownum', '#'));
  cols.forEach((c, i) => {
    const th = el('th', c.numeric ? 'num' : '');
    th.appendChild(document.createTextNode(c.name));
    if (d.sort?.col === i) th.appendChild(el('span', 'ir-sort', d.sort.dir > 0 ? ' ▲' : ' ▼'));
    th.title = `${c.type} · 눌러서 정렬 (가져온 행 안에서)`;
    th.addEventListener('mousedown', (e) => e.preventDefault());
    th.addEventListener('click', () => {
      const s = d.sort;
      d.sort = !s || s.col !== i ? { col: i, dir: 1 } : s.dir > 0 ? { col: i, dir: -1 } : undefined;
      refresh(view, d.key);
    });
    head.appendChild(th);
  });
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el('tbody');
  const frag = document.createDocumentFragment();
  const rows = d.rows ?? [];
  order(d)
    .slice(0, MAX_INLINE_ROWS)
    .forEach((ri, n) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'rownum', String(n + 1)));
      rows[ri].forEach((v, ci) => {
        const td = el('td', (v === null ? 'null' : '') + (cols[ci]?.numeric ? ' num' : ''), v === null ? 'NULL' : v);
        if (v !== null && v.length > 40) td.title = v;
        td.dataset.value = v ?? '';
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
  tbody.appendChild(frag);
  table.appendChild(tbody);
  box.appendChild(table);
  // 칸을 누르면 고르고 Ctrl+C 로 그 값을 복사한다 (편집기의 선택과 섞이지 않게 표 안에서만)
  let picked: HTMLElement | undefined;
  box.tabIndex = -1;
  box.addEventListener('mousedown', (e) => {
    const td = (e.target as HTMLElement).closest('td');
    if (!td || td.classList.contains('rownum')) return;
    e.preventDefault();
    picked?.classList.remove('picked');
    picked = td;
    td.classList.add('picked');
    box.focus({ preventScroll: true });
  });
  box.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && picked) {
      e.preventDefault();
      e.stopPropagation();
      actions.copy(picked.dataset.value ?? '');
    }
  });
  return box;
}

function render(view: EditorView, d: InlineData): HTMLElement {
  // 바깥 상자는 여백만 (padding). 블록 위젯의 margin 은 편집기가 높이를 잴 때 빠져 줄 번호가 어긋난다
  const wrap = el('div', 'ir-wrap');
  const root = el('div', `ir ir-${d.status}`);
  wrap.appendChild(root);
  const head = el('div', 'ir-head');
  const close = () => view.dispatch({ effects: removeEffect.of(d.key) });
  switch (d.status) {
    case 'running':
      head.appendChild(el('span', 'ir-text', '실행 중…'));
      break;
    case 'rows': {
      const rows = d.rows?.length ?? 0;
      const more = !d.done && !d.capped && !d.dropped;
      head.appendChild(el('span', 'ir-text', `${fmt(rows)}행${d.done ? '' : ' (더 있음)'}`));
      if (d.ms !== undefined) head.appendChild(el('span', 'ir-muted', secs(d.ms)));
      if (rows > MAX_INLINE_ROWS) head.appendChild(el('span', 'ir-muted', `여기에는 ${fmt(MAX_INLINE_ROWS)}행까지 · 나머지는 하단 패널`));
      if (d.capped) head.appendChild(el('span', 'ir-muted', '더 많은 행은 조건을 좁혀 다시 실행하세요'));
      if (d.failed) head.appendChild(el('span', 'ir-fail', d.failed));
      head.appendChild(el('span', 'ir-spacer'));
      if (more)
        head.appendChild(
          button(d.loading ? '가져오는 중…' : '더 가져오기', '다음 행들을 가져옵니다', () => {
            d.loading = true;
            d.failed = undefined;
            refresh(view, d.key);
            actions.more(d.resultId!);
          }, d.loading)
        );
      head.appendChild(button('복사', '결과를 복사합니다 (엑셀에 붙여 넣기 좋은 탭 구분)', () => actions.copy(tsv(d, false))));
      head.appendChild(button('헤더 포함', '칸 이름까지 복사합니다', () => actions.copy(tsv(d, true))));
      if (!d.dropped) {
        head.appendChild(button('INSERT', 'INSERT 문으로 복사합니다', () => actions.copyInsert(d.resultId!)));
        head.appendChild(button('패널', '하단 패널 "DB 결과"에서 봅니다', () => actions.toPanel(d.resultId!)));
      }
      head.appendChild(
        button(d.collapsed ? '펼치기' : '접기', d.collapsed ? '표를 펼칩니다' : '표를 접습니다', () => {
          d.collapsed = !d.collapsed;
          refresh(view, d.key);
        })
      );
      break;
    }
    default:
      head.appendChild(el('span', 'ir-text', d.text ?? ''));
      if (d.ms !== undefined) head.appendChild(el('span', 'ir-muted', secs(d.ms)));
      head.appendChild(el('span', 'ir-spacer'));
  }
  if (d.status !== 'running') head.appendChild(button('×', '이 결과를 닫습니다', close));
  root.appendChild(head);
  if (d.status === 'rows' && !d.collapsed) root.appendChild(renderTable(view, d));
  if (d.output?.length && !d.collapsed) root.appendChild(el('pre', 'ir-output', d.output.join('\n')));
  return wrap;
}

class ResultWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly version: number
  ) {
    super();
  }
  eq(other: ResultWidget) {
    return other.key === this.key && other.version === this.version;
  }
  toDOM(view: EditorView) {
    const d = data.get(this.key);
    return d ? render(view, d) : document.createElement('div');
  }
  get estimatedHeight() {
    const d = data.get(this.key);
    if (!d || d.status !== 'rows' || d.collapsed) return 28;
    return 28 + 24 + Math.min(d.rows?.length ?? 0, 12) * 21;
  }
  /** 위젯 안의 누름·키는 편집기가 가져가지 않는다 (버튼·표가 받는다) */
  ignoreEvent() {
    return true;
  }
}

const widgetAt = (key: string, pos: number) =>
  Decoration.widget({ widget: new ResultWidget(key, versions.get(key) ?? 0), block: true, side: 1, inlineKey: key }).range(pos);

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) {
      // 결과는 그 문장이 끝나는 줄 아래에 붙어 있게: 그 자리에 글을 넣으면(끝에 덧붙이기·Enter) 글이 결과 뒤로 가지 않고
      // 결과가 원래 줄 아래에 남는다. 문장이 지워지면 결과도 지운다
      const moved: Range<Decoration>[] = [];
      deco.between(0, tr.startState.doc.length, (from, _to, v) => {
        const p = tr.changes.mapPos(from, -1, MapMode.TrackBefore);
        if (p === null) data.delete(v.spec.inlineKey);
        else moved.push(v.range(tr.state.doc.lineAt(p).to));
      });
      deco = Decoration.set(moved, true);
    }
    for (const e of tr.effects) {
      if (e.is(addEffect)) {
        // 같은 자리(같은 줄 끝)의 앞 결과는 새 것으로 바꾼다
        const gone: string[] = [];
        deco = deco.update({
          filter: (from, _to, v) => {
            if (from !== e.value.pos) return true;
            gone.push(v.spec.inlineKey);
            return false;
          },
          add: [widgetAt(e.value.key, e.value.pos)],
        });
        gone.forEach((k) => data.delete(k));
      } else if (e.is(refreshEffect) || e.is(removeEffect)) {
        let at = -1;
        deco.between(0, tr.state.doc.length, (from, _to, v) => {
          if (v.spec.inlineKey === e.value) at = from;
        });
        if (at < 0) continue;
        const keep: Range<Decoration>[] = e.is(refreshEffect) ? [widgetAt(e.value, at)] : [];
        deco = deco.update({ filter: (_f, _t, v) => v.spec.inlineKey !== e.value, add: keep });
        if (e.is(removeEffect)) data.delete(e.value);
      } else if (e.is(clearEffect)) {
        deco = Decoration.none;
        data.clear();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function inlineResults(a: InlineActions) {
  actions = a;
  return field;
}

/** 문장이 끝나는 줄의 끝 (결과를 붙일 자리) */
export function anchorOf(state: EditorState, stmt: { start: number; end: number }): number {
  return state.doc.lineAt(Math.max(stmt.start, Math.min(stmt.end, state.doc.length) - 1)).to;
}

/** 실행을 시작한 문장 아래에 "실행 중…" 자리를 만든다 */
export function addRunning(view: EditorView, items: { key: string; pos: number }[]) {
  for (const it of items) data.set(it.key, { key: it.key, status: 'running' });
  view.dispatch({ effects: items.map((it) => addEffect.of(it)) });
}

/** 확장이 보낸 결과로 그 자리를 채운다 (자리가 이미 닫혔으면 버린다) */
export function setResult(view: EditorView, key: string, result: Omit<InlineData, 'key'>) {
  if (!data.has(key)) return;
  data.set(key, { key, ...result });
  refresh(view, key);
}

/** 다음 행이 더 왔다 */
export function appendRows(view: EditorView, resultId: number, rows: Cell[][], done: boolean, capped: boolean) {
  for (const d of data.values()) {
    if (d.resultId !== resultId) continue;
    d.rows = [...(d.rows ?? []), ...rows];
    d.done = done;
    d.capped = capped;
    d.loading = false;
    refresh(view, d.key);
  }
}

export function moreFailed(view: EditorView, resultId: number, message: string) {
  for (const d of data.values()) {
    if (d.resultId !== resultId) continue;
    d.loading = false;
    d.failed = message;
    refresh(view, d.key);
  }
}

/** 패널에서 지워진 결과: 더 가져오기·INSERT·패널 버튼을 뺀다 (보이는 행은 그대로) */
export function markDropped(view: EditorView, ids: number[]) {
  for (const d of data.values()) {
    if (d.resultId === undefined || !ids.includes(d.resultId)) continue;
    d.dropped = true;
    d.loading = false;
    refresh(view, d.key);
  }
}

export function clearResults(view: EditorView) {
  view.dispatch({ effects: clearEffect.of(null) });
}
