import * as vscode from 'vscode';
import * as path from 'path';
import { SearchService, SearchItem, TabId } from './searchService';

/** Webview → 확장 메시지 */
type FromWebview =
  | { type: 'ready' }
  | { type: 'search'; runId: number; tab: TabId; query: string }
  | { type: 'toggleNonProject'; value: boolean }
  | { type: 'open'; runId: number; index: number }
  | { type: 'close' };

/** 확장 → Webview 로 보내는 결과 한 줄 (Uri 같은 객체는 못 보내므로 문자열로 변환) */
interface ResultRow {
  kind: SearchItem['kind'];
  /** codicon 이름 (symbol-class, symbol-method 등) → 화면에서 배지 글자/색 결정 */
  icon: string;
  label: string;
  secondary?: string; // 이름 옆 회색 글씨 (패키지 등)
  right?: string; // 오른쪽 정렬 (파일명:줄, 폴더 등)
  footer?: string; // 선택 시 하단에 보여줄 전체 경로
}

/**
 * IntelliJ 스타일 Search Everywhere 창.
 * VS Code는 떠 있는 팝업을 만들 수 없어서 에디터 영역에 Webview 패널로 띄우고,
 * 안쪽에 IntelliJ 팝업 모양의 박스를 그린다. 선택/ESC/다른 곳 클릭 시 닫힌다.
 */
export class SearchEverywherePanel {
  private static current: SearchEverywherePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private latestRunId = 0;
  private latestItems: SearchItem[] = [];
  private pendingInit: { tab: TabId; query: string };

  static show(context: vscode.ExtensionContext, service: SearchService, tab: TabId) {
    const query = selectedText();
    if (SearchEverywherePanel.current) {
      SearchEverywherePanel.current.panel.reveal(vscode.ViewColumn.Active);
      SearchEverywherePanel.current.post({ type: 'init', tab, query, includeNonProject: service.includeNonProject });
      return;
    }
    SearchEverywherePanel.current = new SearchEverywherePanel(context, service, tab, query);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: SearchService,
    tab: TabId,
    query: string
  ) {
    this.pendingInit = { tab, query };
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'devBoost.searchEverywhere',
      'Search Everywhere',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [mediaRoot] }
    );
    this.panel.iconPath = new vscode.ThemeIcon('search');
    this.panel.webview.html = this.html(mediaRoot);

    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // 팝업처럼: 다른 에디터를 클릭해 포커스를 잃으면 닫는다
    this.panel.onDidChangeViewState(
      (e) => {
        if (!e.webviewPanel.active) {
          this.panel.dispose();
        }
      },
      null,
      this.disposables
    );
  }

  private post(msg: unknown) {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', ...this.pendingInit, includeNonProject: this.service.includeNonProject });
        break;

      case 'toggleNonProject':
        this.service.includeNonProject = m.value;
        break;

      case 'search': {
        this.latestRunId = m.runId;
        try {
          const items = await this.service.search(m.tab, m.query, () => this.latestRunId !== m.runId);
          if (this.latestRunId !== m.runId) {
            return; // 더 최신 검색이 있음
          }
          this.latestItems = items;
          this.post({ type: 'results', runId: m.runId, query: m.query, rows: items.map(toRow) });
        } catch (e) {
          this.post({ type: 'results', runId: m.runId, query: m.query, rows: [], error: String(e) });
        }
        break;
      }

      case 'open': {
        const item = m.runId === this.latestRunId ? this.latestItems[m.index] : undefined;
        this.panel.dispose(); // 먼저 닫아야 원래 에디터 위치에 파일이 열린다
        if (item) {
          await this.service.open(item);
        }
        break;
      }

      case 'close':
        this.panel.dispose();
        break;
    }
  }

  private dispose() {
    SearchEverywherePanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }

  private html(mediaRoot: vscode.Uri): string {
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'searchEverywhere.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'searchEverywhere.js'));
    const nonce = makeNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Search Everywhere</title>
</head>
<body>
  <div class="popup" role="dialog" aria-label="Search Everywhere">
    <div class="header">
      <div class="tabs" role="tablist" id="tabs"></div>
      <label class="nonproject" title="Alt+N">
        <input type="checkbox" id="nonProject"> 비 프로젝트 항목 포함(<u>N</u>)
      </label>
    </div>
    <div class="searchbar">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input id="query" type="text" spellcheck="false" autocomplete="off" aria-label="검색어">
      <span class="hint" id="hint">Tab: 탭 전환 · Enter: 열기 · Esc: 닫기</span>
    </div>
    <div class="results" id="results" role="listbox"></div>
    <div class="footer" id="footer"></div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function toRow(item: SearchItem): ResultRow {
  const base = { kind: item.kind, icon: item.icon, label: item.label };
  switch (item.kind) {
    case 'classes':
    case 'symbols':
      // description = 패키지/컨테이너, detail = 상대경로:줄
      return {
        ...base,
        secondary: item.description,
        right: item.detail ? fileAndLine(item.detail) : undefined,
        footer: item.detail,
      };
    case 'files':
      return {
        ...base,
        right: item.description,
        footer: item.description ? `${item.description}/${item.label}` : item.label,
      };
    case 'text':
      // description = 파일명:줄, detail = 상대경로
      return { ...base, right: item.description?.replace(/:(\d+)$/, ' $1'), footer: item.detail };
    case 'actions':
      // description = 넘어갈 화면 (명령 팔레트 / 설정 / 단축키)
      return { ...base, right: item.description, footer: 'Enter: VS Code의 해당 화면을 검색어가 채워진 상태로 엽니다' };
  }
}

/** "a/b/Foo.java:12" → "Foo.java 12" (IntelliJ 오른쪽 표시 형식) */
function fileAndLine(detail: string): string {
  const m = /^(.*):(\d+)$/.exec(detail);
  return m ? `${path.basename(m[1])} ${m[2]}` : path.basename(detail);
}

/** 에디터에서 한 줄짜리 선택이 있으면 검색어로 미리 채운다 (IntelliJ와 동일) */
function selectedText(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return '';
  }
  const text = editor.document.getText(editor.selection);
  return text.includes('\n') ? '' : text.trim().slice(0, 200);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
