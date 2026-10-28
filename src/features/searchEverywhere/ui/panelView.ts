import * as vscode from 'vscode';
import { SearchService, TabId } from '../search/searchService';
import { WebviewSession, FromWebview, selectedText } from './webviewSession';

/**
 * 뷰 ID. VS Code는 "사용자가 이 뷰를 어디에 뒀는지"를 ID로 기억하므로,
 * 뷰의 기본 자리를 바꿀 때는 ID도 함께 바꿔야 옛 위치 기억이 적용되지 않는다.
 * (0.5.0 하단 패널 → 0.5.1 사이드바로 옮길 때 탐색기에 붙던 문제)
 */
export const PANEL_VIEW_ID = 'devBoost.searchEverywhere.sidebar';

/**
 * 왼쪽 Activity Bar의 DevBoost 사이드바에 들어가는 Search Everywhere (Ctrl+Shift+F 검색과 같은 자리).
 * 사용자가 끌어다 놓으면 오른쪽 사이드바나 하단 패널로도 옮길 수 있고 VS Code가 기억한다.
 * 코드 창을 가리지 않고, 검색할 때만 열어서 쓴다.
 */
export class SearchEverywhereView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private session: WebviewSession | undefined;
  /** 결과를 열 에디터 자리: 패널에 포커스가 가기 전 마지막 에디터 */
  private lastEditorColumn: vscode.ViewColumn | undefined;
  private pending: { tab: TabId; query: string } | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: SearchService
  ) {}

  /** Shift 두 번 / 명령에서 호출: 사이드바를 열고 검색창에 커서를 둔다 */
  async show(tab: TabId) {
    this.lastEditorColumn = vscode.window.activeTextEditor?.viewColumn ?? this.lastEditorColumn;
    const query = selectedText();
    this.pending = { tab, query };
    if (this.session) {
      this.session.open(tab, query);
    }
    // 뷰가 없으면 focus 명령이 뷰를 만들고 resolveWebviewView가 불린다
    await vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`);
    if (this.session && this.view?.visible) {
      this.session.post({ type: 'focus' });
    }
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    const session = new WebviewSession(view.webview, this.service, {
      kindLabel: '사이드바',
      close: () => this.hide(),
      targetColumn: () => this.lastEditorColumn,
    });
    this.session = session;
    if (this.pending) {
      session.open(this.pending.tab, this.pending.query);
    }
    view.webview.html = session.html(this.context.extensionUri, 'fill');
    view.webview.onDidReceiveMessage((m: FromWebview) => session.onMessage(m));

    // 사이드바가 다시 보일 때 검색창으로 커서
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        session.post({ type: 'focus' });
        session.resume(); // 숨겨질 때 검색을 멈췄으면 같은 검색을 다시
      } else {
        session.cancel(); // 숨겨지면 진행 중인 검색을 멈춘다 (다시 보이면 새로 검색)
      }
    });
    view.onDidDispose(() => {
      session.cancel();
      this.view = undefined;
      this.session = undefined;
    });
  }

  /** Esc 또는 항목 열기: 사이드바를 닫고 커서를 코드로 돌려보낸다 (Ctrl+Shift+F 검색에서 Ctrl+B와 같음) */
  private hide() {
    const keepOpen = vscode.workspace
      .getConfiguration('devBoost.searchEverywhere')
      .get<boolean>('panelKeepOpen', false);
    if (!keepOpen) {
      // 기본 자리인 왼쪽 사이드바를 닫는다.
      // 사용자가 뷰를 오른쪽/하단으로 옮긴 경우는 플러그인이 알 수 없어 그대로 두고 커서만 돌려보낸다.
      void vscode.commands.executeCommand('workbench.action.closeSidebar');
    }
    void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }
}
