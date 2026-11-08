// 쿼리 사전 화면: 왼쪽 분류·검색 목록, 오른쪽 항목 설명. 넣기·실행은 확장이 한다.
import type { BookEntry } from '../../src/features/dbConsole/querybook/entry';
import { matches, placeholders } from '../../src/features/dbConsole/querybook/entry';
import { renderMarkdown } from '../../src/features/dbConsole/querybook/markdown';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let entries: BookEntry[] = [];
let kindLabel = '';
let connection = '';
let current: string | undefined = (vscode.getState() as { current?: string } | undefined)?.current;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (text: string, title: string, onClick: () => void, primary = false) => {
  const b = el('button', primary ? 'primary' : '', text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};
const SOURCE: Record<string, string> = { builtin: '', project: '프로젝트', user: '내 사전' };

function drawList() {
  const q = $<HTMLInputElement>('search').value.trim();
  const box = $('items');
  box.textContent = '';
  const shown = entries.filter((e) => !q || matches(e, q));
  if (!shown.length) {
    box.appendChild(el('p', 'muted', q ? '찾는 항목이 없습니다.' : '항목이 없습니다.'));
    return;
  }
  // 분류 순서: 처음 나온 순서 (내장 사전의 순서대로)
  const cats: string[] = [];
  for (const e of shown) if (!cats.includes(e.category)) cats.push(e.category);
  for (const c of cats) {
    const list = shown.filter((e) => e.category === c);
    box.appendChild(el('div', 'cat', `${c} (${list.length})`));
    for (const e of list) {
      const it = el('div', 'item' + (e.id === current ? ' on' : ''));
      it.tabIndex = 0;
      it.appendChild(el('span', 'name', e.title));
      if (e.privilege) it.appendChild(el('span', 'badge dba', 'DBA'));
      if (e.source !== 'builtin') it.appendChild(el('span', 'badge', SOURCE[e.source]));
      it.title = e.title;
      it.dataset.id = e.id;
      it.addEventListener('click', () => select(e.id));
      it.addEventListener('keydown', (k) => {
        if (k.key === 'Enter') select(e.id);
      });
      box.appendChild(it);
    }
  }
  if (!current || !shown.some((e) => e.id === current)) select(shown[0].id, false);
}

function select(id: string, redraw = true) {
  current = id;
  vscode.setState({ current });
  if (redraw) for (const n of document.querySelectorAll<HTMLElement>('.item')) n.classList.toggle('on', n.dataset.id === id);
  drawDoc();
}

function section(doc: HTMLElement, title: string, md: string) {
  if (!md.trim()) return;
  doc.appendChild(el('h3', '', title));
  const body = el('div', 'md');
  body.innerHTML = renderMarkdown(md); // renderMarkdown 은 모든 글을 이스케이프한다
  doc.appendChild(body);
}

function drawDoc() {
  const e = entries.find((x) => x.id === current);
  const doc = $('doc');
  doc.textContent = '';
  if (!e) {
    doc.appendChild(el('p', 'muted', '왼쪽에서 항목을 고르세요.'));
    return;
  }
  const head = el('header');
  head.appendChild(el('h2', '', e.title));
  const chips = el('div', 'chips');
  for (const t of [e.category, ...e.tags]) chips.appendChild(el('span', '', t));
  if (e.source !== 'builtin') chips.appendChild(el('span', 'src', SOURCE[e.source]));
  head.appendChild(chips);
  doc.appendChild(head);
  if (e.privilege) {
    const p = el('div', 'privilege');
    p.append(el('b', '', '필요한 권한 '), document.createTextNode(e.privilege));
    doc.appendChild(p);
  }
  section(doc, '상황', e.situation);
  section(doc, '예제 테이블', e.example);
  section(doc, '원하는 결과', e.result);
  doc.appendChild(el('h3', '', '쿼리'));
  const pre = el('pre', 'code query');
  // 바꿀 자리 ${이름:값} 은 값만, 노란 표시로
  const re = /\$\{([^}:\n]+)(?::([^}\n]*))?\}/g;
  const defaults = new Map(placeholders(e.query).map((p) => [p.name, p.value]));
  let last = 0;
  for (const m of e.query.matchAll(re)) {
    pre.appendChild(document.createTextNode(e.query.slice(last, m.index)));
    const ph = el('span', 'ph', (m[2] ?? '').trim() || defaults.get(m[1].trim()) || m[1].trim());
    ph.title = `바꿀 자리: ${m[1].trim()}`;
    pre.appendChild(ph);
    last = m.index! + m[0].length;
  }
  pre.appendChild(document.createTextNode(e.query.slice(last)));
  doc.appendChild(pre);
  section(doc, '풀이', e.explain);
  const ph = placeholders(e.query);
  if (e.replace.trim() || ph.length) {
    doc.appendChild(el('h3', '', '바꿔 쓸 곳'));
    if (ph.length) {
      const line = el('p', 'phs');
      for (const p of ph) {
        const s = el('span', 'ph', p.value || p.name);
        s.title = p.name;
        line.append(s, document.createTextNode(` ${p.name}  `));
      }
      doc.appendChild(line);
    }
    if (e.replace.trim()) {
      const body = el('div', 'md');
      body.innerHTML = renderMarkdown(e.replace);
      doc.appendChild(body);
    }
  }
  if (e.practice) {
    doc.appendChild(el('h3', '', '연습 실행 쿼리'));
    const details = el('details');
    details.appendChild(el('summary', '', '예제 데이터를 WITH 로 만든 쿼리 보기'));
    details.appendChild(el('pre', 'code', e.practice));
    doc.appendChild(details);
  }

  const bar = el('div', 'actions');
  bar.append(
    button('콘솔에 넣기', `${connection} 콘솔의 커서 자리에 넣습니다 — 노란 자리는 Tab 으로 옮겨 다니며 바꿉니다`, () => vscode.postMessage({ type: 'insert', id: e.id }), true)
  );
  const pr = button('▶ 연습 실행', '예제 데이터로 바로 실행해 결과를 봅니다 (내 테이블이 없어도 됨, 데이터를 바꾸지 않음)', () => vscode.postMessage({ type: 'practice', id: e.id }));
  if (!e.practice) {
    pr.disabled = true;
    pr.title = '이 항목은 연습 실행이 없습니다 (딕셔너리 조회·데이터 변경 등은 내 DB 에서 바로 실행)';
  }
  bar.append(pr, button('쿼리 복사', '쿼리를 복사합니다 (바꿀 자리는 기본값으로)', () => vscode.postMessage({ type: 'copy', id: e.id })));
  bar.append(
    button(e.source === 'builtin' ? '원본 보기' : '고치기', e.source === 'builtin' ? '내장 항목의 .md 파일을 엽니다 (확장을 업데이트하면 원래대로 돌아갑니다 — 내 방식으로 고쳐 두려면 「+ 새 항목」으로)' : '이 항목의 .md 파일을 열어 고칩니다', () =>
      vscode.postMessage({ type: 'edit', id: e.id })
    )
  );
  doc.appendChild(bar);
  doc.scrollTop = 0;
}

$('search').addEventListener('input', drawList);
$('search').addEventListener('keydown', (k) => {
  if (k.key === 'ArrowDown') (document.querySelector('.item') as HTMLElement | null)?.focus();
});
$('add').addEventListener('click', () => vscode.postMessage({ type: 'add' }));

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type !== 'data') return;
  entries = m.entries;
  kindLabel = m.kindLabel;
  connection = m.connection;
  document.title = `쿼리 사전 · ${kindLabel}`;
  if (m.focus) current = m.focus;
  drawList();
  drawDoc();
});
vscode.postMessage({ type: 'ready' });
