// 하단 패널 "DB 결과" 화면 → media/dbConsole/results.js
// 확장이 보낸 결과(탭별 표)와 메시지 기록을 그린다. 정렬·칸 복사는 여기서, 이어 받기·CSV 는 확장이 한다.
// 표는 쿼리 아래 결과와 같은 것(grid.ts): 칸 너비를 내용에 맞추고, 보이는 행만 그린다.
import { createGrid, toTsv, type Cell, type Col, type Grid, type Sort } from './grid';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

interface Tab {
  id: number;
  title: string;
  sql: string;
  columns: Col[];
  rows: Cell[][];
  done: boolean;
  ms: number;
  pinned: boolean;
  capped: boolean;
}
interface LogEntry {
  kind: string;
  text: string;
  sql?: string;
  connectionName: string;
  time: string;
}
type Active = number | 'plan' | 'log';

const vscode = acquireVsCodeApi();
const $tabs = document.getElementById('tabs')!;
const $body = document.getElementById('body')!;
const $status = document.getElementById('status')!;

let tabs: Tab[] = [];
let log: LogEntry[] = [];
let plan: { sql: string; lines: string[]; ms: number } | undefined;
let active: Active = 'log';
let pageSize = 500;
let maxRows = 10000;
const sort: Record<number, Sort | undefined> = {};
const loading: Record<number, boolean> = {};
const failed: Record<number, string> = {};
/** 탭마다 만든 표 (탭을 오가도 스크롤 자리가 남게, 행이 붙으면 이어 그린다) */
const grids = new Map<number, Grid>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const fmt = (n: number) => n.toLocaleString('ko-KR');
const current = () => tabs.find((t) => t.id === active);

function linkButton(text: string, onClick: () => void, disabled = false, title?: string) {
  const b = el('button', '', text);
  b.type = 'button';
  b.disabled = disabled;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function gridOf(t: Tab): Grid {
  let g = grids.get(t.id);
  if (!g) {
    const grid = createGrid(t, {
      sort: () => sort[t.id],
      onSort: (col) => {
        const s = sort[t.id];
        sort[t.id] = !s || s.col !== col ? { col, dir: 1 } : s.dir > 0 ? { col, dir: -1 } : undefined;
        grid.refresh();
      },
      onCopy: (text) => vscode.postMessage({ type: 'copy', text }),
      showTypes: true,
    });
    grid.root.classList.add('panel-grid');
    grids.set(t.id, (g = grid));
  }
  return g;
}

function renderTabs() {
  $tabs.textContent = '';
  const add = (id: Active, title: string, tip?: string) => {
    const b = el('button', 'tab' + (id === active ? ' active' : ''), title);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === active));
    if (tip) b.title = tip;
    b.addEventListener('click', () => {
      active = id;
      render();
    });
    $tabs.appendChild(b);
  };
  for (const t of tabs) add(t.id, (t.pinned ? '◆ ' : '') + t.title, t.sql + (t.pinned ? '\n\n(고정됨: 다음 실행 때 지우지 않습니다)' : ''));
  if (plan) add('plan', '실행계획', plan.sql);
  add('log', '메시지');
}

function renderLog() {
  if (!log.length) return el('div', 'empty', '실행한 쿼리의 기록이 여기에 남습니다.');
  const box = el('div', 'log');
  for (const e of [...log].reverse()) {
    const row = el('div', 'entry ' + e.kind);
    row.appendChild(el('span', 'time', e.time));
    row.appendChild(el('span', 'conn', e.connectionName));
    row.appendChild(el('span', 'text', e.text));
    if (e.sql) row.appendChild(el('span', 'sql', e.sql));
    box.appendChild(row);
  }
  return box;
}

/** 아래 줄: 행 수 바로 옆에 버튼들 (왼쪽 정렬) */
function renderStatus() {
  $status.textContent = '';
  const t = current();
  if (active === 'plan' && plan) {
    const p = plan;
    $status.appendChild(el('span', '', `${(p.ms / 1000).toFixed(2)}초`));
    $status.appendChild(linkButton('복사', () => vscode.postMessage({ type: 'copy', text: p.lines.join('\n') })));
    return;
  }
  if (!t) return;
  $status.appendChild(el('span', 'count', `${fmt(t.rows.length)}행${t.done ? '' : ' (더 있음)'}`));
  $status.appendChild(el('span', '', `${(t.ms / 1000).toFixed(2)}초`));
  if (!t.done && !t.capped) {
    const go = (all: boolean) => () => {
      loading[t.id] = true;
      delete failed[t.id];
      renderStatus();
      vscode.postMessage({ type: 'more', id: t.id, all });
    };
    $status.appendChild(linkButton(loading[t.id] ? '가져오는 중…' : `다음 ${fmt(pageSize)}행`, go(false), !!loading[t.id]));
    $status.appendChild(linkButton('끝까지', go(true), !!loading[t.id], `남은 행을 모두 가져옵니다 (최대 ${fmt(maxRows)}행)`));
  }
  const order = () => gridOf(t).order();
  $status.appendChild(linkButton('복사', () => vscode.postMessage({ type: 'copy', text: toTsv(t, order(), false) })));
  $status.appendChild(linkButton('헤더 포함 복사', () => vscode.postMessage({ type: 'copy', text: toTsv(t, order(), true) })));
  $status.appendChild(linkButton('INSERT문으로 복사', () => vscode.postMessage({ type: 'copyInsert', id: t.id, order: order() })));
  $status.appendChild(linkButton('CSV 내보내기', () => vscode.postMessage({ type: 'csv', id: t.id, order: order() })));
  $status.appendChild(
    linkButton(t.pinned ? '고정 해제' : '탭 고정', () => {
      t.pinned = !t.pinned;
      vscode.postMessage({ type: 'pin', id: t.id, pinned: t.pinned });
      render();
    })
  );
  $status.appendChild(linkButton('탭 닫기', () => vscode.postMessage({ type: 'close', id: t.id })));
  if (t.capped) $status.appendChild(el('span', '', `최대 ${fmt(maxRows)}행까지 가져왔습니다 (콘솔 도구 줄의 최대 행 수로 늘릴 수 있습니다)`));
  if (failed[t.id]) $status.appendChild(el('span', 'fail', failed[t.id]));
}

function render() {
  if (active === 'plan' && !plan) active = 'log';
  if (active !== 'log' && active !== 'plan' && !current()) active = tabs.length ? tabs[0].id : 'log';
  renderTabs();
  const t = current();
  // 표는 떼었다 붙이면 스크롤 자리가 사라지므로, 탭의 표는 숨겨 두고 보이는 것만 바꾼다
  for (const [id, g] of grids) g.root.classList.toggle('hidden', id !== active);
  for (const n of [...$body.children]) if (!n.classList.contains('grid')) n.remove();
  if (active === 'plan' && plan) $body.appendChild(el('pre', 'plan', plan.lines.join('\n')));
  else if (t) {
    const g = gridOf(t);
    if (g.root.parentElement !== $body) $body.appendChild(g.root);
    g.refresh();
  } else $body.appendChild(renderLog());
  renderStatus();
}

function dropGrid(id: number) {
  grids.get(id)?.root.remove();
  grids.delete(id);
}

window.addEventListener('message', (event: MessageEvent) => {
  const m = event.data;
  switch (m.type) {
    case 'state':
      for (const id of [...grids.keys()]) dropGrid(id);
      tabs = m.tabs || [];
      log = m.log || [];
      plan = m.plan;
      active = m.active;
      pageSize = m.pageSize || pageSize;
      maxRows = m.maxRows || maxRows;
      render();
      break;
    case 'limits':
      pageSize = m.pageSize;
      maxRows = m.maxRows;
      renderStatus();
      break;
    case 'append': {
      const t = tabs.find((x) => x.id === m.id);
      if (!t) return;
      t.rows.push(...m.rows);
      t.done = m.done;
      t.capped = m.capped;
      loading[m.id] = !!m.more && !m.done && !m.capped; // "끝까지"로 이어 받는 중
      if (active === m.id) {
        grids.get(t.id)?.refresh();
        renderStatus();
      }
      break;
    }
    case 'tabAdded':
      tabs.push(m.tab);
      if (m.activate) active = m.tab.id;
      render();
      break;
    case 'tabsRemoved':
      tabs = tabs.filter((t) => !m.ids.includes(t.id));
      for (const id of m.ids) {
        delete sort[id];
        delete loading[id];
        delete failed[id];
        dropGrid(id);
      }
      render();
      break;
    case 'plan':
      plan = m.plan;
      if (m.activate) active = 'plan';
      render();
      break;
    case 'log':
      log.push(m.entry);
      if (log.length > 300) log.splice(0, log.length - 300);
      if (m.activate) active = 'log';
      // 메시지 탭을 보고 있거나 새로 보여 줄 때만 다시 그린다 (결과 표를 보고 있으면 그대로)
      if (active === 'log') render();
      break;
    case 'activate':
      active = m.active;
      render();
      break;
    case 'moreFailed':
      delete loading[m.id];
      failed[m.id] = m.message;
      if (active === m.id) renderStatus();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
