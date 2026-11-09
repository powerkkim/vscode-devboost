// DB 콘솔 왼쪽 MyBatis 파라미터 패널.
// 커서 문장 바로 위 줄이 "-- 네임스페이스.쿼리id" 머리 주석이면 (mapper 에서 온 문장) 확장에 그 쿼리의 파라미터를 물어
// 왼쪽에 한 줄씩 보여 준다. 값을 바꾸면 확장이 mapper 를 다시 풀어(if·choose·foreach) 그 문장의 SQL 과 :이름 값을 돌려준다.
import type { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import type { DialectRules, Statement } from '../../src/features/dbConsole/sql/statements';
import { parseMapperHeader } from '../../src/features/mybatisRunner/mapper/consoleSql';
import { currentTargets } from './assist';

type InputType = 'auto' | 'string' | 'number' | 'date' | 'list' | 'json' | 'null' | 'empty';
interface Input {
  type: InputType;
  value: string;
}
interface Spec {
  path: string;
  group: 'base' | 'cond';
  status?: string;
  on?: boolean;
  input: Input;
}
type Reply =
  | { ok: true; ns: string; id: string; specs: Spec[]; sql: string; params: Record<string, { value: string; type?: string }>; warnings: string[] }
  | { ok: false; ns: string; id: string; why: string };

const TYPES: [InputType, string][] = [
  ['auto', '자동'],
  ['string', '글자'],
  ['number', '숫자'],
  ['date', '날짜'],
  ['list', '목록'],
  ['null', 'null'],
  ['empty', "''"],
];

export interface MapperPanelOptions {
  editor: EditorView;
  rules: () => DialectRules;
  post: (m: unknown) => void;
  /** 다시 푼 SQL 의 :이름 값 → 콘솔 파라미터 */
  setParams: (params: Record<string, { value: string; type?: string }>) => void;
  /** 패널이 보이거나 사라질 때 (위쪽 파라미터 줄을 숨기고 보이게) */
  onActive: (active: boolean) => void;
  /** 값 칸에서 Enter: 실행 */
  run: () => void;
}

/** 커서 문장과 그 위 머리 주석 (선택 영역이 여러 문장이면 없음) */
export function mapperTarget(state: EditorState, rules: DialectRules): { ns: string; id: string; stmt: Statement } | undefined {
  const list = currentTargets(state, rules);
  if (list.length !== 1) return undefined;
  const stmt = list[0];
  const doc = state.doc;
  for (let n = doc.lineAt(stmt.start).number - 1; n >= 1; n--) {
    const t = doc.line(n).text;
    if (!t.trim()) continue;
    const h = parseMapperHeader(t);
    return h && { ...h, stmt };
  }
  return undefined;
}

export function mapperPanel(o: MapperPanelOptions) {
  const $panel = document.getElementById('mapperPanel') as HTMLElement;
  let cur: { ns: string; id: string } | undefined;
  let seq = 0;
  /** 지금 화면에 그려진 파라미터 이름들 (같으면 값 칸을 다시 만들지 않는다 — 입력 중 포커스 유지) */
  let drawn = '';
  let shown = false;
  let folded = false;
  let waiting = false;
  let focusWhenReady = false;
  let runAfterReply = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const key = (x?: { ns: string; id: string }) => (x ? `${x.ns}.${x.id}` : '');

  function setShown(v: boolean) {
    if (shown === v) return;
    shown = v;
    $panel.classList.toggle('hidden', !v);
    o.onActive(v);
  }

  /** 값을 한 번이라도 바꾼 쿼리 (그때부터 SQL 을 다시 푼 것으로 바꾼다) */
  const changedOnce = new Set<string>();

  function ask(set?: { path: string; input: Input }) {
    if (!cur) return;
    if (set) changedOnce.add(key(cur));
    waiting = true;
    o.post({ type: 'mapperPanel', seq: ++seq, ns: cur.ns, id: cur.id, set });
  }

  /** 커서가 옮겨졌을 때: mapper 문장이면 패널을 (다시) 연다 */
  function update() {
    const t = mapperTarget(o.editor.state, o.rules());
    if (key(t) === key(cur)) return;
    for (const x of timers.values()) clearTimeout(x);
    timers.clear();
    cur = t && { ns: t.ns, id: t.id };
    drawn = '';
    focusWhenReady = false;
    runAfterReply = false;
    if (!cur) {
      waiting = false;
      setShown(false);
      return;
    }
    ask();
  }

  function send(path: string, input: Input, now = false) {
    clearTimeout(timers.get(path));
    const go = () => {
      timers.delete(path);
      ask({ path, input });
    };
    if (now) go();
    else timers.set(path, setTimeout(go, 250));
  }

  /** 아직 보내지 않은 값이 있으면 바로 보낸다. 보낸 게 있으면 true */
  function flush(): boolean {
    let any = false;
    for (const [path, t] of [...timers]) {
      clearTimeout(t);
      timers.delete(path);
      const input = $panel.querySelector<HTMLInputElement>(`input[data-path="${CSS.escape(path)}"]`);
      const type = $panel.querySelector<HTMLSelectElement>(`select[data-path="${CSS.escape(path)}"]`);
      if (input) {
        ask({ path, input: { type: (type?.value as InputType) || 'auto', value: input.value } });
        any = true;
      }
    }
    return any;
  }

  /** 접기(«)·펼치기(»). 접으면 왼쪽에 얇은 띠만 남고, 띠를 누르면 다시 펼친다 */
  function setFolded(v: boolean) {
    folded = v;
    $panel.classList.toggle('folded', v);
    const b = $panel.querySelector<HTMLButtonElement>('.m-fold');
    if (b) {
      b.textContent = v ? '»' : '«';
      b.title = v ? '파라미터 패널 펼치기' : '파라미터 패널 접기 (편집기를 넓게)';
      b.setAttribute('aria-label', b.title);
    }
  }

  function head(title: string) {
    const h = document.createElement('div');
    h.className = 'm-head';
    const t = document.createElement('span');
    t.className = 'm-title';
    t.textContent = title;
    t.title = title;
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'm-fold';
    fold.addEventListener('click', (e) => {
      e.stopPropagation();
      setFolded(!folded);
    });
    h.append(t, fold);
    return h;
  }

  function row(s: Spec): HTMLElement {
    const r = document.createElement('div');
    r.className = 'm-row';
    r.dataset.path = s.path;
    const nm = document.createElement('span');
    nm.className = 'm-name';
    nm.textContent = s.path;
    nm.title = s.path;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = s.input.value;
    input.dataset.path = s.path;
    input.placeholder = s.group === 'cond' ? (s.status?.startsWith('foreach') ? '10,20,30' : '비우면 조건 빠짐') : '';
    const type = document.createElement('select');
    type.dataset.path = s.path;
    type.title = '값의 종류 (자동: 모양으로 정함 — 앞자리 0 이 있는 코드는 글자)';
    for (const [v, label] of TYPES) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      type.appendChild(opt);
    }
    type.value = s.input.type;
    const now = () => ({ type: type.value as InputType, value: input.value });
    input.addEventListener('input', () => send(s.path, now()));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // 보내지 않은 값이 있으면 SQL 을 다시 받은 뒤 실행
      if (flush() || waiting) runAfterReply = true;
      else o.run();
    });
    type.addEventListener('change', () => send(s.path, now(), true));
    r.append(nm, input, type);
    if (s.status) {
      const st = document.createElement('span');
      st.className = 'm-status' + (s.on ? ' on' : '');
      st.textContent = s.status;
      r.appendChild(st);
    }
    return r;
  }

  function draw(r: Extract<Reply, { ok: true }>) {
    const names = r.specs.map((s) => `${s.path}:${s.group}`).join('|');
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.path;
    if (names === drawn && $panel.contains(document.activeElement)) {
      // 입력 중: 칸은 그대로 두고 조건 상태만 바꾼다
      for (const s of r.specs) {
        const rowEl = $panel.querySelector<HTMLElement>(`.m-row[data-path="${CSS.escape(s.path)}"]`);
        if (!rowEl) continue;
        let st = rowEl.querySelector<HTMLElement>('.m-status');
        if (s.status) {
          if (!st) {
            st = document.createElement('span');
            rowEl.appendChild(st);
          }
          st.className = 'm-status' + (s.on ? ' on' : '');
          st.textContent = s.status;
        } else st?.remove();
      }
      warn(r.warnings[0]);
      return;
    }
    drawn = names;
    $panel.textContent = '';
    $panel.appendChild(head(`파라미터 · ${r.ns.split('.').pop()}.${r.id}`));
    const strip = document.createElement('div');
    strip.className = 'm-strip';
    strip.textContent = '파라미터';
    strip.title = '파라미터 패널 펼치기';
    strip.addEventListener('click', () => setFolded(false));
    $panel.appendChild(strip);
    const base = r.specs.filter((s) => s.group === 'base');
    const cond = r.specs.filter((s) => s.group === 'cond');
    for (const s of base) $panel.appendChild(row(s));
    if (cond.length) {
      const sec = document.createElement('div');
      sec.className = 'm-sec';
      sec.textContent = '조건 (if · foreach) — 값을 넣으면 그 조건이 SQL 에 붙음';
      $panel.appendChild(sec);
      for (const s of cond) $panel.appendChild(row(s));
    }
    if (!r.specs.length) msg('파라미터가 없는 쿼리입니다');
    const w = document.createElement('div');
    w.className = 'm-msg warn m-warn hidden';
    $panel.appendChild(w);
    warn(r.warnings[0]);
    setFolded(folded);
    if (focused) $panel.querySelector<HTMLInputElement>(`input[data-path="${CSS.escape(focused)}"]`)?.focus();
  }

  function msg(text: string, kind = '') {
    const m = document.createElement('div');
    m.className = 'm-msg' + (kind ? ' ' + kind : '');
    m.textContent = text;
    $panel.appendChild(m);
  }

  function warn(text?: string) {
    const w = $panel.querySelector<HTMLElement>('.m-warn');
    if (!w) return;
    w.textContent = text ?? '';
    w.classList.toggle('hidden', !text);
  }

  /** 다시 푼 SQL 로 커서 문장(머리 주석 아래)을 바꾼다 */
  function applySql(sql: string) {
    const t = mapperTarget(o.editor.state, o.rules());
    if (!t || key(t) !== key(cur)) return;
    const doc = o.editor.state.doc;
    const region = doc.sliceString(t.stmt.start, t.stmt.end);
    const body = region.replace(/\s*;?\s*$/, '');
    if (body === sql) return;
    o.editor.dispatch({ changes: { from: t.stmt.start, to: t.stmt.start + body.length, insert: sql }, userEvent: 'input.mapper' });
  }

  function onReply(m: { seq: number; reply: Reply }) {
    if (m.seq !== seq) return; // 더 새 요청이 있다
    waiting = false;
    const r = m.reply;
    if (!r || key(r) !== key(cur)) return;
    if (!r.ok) {
      // 머리 주석은 mapper 모양인데 찾지 못함 (다른 주석이거나 mapper 가 바뀜) → 패널 없이 일반 SQL 로
      setShown(false);
      return;
    }
    setShown(true);
    // 처음 열 때는 SQL 을 건드리지 않는다 (손으로 고친 SQL 을 덮지 않게). 값을 바꾼 뒤부터 다시 푼 SQL 로 바꾼다
    if (r.sql && changedOnce.has(key(r))) applySql(r.sql);
    o.setParams(r.params);
    draw(r);
    if (focusWhenReady) {
      focusWhenReady = false;
      focusFirst();
    }
    if (runAfterReply) {
      runAfterReply = false;
      o.run();
    }
  }

  /** 실행 전 값 확인: 첫 값 칸으로. 패널이 아직 오지 않았으면 오는 대로 */
  function focusFirst(): boolean {
    const first = $panel.querySelector<HTMLInputElement>('input[data-path]');
    if (first) {
      if (folded) setFolded(false);
      first.focus();
      first.select();
      return true;
    }
    if (cur && waiting) {
      focusWhenReady = true;
      return true;
    }
    return false;
  }

  return {
    update,
    onReply,
    focusFirst,
    /** mapper 문장이 실행 대상이다 (패널이 보이거나 답을 기다리는 중) */
    active: () => !!cur && (shown || waiting),
  };
}
