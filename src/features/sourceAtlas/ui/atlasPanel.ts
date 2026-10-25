import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { analyzeSource, clearAtlasCaches } from '../pipeline';

/**
 * Atlas 화면(Webview). 한 번에 하나만 띄우고, 다시 열면 같은 패널에서 새 파일을 분석한다.
 * 확장 ↔ 화면 메시지:
 *   화면 → 확장: ready | refresh | open{file,line}
 *   확장 → 화면: loading | graph{graph,stats} | error{message}
 */
export class AtlasPanel {
  private static current: AtlasPanel | undefined;

  private rootFile: string;
  private workspaceRoot: string;
  private readonly disposables: vscode.Disposable[] = [];
  /** 다음 분석에서 색인 캐시를 버릴지 (새 파일을 열었거나 '다시 분석' 일 때) */
  private fresh = true;

  static show(context: vscode.ExtensionContext, rootFile: string, workspaceRoot: string) {
    if (AtlasPanel.current) {
      AtlasPanel.current.rootFile = rootFile;
      AtlasPanel.current.workspaceRoot = workspaceRoot;
      AtlasPanel.current.fresh = true;
      AtlasPanel.current.panel.reveal(undefined, true);
      AtlasPanel.current.analyze();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'devBoostSourceAtlas',
      'Source Atlas',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    AtlasPanel.current = new AtlasPanel(context, panel, rootFile, workspaceRoot);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    rootFile: string,
    workspaceRoot: string
  ) {
    this.rootFile = rootFile;
    this.workspaceRoot = workspaceRoot;
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m))
    );
  }

  private onMessage(m: { type: string; file?: string; line?: number; col?: number }) {
    switch (m.type) {
      case 'ready':
        this.analyze();
        break;
      case 'refresh': {
        // 지금 열려 있는 .vue 파일이 있으면 그 파일로, 없으면 마지막 분석 대상으로 다시 분석
        const active = vscode.window.activeTextEditor?.document;
        if (active && active.fileName.endsWith('.vue')) {
          const f = vscode.workspace.getWorkspaceFolder(active.uri);
          if (f) {
            this.rootFile = active.fileName;
            this.workspaceRoot = f.uri.fsPath;
          }
        }
        this.fresh = true;
        this.analyze();
        break;
      }
      case 'open':
        if (m.file) {
          this.openFile(m.file, m.line, m.col);
        }
        break;
    }
  }

  private async openFile(rel: string, line?: number, col?: number) {
    const abs = path.resolve(this.workspaceRoot, rel);
    // 보안: 워크스페이스 밖 경로는 열지 않는다
    if (path.relative(this.workspaceRoot, abs).startsWith('..')) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(abs);
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (col ?? 1) - 1));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(pos, pos),
        preview: false,
        preserveFocus: false,
      });
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (e) {
      void vscode.window.showWarningMessage(`파일을 열 수 없습니다: ${rel}`);
    }
  }

  private analyze() {
    const post = (m: unknown) => void this.panel.webview.postMessage(m);
    post({ type: 'loading' });
    const cfg = vscode.workspace.getConfiguration('devBoost.sourceAtlas');
    const started = Date.now();
    try {
      const { graph, notes } = analyzeSource(this.rootFile, {
        workspaceRoot: this.workspaceRoot,
        maxDepth: cfg.get<number>('maxDepth', 3),
        maxUp: cfg.get<number>('maxUpDepth', 3),
        backend: cfg.get<boolean>('backend.enabled', true),
        backendDepth: cfg.get<number>('backend.maxDepth', 6),
        aliases: cfg.get<Record<string, string>>('aliases', {}),
        fresh: this.fresh,
      });
      this.fresh = false;
      this.panel.title = `Atlas: ${path.basename(this.rootFile)}`;
      const stats = [`노드 ${graph.nodes.length} · 엣지 ${graph.edges.length} · ${Date.now() - started}ms`, ...notes].join('  |  ');
      post({ type: 'graph', graph, stats });
    } catch (e) {
      post({ type: 'error', message: `분석 실패: ${(e as Error).message}` });
    }
  }

  private html(): string {
    const wv = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sourceAtlas');
    const js = wv.asWebviewUri(vscode.Uri.joinPath(base, 'app.js'));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(base, 'app.css'));
    const nonce = randomBytes(16).toString('base64');
    // Vue Flow 가 노드 위치를 style 속성으로 주므로 style-src 는 'unsafe-inline' 이 필요하다. 스크립트는 nonce 로만 허용.
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} data:; font-src ${wv.cspSource} data:; style-src ${wv.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Source Atlas</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private dispose() {
    AtlasPanel.current = undefined;
    clearAtlasCaches(); // 창을 닫으면 색인도 놓는다 (다시 열면 새로 만든다)
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
