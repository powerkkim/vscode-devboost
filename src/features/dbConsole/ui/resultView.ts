import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Cell, Column, RowCursor } from '../driver/types';
import { toCsv } from '../../dbSchema/schema/csv';
import { guessTable, toInsertSql } from '../sql/insertSql';

export const RESULTS_VIEW_ID = 'devBoost.dbConsole.results';
/** 한 탭에 싣는 최대 행 수 (더 많으면 조건을 좁히라고 안내) */
export const MAX_LOADED_ROWS = 5000;

/** 조회 결과 하나 = 탭 하나 */
interface ResultTab {
  id: number;
  title: string;
  /** 실행한 문장 (탭에 마우스를 올리면 보인다) */
  sql: string;
  connectionId: string;
  columns: Column[];
  rows: Cell[][];
  /** 더 가져올 행이 없음 */
  done: boolean;
  ms: number;
  cursor?: RowCursor;
  /** 고정: 다음 실행 때 지우지 않는다 */
  pinned: boolean;
}

export interface LogEntry {
  kind: 'ok' | 'error' | 'info' | 'output';
  /** 한 줄 요약: "1행 변경됨 (0.03초)" */
  text: string;
  /** 실행한 문장의 앞부분 */
  sql?: string;
  connectionName: string;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'more'; id: number }
  | { type: 'csv'; id: number }
  | { type: 'copy'; text: string }
  | { type: 'pin'; id: number; pinned: boolean }
  | { type: 'close'; id: number }
  /** order: 화면에 보이는 순서의 행 번호 (정렬해 둔 대로 복사하려고) */
  | { type: 'copyInsert'; id: number; order: number[] };

/** 이어 받기를 실제로 해 주는 쪽 (접속을 쓰는 일은 콘솔이 맡는다: 실행 중 겹침·끊김 처리) */
export type FetchMore = (connectionId: string, cursor: RowCursor, count: number) => Promise<{ rows: Cell[][]; done: boolean }>;

/** 탭에 행이 더 붙었을 때 (콘솔의 쿼리 아래 결과도 같이 늘린다) */
export interface RowsAppended {
  id: number;
  rows: Cell[][];
  done: boolean;
  capped: boolean;
}

const tabView = (t: ResultTab) => ({
  id: t.id,
  title: t.title,
  sql: t.sql,
  columns: t.columns,
  rows: t.rows,
  done: t.done,
  ms: t.ms,
  pinned: t.pinned,
  capped: !t.done && t.rows.length >= MAX_LOADED_ROWS,
});

/**
 * 하단 패널의 "DB 결과": 조회 결과 표(탭)와 메시지 기록.
 * 결과는 여기서 들고 있다가 화면이 만들어지면 한 번 통째로 보내고, 그 뒤로는 바뀐 것만 보낸다
 * (행이 많은 탭을 메시지 한 줄마다 다시 보내지 않게).
 */
export class ResultView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private tabs: ResultTab[] = [];
  private log: (LogEntry & { time: string })[] = [];
  private nextId = 1;
  /** 마지막 실행계획 (DBMS_XPLAN 이 그려 준 표 등) */
  private plan: { sql: string; lines: string[]; ms: number } | undefined;
  /** 화면에서 고를 탭: 결과 탭 id, 'plan', 'log' */
  private active: number | 'plan' | 'log' = 'log';
  private readonly appended = new vscode.EventEmitter<RowsAppended>();
  private readonly dropped = new vscode.EventEmitter<number[]>();
  /** 탭에 행이 더 붙었을 때 */
  readonly onDidAppend = this.appended.event;
  /** 탭이 지워졌을 때 (이어 받기를 더 할 수 없다) */
  readonly onDidDrop = this.dropped.event;

  fetchMore: FetchMore | undefined;
  pageSize = 500;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose() {
    for (const t of this.tabs) void t.cursor?.close();
    this.appended.dispose();
    this.dropped.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dbConsole')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  /** 패널을 보이게 한다. 커서는 에디터에 둔다 (이어서 쿼리를 칠 수 있게) */
  async reveal() {
    if (this.view) {
      this.view.show(true);
      return;
    }
    // 아직 화면이 없으면 포커스 명령이 만든다 → 만든 뒤 커서를 에디터로 돌려보낸다
    await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  /** 그 결과 탭을 패널에서 보여 준다 (콘솔의 "하단 패널로") */
  async showTab(id: number) {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.active = id;
    await this.reveal();
    this.post({ type: 'activate', active: id });
  }

  hasTab(id: number): boolean {
    return this.tabs.some((t) => t.id === id);
  }

  /** 새 실행을 시작한다: 고정하지 않은 결과 탭을 비우고 열어 둔 커서를 닫는다 (메시지 기록은 남긴다) */
  beginRun() {
    const drop = this.tabs.filter((t) => !t.pinned);
    for (const t of drop) void t.cursor?.close();
    this.tabs = this.tabs.filter((t) => t.pinned);
    if (drop.length) {
      this.dropped.fire(drop.map((t) => t.id));
      this.post({ type: 'tabsRemoved', ids: drop.map((t) => t.id) });
    }
  }

  /** 조회 결과 탭을 더한다. 탭 id 를 돌려준다 */
  addRows(r: { sql: string; connectionId: string; columns: Column[]; rows: Cell[][]; done: boolean; ms: number; cursor?: RowCursor }): number {
    const id = this.nextId++;
    const n = this.tabs.filter((t) => !t.pinned).length + 1;
    const tab: ResultTab = { id, title: `결과 ${n}`, pinned: false, ...r };
    this.tabs.push(tab);
    // 이번 실행의 첫 결과를 보여 준다
    const first = n === 1;
    if (first) this.active = id;
    this.post({ type: 'tabAdded', tab: tabView(tab), activate: first });
    return id;
  }

  /** 실행계획을 보여 준다 (앞의 조회 결과 탭은 그대로 둔다) */
  setPlan(plan: { sql: string; lines: string[]; ms: number }) {
    this.plan = plan;
    this.active = 'plan';
    this.post({ type: 'plan', plan, activate: true });
  }

  addLog(entry: LogEntry) {
    const e = { ...entry, time: new Date().toLocaleTimeString() };
    this.log.push(e);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    const activate = entry.kind === 'error'; // 오류는 바로 보이게
    if (activate) this.active = 'log';
    this.post({ type: 'log', entry: e, activate });
  }

  /** 접속이 끊기거나 닫혔다: 그 접속의 커서는 더 쓸 수 없다 */
  dropConnection(connectionId: string) {
    for (const t of this.tabs) {
      if (t.connectionId === connectionId && t.cursor) {
        void t.cursor.close();
        t.cursor = undefined;
        t.done = true;
        this.post({ type: 'append', id: t.id, rows: [], done: true, capped: false });
        this.appended.fire({ id: t.id, rows: [], done: true, capped: false });
      }
    }
  }

  /** 다음 행을 가져온다 (패널·콘솔 어느 쪽에서 눌러도). 실패하면 이유를 던진다 */
  async more(id: number): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab?.cursor || !this.fetchMore) throw new Error('더 가져올 수 없습니다. 쿼리를 다시 실행하세요.');
    const room = MAX_LOADED_ROWS - tab.rows.length;
    if (room <= 0) return;
    const page = await this.fetchMore(tab.connectionId, tab.cursor, Math.min(this.pageSize, room));
    tab.rows.push(...page.rows);
    tab.done = page.done;
    if (page.done) tab.cursor = undefined;
    const msg: RowsAppended = { id: tab.id, rows: page.rows, done: tab.done, capped: !tab.done && tab.rows.length >= MAX_LOADED_ROWS };
    this.post({ type: 'append', ...msg });
    this.appended.fire(msg);
  }

  /** 탭의 행을 TSV·INSERT 등으로 쓸 때 */
  tab(id: number): { sql: string; columns: Column[]; rows: Cell[][] } | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  async copyAsInsert(id: number, order?: number[]) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    // 테이블 이름은 조회 문장의 FROM 에서 짐작하고, 맞는지 물어본다
    const table = await vscode.window.showInputBox({
      title: 'INSERT문으로 복사',
      prompt: 'INSERT 할 테이블 이름',
      value: guessTable(tab.sql) ?? '',
      validateInput: (v) => (v.trim() ? undefined : '테이블 이름을 넣으세요'),
    });
    if (!table) return;
    const rows = (order ?? tab.rows.map((_, i) => i)).map((i) => tab.rows[i]).filter(Boolean);
    await vscode.env.clipboard.writeText(toInsertSql(table.trim(), tab.columns, rows));
    vscode.window.setStatusBarMessage(`INSERT 문 ${rows.length.toLocaleString('ko-KR')}개를 복사했습니다`, 4000);
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.sendState();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        break;
      case 'copyInsert':
        await this.copyAsInsert(m.id, m.order);
        break;
      case 'pin': {
        const tab = this.tabs.find((t) => t.id === m.id);
        if (tab) tab.pinned = m.pinned;
        break;
      }
      case 'close': {
        const i = this.tabs.findIndex((t) => t.id === m.id);
        if (i < 0) return;
        const [tab] = this.tabs.splice(i, 1);
        void tab.cursor?.close();
        this.dropped.fire([tab.id]);
        this.post({ type: 'tabsRemoved', ids: [tab.id] });
        break;
      }
      case 'more':
        try {
          await this.more(m.id);
        } catch (e) {
          this.post({ type: 'moreFailed', id: m.id, message: String((e as Error)?.message ?? e).split('\n')[0] });
        }
        break;
      case 'csv': {
        const tab = this.tabs.find((t) => t.id === m.id);
        if (!tab) return;
        const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'CSV 내보내기' });
        if (!uri) return;
        // 화면에 가져온 행만 내보낸다 (NULL 은 빈 칸)
        const csv = toCsv([tab.columns.map((c) => c.name), ...tab.rows.map((r) => r.map((v) => v ?? ''))]);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
        const more = tab.done ? '' : ' (화면에 가져온 행까지만)';
        void vscode.window.showInformationMessage(`${tab.rows.length.toLocaleString('ko-KR')}행을 내보냈습니다${more}: ${uri.fsPath}`);
        break;
      }
    }
  }

  private post(msg: unknown) {
    void this.view?.webview.postMessage(msg);
  }

  private sendState() {
    this.post({
      type: 'state',
      active: this.active,
      maxRows: MAX_LOADED_ROWS,
      pageSize: this.pageSize,
      tabs: this.tabs.map(tabView),
      plan: this.plan,
      log: this.log,
    });
  }

  private html(wv: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dbConsole');
    const js = wv.asWebviewUri(vscode.Uri.joinPath(base, 'results.js'));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(base, 'results.css'));
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>DB 결과</title></head>
<body>
<div class="tabs" id="tabs" role="tablist"></div>
<div class="body" id="body"><div class="empty">DB 콘솔에서 Ctrl+Enter 로 쿼리를 실행하면 결과가 여기에 나옵니다.</div></div>
<div class="status" id="status"></div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
