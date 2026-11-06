// 쿼리 아래 결과: 실행한 문장이 끝나는 줄 바로 밑에 결과 표·메시지를 끼워 넣는다 (CodeMirror 블록 위젯).
// 글을 고쳐도 결과는 그 문장을 따라 움직이고, 같은 줄에서 다시 실행하면 새 결과로 바뀐다.
import { EditorView, WidgetType, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { StateField, StateEffect, MapMode, type EditorState, type Range } from '@codemirror/state';
import { createGrid, toTsv, type Cell, type Col, type Grid, type Sort } from './grid';

export interface InlineData {
  key: string;
  status: 'running' | 'rows' | 'done' | 'error' | 'cancel' | 'skip' | 'plan';
  /** 실행계획 표 (DBMS_XPLAN 이 그려 준 줄 그대로) */
  lines?: string[];
  text?: string;
  resultId?: number;
  /** 실행한 문장 (INSERT 복사 때 테이블 이름을 짐작) */
  sql?: string;
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
  sort?: Sort;
}

/** 버튼이 확장에 넘기는 결과 한 벌 (화면에 있는 데이터, 정렬한 순서대로) */
export interface ResultData {
  sql: string;
  columns: Col[];
  rows: Cell[][];
  done: boolean;
}

export interface InlineActions {
  more(resultId: number, all: boolean): void;
  toPanel(resultId: number | undefined, data: ResultData): void;
  copy(text: string): void;
  copyInsert(data: ResultData): void;
  csv(data: ResultData): void;
  /** 한 번에 가져오는 행 수·최대 행 수 (버튼 글에 쓴다) */
  limits(): { pageSize: number; maxRows: number };
}

const data = new Map<string, InlineData>();
/** 결과마다 다시 그릴 때 올리는 번호 (위젯 비교에 쓴다) */
const versions = new Map<string, number>();
/** 그려 둔 표 (행이 붙을 때 표를 새로 만들지 않고 이어 그린다 — 스크롤 자리 유지) */
const grids = new Map<string, { grid: Grid; rows: Cell[][] }>();
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

/** 머리 줄: 상태 글 바로 옆에 버튼들 (왼쪽 정렬 — 넓은 결과에서도 스크롤 없이 보인다) */
function renderHead(view: EditorView, d: InlineData): HTMLElement {
  const head = el('div', 'ir-head');
  const close = () => view.dispatch({ effects: removeEffect.of(d.key) });
  switch (d.status) {
    case 'running':
      head.appendChild(el('span', 'ir-text', '실행 중…'));
      return head;
    case 'rows': {
      const rows = d.rows?.length ?? 0;
      const { pageSize, maxRows } = actions.limits();
      // 다음 행은 DB 커서가 있어야 한다 → 가장 최근 실행 결과만 (앞 결과는 다음 실행 때 커서를 닫는다)
      const more = !d.done && !d.capped && !d.dropped;
      head.appendChild(el('span', 'ir-text', `${fmt(rows)}행${d.done ? '' : ' (더 있음)'}`));
      if (d.ms !== undefined) head.appendChild(el('span', 'ir-muted', secs(d.ms)));
      if (more) {
        const go = (all: boolean) => () => {
          d.loading = true;
          d.failed = undefined;
          refresh(view, d.key);
          actions.more(d.resultId!, all);
        };
        head.appendChild(button(d.loading ? '가져오는 중…' : `다음 ${fmt(pageSize)}행`, '다음 행들을 가져옵니다', go(false), d.loading));
        head.appendChild(button('끝까지', `남은 행을 모두 가져옵니다 (최대 ${fmt(maxRows)}행)`, go(true), d.loading));
      }
      head.appendChild(button('복사', '결과를 복사합니다 (탭 구분 — 엑셀에 붙여 넣기)', () => actions.copy(toTsv(gridData(d), orderOf(d), false))));
      head.appendChild(
        button(d.collapsed ? '펼치기' : '접기', d.collapsed ? '표를 펼칩니다' : '표를 접습니다', () => {
          d.collapsed = !d.collapsed;
          refresh(view, d.key);
        })
      );
      head.appendChild(
        menuButton([
          ['헤더 포함 복사', () => actions.copy(toTsv(gridData(d), orderOf(d), true))],
          ['INSERT 문으로 복사', () => actions.copyInsert(dataOf(d))],
          ['CSV 내보내기', () => actions.csv(dataOf(d))],
          ['패널에서 보기', () => actions.toPanel(d.resultId, dataOf(d))],
        ])
      );
      head.appendChild(button('×', '이 결과를 닫습니다', close));
      if (d.capped) head.appendChild(el('span', 'ir-muted', `최대 ${fmt(maxRows)}행까지 가져왔습니다 (도구 줄의 최대 행 수로 늘릴 수 있습니다)`));
      if (d.failed) head.appendChild(el('span', 'ir-fail', d.failed));
      return head;
    }
    case 'plan':
      head.appendChild(el('span', 'ir-text', '실행계획'));
      if (d.ms !== undefined) head.appendChild(el('span', 'ir-muted', secs(d.ms)));
      head.appendChild(button('복사', '실행계획을 복사합니다', () => actions.copy((d.lines ?? []).join('\n'))));
      head.appendChild(
        button(d.collapsed ? '펼치기' : '접기', d.collapsed ? '펼칩니다' : '접습니다', () => {
          d.collapsed = !d.collapsed;
          refresh(view, d.key);
        })
      );
      head.appendChild(button('×', '닫습니다', close));
      return head;
    default:
      head.appendChild(el('span', 'ir-text', d.text ?? ''));
      if (d.ms !== undefined) head.appendChild(el('span', 'ir-muted', secs(d.ms)));
      head.appendChild(button('×', '이 결과를 닫습니다', close));
      return head;
  }
}

const gridData = (d: InlineData) => ({ columns: d.columns ?? [], rows: d.rows ?? [] });
/** 화면에 보이는 순서(정렬)대로의 결과 한 벌 */
const dataOf = (d: InlineData): ResultData => {
  const rows = d.rows ?? [];
  return { sql: d.sql ?? '', columns: d.columns ?? [], rows: orderOf(d).map((i) => rows[i]), done: !!d.done };
};

/** ⋯ 버튼: 누르면 아래로 메뉴가 펼쳐진다. 고르거나 바깥을 누르면 닫힌다 */
function menuButton(items: [string, () => void][]): HTMLElement {
  const wrap = el('span', 'ir-menu');
  const btn = button('⋯', '더 보기: 헤더 포함 복사 · INSERT 문 · CSV · 패널', () => {
    const open = wrap.classList.toggle('open');
    if (open) setTimeout(() => document.addEventListener('mousedown', closer, true));
  });
  const list = el('div', 'ir-menu-list');
  const closer = (e: Event) => {
    if (wrap.contains(e.target as Node)) return;
    wrap.classList.remove('open');
    document.removeEventListener('mousedown', closer, true);
  };
  for (const [label, run] of items) {
    list.appendChild(
      button(label, label, () => {
        wrap.classList.remove('open');
        document.removeEventListener('mousedown', closer, true);
        run();
      })
    );
  }
  wrap.append(btn, list);
  return wrap;
}
const orderOf = (d: InlineData) => grids.get(d.key)?.grid.order() ?? (d.rows ?? []).map((_, i) => i);

/** 결과 표: 한 번 만들고, 행이 붙거나 정렬이 바뀌면 이어 그린다 */
function gridFor(view: EditorView, d: InlineData): Grid {
  const have = grids.get(d.key);
  if (have && have.rows === d.rows) {
    have.grid.refresh();
    return have.grid;
  }
  const grid = createGrid(gridData(d), {
    sort: () => d.sort,
    onSort: (col) => {
      const s = d.sort;
      d.sort = !s || s.col !== col ? { col, dir: 1 } : s.dir > 0 ? { col, dir: -1 } : undefined;
      grid.refresh();
    },
    onCopy: (text) => actions.copy(text),
  });
  grid.root.classList.add('ir-grid');
  grids.set(d.key, { grid, rows: d.rows! });
  return grid;
}

/**
 * 상자 안을 그린다. 표는 떼었다 붙이지 않는다 — DOM 에서 떼면 스크롤 자리가 사라진다.
 * 머리 줄과 서버 출력만 바꾸고, 표는 그 자리에서 이어 그린다
 */
function fill(view: EditorView, d: InlineData, box: HTMLElement) {
  box.className = `ir ir-${d.status}`;
  const head = renderHead(view, d);
  const old = box.querySelector(':scope > .ir-head');
  if (old) old.replaceWith(head);
  else box.prepend(head);
  const want = d.status === 'rows' && !d.collapsed ? gridFor(view, d).root : undefined;
  for (const g of [...box.querySelectorAll(':scope > .grid')]) if (g !== want) g.remove();
  if (want && want.parentElement !== box) head.after(want);
  box.querySelector(':scope > .ir-output')?.remove();
  box.querySelector(':scope > .ir-plan')?.remove();
  if (d.status === 'plan' && !d.collapsed) box.appendChild(el('pre', 'ir-plan', (d.lines ?? []).join('\n')));
  if (d.output?.length && !d.collapsed) box.appendChild(el('pre', 'ir-output', d.output.join('\n')));
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
    // 바깥 상자는 여백만 (padding). 블록 위젯의 margin 은 편집기가 높이를 잴 때 빠져 줄 번호가 어긋난다
    const wrap = el('div', 'ir-wrap');
    const box = el('div');
    wrap.appendChild(box);
    const d = data.get(this.key);
    if (d) fill(view, d, box);
    return wrap;
  }
  /** 같은 결과의 새 판: 상자를 그대로 두고 안만 바꾼다 (표의 스크롤 자리가 남는다) */
  updateDOM(dom: HTMLElement, view: EditorView) {
    const box = dom.firstElementChild as HTMLElement | null;
    const d = data.get(this.key);
    if (!box || !d) return false;
    fill(view, d, box);
    return true;
  }
  get estimatedHeight() {
    const d = data.get(this.key);
    if (!d || d.status !== 'rows' || d.collapsed) return 34;
    return 34 + 24 + Math.min(d.rows?.length ?? 0, 12) * 22;
  }
  /** 위젯 안의 누름·키는 편집기가 가져가지 않는다 (버튼·표가 받는다) */
  ignoreEvent() {
    return true;
  }
}

const widgetAt = (key: string, pos: number) =>
  Decoration.widget({ widget: new ResultWidget(key, versions.get(key) ?? 0), block: true, side: 1, inlineKey: key }).range(pos);

const forget = (key: string) => {
  data.delete(key);
  grids.delete(key);
  versions.delete(key);
};

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) {
      // 결과는 그 문장이 끝나는 줄 아래에 붙어 있게: 그 자리에 글을 넣으면(끝에 덧붙이기·Enter) 글이 결과 뒤로 가지 않고
      // 결과가 원래 줄 아래에 남는다. 문장이 지워지면 결과도 지운다
      const moved: Range<Decoration>[] = [];
      deco.between(0, tr.startState.doc.length, (from, _to, v) => {
        const p = tr.changes.mapPos(from, -1, MapMode.TrackBefore);
        if (p === null) forget(v.spec.inlineKey);
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
        gone.forEach(forget);
      } else if (e.is(refreshEffect) || e.is(removeEffect)) {
        let at = -1;
        deco.between(0, tr.state.doc.length, (from, _to, v) => {
          if (v.spec.inlineKey === e.value) at = from;
        });
        if (at < 0) continue;
        const keep: Range<Decoration>[] = e.is(refreshEffect) ? [widgetAt(e.value, at)] : [];
        deco = deco.update({ filter: (_f, _t, v) => v.spec.inlineKey !== e.value, add: keep });
        if (e.is(removeEffect)) forget(e.value);
      } else if (e.is(clearEffect)) {
        deco = Decoration.none;
        data.clear();
        grids.clear();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 결과 상자의 폭을 편집기에 보이는 폭으로 묶는다: 긴 SQL 줄 때문에 편집기 글 영역이 넓어져도
 * 결과 상자는 화면 안에 머물고(가로로 스크롤해도 왼쪽에 붙어 있다) 버튼이 보인다
 */
const fitWidth = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.measure();
    }
    update() {
      this.measure();
    }
    measure() {
      this.view.requestMeasure({
        read: (v) => ({ width: v.scrollDOM.clientWidth, gutter: (v.dom.querySelector('.cm-gutters') as HTMLElement | null)?.offsetWidth ?? 0 }),
        write: (m, v) => {
          v.dom.style.setProperty('--ir-max', `${Math.max(240, m.width - m.gutter - 24)}px`);
          v.dom.style.setProperty('--ir-left', `${m.gutter}px`);
        },
      });
    }
  }
);

export function inlineResults(a: InlineActions) {
  actions = a;
  return [field, fitWidth];
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
  grids.delete(key);
  data.set(key, { key, ...result });
  refresh(view, key);
}

/** 다음 행이 더 왔다 (표는 그대로 두고 이어 그린다) */
export function appendRows(view: EditorView, resultId: number, rows: Cell[][], done: boolean, capped: boolean, more: boolean) {
  for (const d of data.values()) {
    if (d.resultId !== resultId) continue;
    d.rows!.push(...rows);
    d.done = done;
    d.capped = capped;
    // "끝까지"로 이어 받는 중이면 아직 가져오는 중
    d.loading = more && !done && !capped;
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

/** 도구 줄에서 행 수를 바꿨다: 버튼 글을 맞춘다 */
export function refreshAll(view: EditorView) {
  for (const key of data.keys()) refresh(view, key);
}

export function clearResults(view: EditorView) {
  view.dispatch({ effects: clearEffect.of(null) });
}
