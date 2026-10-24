import * as vscode from 'vscode';

const MAX_RECENT = 100;
const STATE_KEY = 'devBoost.searchEverywhere.recentViewed';

/** "최근에 본 파일" 기록. 에디터가 바뀔 때마다 앞에 넣고, 워크스페이스 상태에 저장한다 */
export class RecentFiles implements vscode.Disposable {
  private list: string[]; // uri.toString(), 최근 것이 앞
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.list = context.workspaceState.get<string[]>(STATE_KEY, []);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.document.uri.scheme === 'file') {
          this.touch(e.document.uri);
        }
      })
    );
    if (vscode.window.activeTextEditor) {
      this.touch(vscode.window.activeTextEditor.document.uri);
    }
  }

  touch(uri: vscode.Uri) {
    const key = uri.toString();
    this.list = [key, ...this.list.filter((k) => k !== key)].slice(0, MAX_RECENT);
    void this.context.workspaceState.update(STATE_KEY, this.list);
  }

  /** 최근 순서대로 */
  uris(): vscode.Uri[] {
    return this.list.map((k) => vscode.Uri.parse(k));
  }

  has(uri: vscode.Uri): boolean {
    return this.list.includes(uri.toString());
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** "최근 변경된 파일": VS Code 내장 Git 플러그인의 작업 트리 변경 목록 (스테이지 포함) */
export async function gitChangedFiles(): Promise<vscode.Uri[]> {
  try {
    const ext = vscode.extensions.getExtension<any>('vscode.git');
    if (!ext) {
      return [];
    }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const api = exports?.getAPI?.(1);
    if (!api) {
      return [];
    }
    const out = new Map<string, vscode.Uri>();
    for (const repo of api.repositories ?? []) {
      const changes = [
        ...(repo.state?.workingTreeChanges ?? []),
        ...(repo.state?.indexChanges ?? []),
        ...(repo.state?.untrackedChanges ?? []),
      ];
      for (const c of changes) {
        const uri: vscode.Uri | undefined = c.uri;
        if (uri && uri.scheme === 'file') {
          out.set(uri.toString(), uri);
        }
      }
    }
    return [...out.values()];
  } catch {
    return [];
  }
}
