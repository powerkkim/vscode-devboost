import * as vscode from 'vscode';
import { performance } from 'perf_hooks';
import { SearchService, TabId } from '../search/searchService';
import { WebviewSession, FromWebview, selectedText } from './webviewSession';

/**
 * Search Everywhere 를 에디터 탭(WebviewPanel)으로 여는 방식.
 *  - mode 'popup' : 현재 에디터 영역에 탭으로 연다. 다른 곳을 클릭하면 닫힌다.
 *  - mode 'window': (실험) 탭을 연 뒤 VS Code "새 창으로 이동" 기능으로 별도 창으로 분리한다.
 * 기본 방식은 panelView.ts(하단/사이드 패널)이고, 이 파일은 설정으로 고를 때만 쓴다.
 */
export type PanelMode = 'popup' | 'window';

export class SearchEverywherePanel {
  private static current: SearchEverywherePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly session: WebviewSession;
  private readonly disposables: vscode.Disposable[] = [];
  /** 창으로 분리하는 중에는 포커스가 잠깐 빠져도 닫지 않는다 */
  private moving = false;
  /** 결과를 열 원래 에디터 위치 (떠 있는 창 모드에서 메인 창에 열기 위해) */
  private readonly targetColumn: vscode.ViewColumn | undefined;

  static show(context: vscode.ExtensionContext, service: SearchService, tab: TabId, mode: PanelMode) {
    const query = selectedText();
    const existing = SearchEverywherePanel.current;
    if (existing) {
      existing.panel.reveal(undefined, false);
      existing.session.open(tab, query);
      return;
    }
    SearchEverywherePanel.current = new SearchEverywherePanel(context, service, tab, query, mode);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly service: SearchService,
    tab: TabId,
    query: string,
    private readonly mode: PanelMode
  ) {
    this.targetColumn = vscode.window.activeTextEditor?.viewColumn;
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'devBoost.searchEverywhere',
      'Search Everywhere',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [mediaRoot] }
    );
    this.panel.iconPath = new vscode.ThemeIcon('search');

    this.session = new WebviewSession(this.panel.webview, service, {
      kindLabel: mode === 'window' ? '떠 있는 창' : '탭',
      close: () => this.panel.dispose(),
      targetColumn: () => (mode === 'window' ? this.targetColumn : undefined),
    });
    this.session.open(tab, query);
    this.panel.webview.html = this.session.html(context.extensionUri, 'popup');

    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.session.onMessage(m), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      (e) => {
        // 팝업처럼: 다른 곳을 클릭해 포커스를 잃으면 닫는다
        // (떠 있는 창 모드는 창 사이 이동이 잦아 자동으로 닫지 않는다. Esc나 선택으로 닫음)
        if (!e.webviewPanel.active && !this.moving && this.mode === 'popup') {
          this.panel.dispose();
        }
      },
      null,
      this.disposables
    );

    if (mode === 'window') {
      void this.moveToFloatingWindow();
    }
  }

  /** (실험) 방금 만든 탭을 VS Code 기능으로 별도 창에 분리 */
  private async moveToFloatingWindow() {
    this.moving = true;
    try {
      if (!this.panel.active) {
        // 패널이 활성 에디터가 될 때까지 잠깐 기다린다 (최대 500ms)
        await new Promise<void>((resolve) => {
          const sub = this.panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
              sub.dispose();
              resolve();
            }
          });
          setTimeout(() => {
            sub.dispose();
            resolve();
          }, 500);
        });
      }
      const t0 = performance.now();
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      this.service.log.appendLine(`[창] 새 창으로 분리 ${Math.round(performance.now() - t0)}ms`);
    } catch (e) {
      this.service.log.appendLine(`[창] 새 창으로 분리 실패 → 탭으로 표시합니다: ${e}`);
    } finally {
      // 창 이동 직후 포커스 이벤트가 정리될 시간을 둔다
      setTimeout(() => (this.moving = false), 300);
    }
  }

  private dispose() {
    SearchEverywherePanel.current = undefined;
    this.session.cancel('창 닫힘'); // 진행 중인 rg 를 멈추고 늦게 오는 언어 서버 응답은 버린다
    this.disposables.forEach((d) => d.dispose());
  }
}
