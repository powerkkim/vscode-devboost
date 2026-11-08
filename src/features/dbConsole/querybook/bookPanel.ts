import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { BookEntry } from './entry';
import { fillQuery, matches, newEntryText } from './entry';
import { QueryBookStore } from './store';

/** 사전이 콘솔에 넣을 때 쓰는 것 (콘솔이 구현) */
export interface BookTarget {
  /** 사전을 쓸 연결 (DB 종류·이름) */
  connectionId: string;
  kind: string;
  name: string;
}

export interface BookDeps {
  store: QueryBookStore;
  /** 바꿀 자리가 있는 쿼리를 콘솔 커서 자리에 (Tab 으로 옮겨 다니며 바꿈). values 는 미리 채울 값 */
  insert(target: BookTarget, query: string, values: Record<string, string>, title: string): void;
  /** 연습 쿼리를 콘솔 끝에 넣고 실행 */
  practice(target: BookTarget, sql: string, title: string): void;
}

const KIND_LABEL: Record<string, string> = { oracle: 'Oracle', postgres: 'PostgreSQL', mysql: 'MySQL' };

/**
 * 쿼리 사전 화면 (콘솔 옆에 하나). 왼쪽 분류·검색, 오른쪽 설명.
 * 화면은 그리기만 하고, 넣기·실행·파일 열기는 여기서 한다
 */
export class QueryBookPanel {
  private panel: vscode.WebviewPanel | undefined;
  private target: BookTarget | undefined;
  private entries: BookEntry[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: BookDeps
  ) {}

  async open(target: BookTarget, focus?: string) {
    this.target = target;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('devBoostQueryBook', '쿼리 사전', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      });
      this.panel.iconPath = new vscode.ThemeIcon('book');
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.watcher?.dispose();
        this.watcher = undefined;
      });
      this.watch();
    } else {
      this.panel.reveal(undefined, true);
    }
    this.panel.title = `쿼리 사전 · ${KIND_LABEL[target.kind] ?? target.kind}`;
    await this.reload(focus);
  }

  /** 프로젝트 사전 파일이 바뀌면 다시 읽는다 (화면이 열려 있는 동안만) */
  private watch() {
    // 내 사전·프로젝트 사전 파일을 편집기에서 저장하면 다시 읽는다
    const saved = vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.fsPath.endsWith('.md') && (d.uri.fsPath.startsWith(this.deps.store.userDir().fsPath) || d.uri.fsPath.includes('querybook'))) void this.reload();
    });
    this.panel?.onDidDispose(() => saved.dispose());
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, '.devboost/querybook/**/*.md'));
    const later = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.reload(), 300);
    };
    this.watcher.onDidChange(later);
    this.watcher.onDidCreate(later);
    this.watcher.onDidDelete(later);
  }

  async reload(focus?: string) {
    if (!this.panel || !this.target) return;
    this.entries = await this.deps.store.load(this.target.kind);
    void this.panel.webview.postMessage({
      type: 'data',
      kind: this.target.kind,
      kindLabel: KIND_LABEL[this.target.kind] ?? this.target.kind,
      connection: this.target.name,
      entries: this.entries,
      focus,
    });
  }

  private find(id: string) {
    return this.entries.find((e) => e.id === id);
  }

  private async onMessage(m: { type: string; id?: string }) {
    const e = m.id ? this.find(m.id) : undefined;
    const t = this.target;
    switch (m.type) {
      case 'ready':
        await this.reload();
        return;
      case 'insert':
        if (e && t) this.deps.insert(t, e.query, {}, e.title);
        return;
      case 'practice':
        if (e?.practice && t) this.deps.practice(t, e.practice, e.title);
        return;
      case 'copy':
        if (e) {
          await vscode.env.clipboard.writeText(fillQuery(e.query));
          void vscode.window.setStatusBarMessage('쿼리를 복사했습니다', 2000);
        }
        return;
      case 'edit':
        if (e) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(e.path));
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
        }
        return;
      case 'add':
        if (t) await addEntry(this.deps.store, t, '', this);
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'queryBook', f));
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('book.css')}">
<title>쿼리 사전</title></head>
<body>
<div class="layout">
  <aside class="list">
    <input id="search" type="search" placeholder="찾기 — 예: 부서 합계, 중복, 유일" autocomplete="off">
    <div id="items"></div>
    <div class="list-foot"><button type="button" id="add" title="새 항목을 만들어 프로젝트 사전 또는 내 사전에 저장">+ 새 항목</button></div>
  </aside>
  <main id="doc"><p class="muted">왼쪽에서 항목을 고르세요.</p></main>
</div>
<script nonce="${nonce}" src="${media('book.js')}"></script>
</body></html>`;
  }
}

/** 단축키: 검색 팝업으로 골라 바로 콘솔에 넣기. values 는 미리 채울 값 (트리에서 고른 테이블 등) */
export async function pickEntry(store: QueryBookStore, target: BookTarget, deps: BookDeps, values: Record<string, string> = {}, title?: string) {
  const entries = await store.load(target.kind);
  type Item = vscode.QuickPickItem & { entry: BookEntry };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = title ?? `쿼리 사전 · ${KIND_LABEL[target.kind] ?? target.kind}`;
  qp.placeholder = '찾기 — 제목·분류·태그·상황 (Enter: 콘솔에 넣기)';
  const info: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('book'), tooltip: '설명 보기 (사전 화면)' };
  const items = (q: string): Item[] =>
    entries
      .filter((e) => !q || matches(e, q))
      .map((e) => ({
        label: `$(book) ${e.title}`,
        description: e.category + (e.privilege ? ' · DBA' : '') + (e.source !== 'builtin' ? (e.source === 'project' ? ' · 프로젝트' : ' · 내 사전') : ''),
        detail: e.situation.split('\n')[0].slice(0, 120),
        buttons: [info],
        alwaysShow: true, // 거르기는 직접 (낱말 순서·띄어쓰기 무시)
        entry: e,
      }));
  qp.items = items('');
  qp.onDidChangeValue((v) => (qp.items = items(v)));
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    qp.hide();
    if (it) deps.insert(target, it.entry.query, values, it.entry.title);
  });
  qp.onDidTriggerItemButton((ev) => {
    qp.hide();
    void vscode.commands.executeCommand('devBoost.dbConsole.queryBook', ev.item.entry.id);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** 사전에 추가: 제목·분류·저장할 곳을 묻고, 틀을 채운 .md 를 열어 상황·예제를 마저 쓰게 한다 */
export async function addEntry(store: QueryBookStore, target: BookTarget, query: string, panel?: QueryBookPanel) {
  const title = await vscode.window.showInputBox({
    title: '사전에 추가 (1/3) — 제목',
    prompt: '나중에 찾을 때 볼 제목. 예: BOM 에 같은 자품목이 두 번 들어간 것 찾기',
    validateInput: (v) => (v.trim() ? undefined : '제목을 넣어 주세요'),
  });
  if (!title) return;
  const entries = await store.load(target.kind);
  const cats = [...new Set(['집계·분석', '데이터 점검', '계층·BOM', '날짜', '조회 기법', '데이터 바꾸기', '딕셔너리', '세션·성능', ...entries.map((e) => e.category)])];
  const NEW = '$(add) 새 분류…';
  const pickedCat = await vscode.window.showQuickPick([...cats, NEW], { title: '사전에 추가 (2/3) — 분류' });
  if (!pickedCat) return;
  const category = pickedCat === NEW ? await vscode.window.showInputBox({ title: '새 분류 이름' }) : pickedCat;
  if (!category) return;
  const hasProject = !!store.projectDir();
  const where = await vscode.window.showQuickPick(
    [
      ...(hasProject ? [{ label: '프로젝트 사전', description: '.devboost/querybook/ — git 으로 팀과 나눔', value: 'project' as const }] : []),
      { label: '내 사전', description: '나만, 모든 프로젝트에서', value: 'user' as const },
    ],
    { title: '사전에 추가 (3/3) — 저장할 곳' }
  );
  if (!where) return;
  const uri = await store.newFile(where.value, title);
  if (!uri) return;
  const text = newEntryText({ title: title.trim(), category, db: target.kind, query: query || 'SELECT ${칸:*}\n  FROM ${테이블:TABLE_NAME}' });
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showInformationMessage('사전에 넣었습니다. 열린 파일에 상황·예제·풀이를 적어 두면 나중에 읽기 쉽습니다 (저장하면 사전에 바로 보입니다).');
  await panel?.reload();
}
