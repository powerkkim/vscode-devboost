import * as vscode from 'vscode';
import * as path from 'path';
import { Feature } from '../../core/feature';
import { analyzeSource } from './pipeline';
import { AtlasPanel } from './ui/atlasPanel';

/**
 * Source Atlas — 열려 있는 .vue 파일을 루트로 컴포넌트·composable·store·API 관계를 분석한다.
 * open: 분석 결과를 Atlas 화면(Webview)으로 보여 줌 / dump: 분석 결과 JSON 을 출력 패널에 덤프.
 */
export const sourceAtlas: Feature = {
  id: 'sourceAtlas',
  name: 'Source Atlas',
  start(context) {
    const output = vscode.window.createOutputChannel('DevBoost Atlas');
    const dump = vscode.commands.registerCommand('devBoost.sourceAtlas.dump', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !doc.fileName.endsWith('.vue')) {
        void vscode.window.showWarningMessage('Source Atlas: 분석할 .vue 파일을 먼저 열어 주세요.');
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) {
        void vscode.window.showWarningMessage('Source Atlas: 워크스페이스 폴더 안의 파일만 분석할 수 있습니다.');
        return;
      }
      const cfg = vscode.workspace.getConfiguration('devBoost.sourceAtlas');
      const started = Date.now();
      try {
        const { graph, notes } = analyzeSource(doc.fileName, {
          workspaceRoot: folder.uri.fsPath,
          maxDepth: cfg.get<number>('maxDepth', 3),
          maxUp: cfg.get<number>('maxUpDepth', 3),
          backend: cfg.get<boolean>('backend.enabled', true),
          backendDepth: cfg.get<number>('backend.maxDepth', 6),
          aliases: cfg.get<Record<string, string>>('aliases', {}),
          fresh: true,
        });
        output.clear();
        notes.forEach((n) => output.appendLine(`// ${n}`));
        output.appendLine(`// ${path.basename(doc.fileName)} — 노드 ${graph.nodes.length}, 엣지 ${graph.edges.length}, ${Date.now() - started}ms`);
        output.appendLine(JSON.stringify(graph, null, 2));
        output.show(true);
      } catch (e) {
        void vscode.window.showErrorMessage(`Source Atlas 분석 실패: ${(e as Error).message}`);
      }
    });
    const open = vscode.commands.registerCommand('devBoost.sourceAtlas.open', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !doc.fileName.endsWith('.vue')) {
        void vscode.window.showWarningMessage('Source Atlas: 분석할 .vue 파일을 먼저 열어 주세요.');
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder) {
        void vscode.window.showWarningMessage('Source Atlas: 워크스페이스 폴더 안의 파일만 분석할 수 있습니다.');
        return;
      }
      AtlasPanel.show(context, doc.fileName, folder.uri.fsPath);
    });
    return [output, dump, open];
  },
};
