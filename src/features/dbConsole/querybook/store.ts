import * as vscode from 'vscode';
import * as path from 'path';
import { BookEntry, BookSource, fitsDb, parseEntry } from './entry';

/**
 * 쿼리 사전 파일 모으기. 세 곳:
 *  - 내장: 확장 안 resources/querybook/<db>/*.md (읽기만)
 *  - 프로젝트: 작업 폴더의 .devboost/querybook/ (git 으로 팀과 나눔)
 *  - 내 사전: 확장 전용 저장소 querybook/ (모든 프로젝트에서)
 * 사전을 열 때만 읽는다 (파일이 작고 몇십 개라 기억해 두지 않아도 가볍다)
 */
export const PROJECT_DIR = '.devboost/querybook';

export class QueryBookStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  builtinDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'querybook');
  }

  userDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'querybook');
  }

  projectDir(): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    return ws && vscode.Uri.joinPath(ws.uri, ...PROJECT_DIR.split('/'));
  }

  async load(kind: string): Promise<BookEntry[]> {
    const out: BookEntry[] = [];
    const project = this.projectDir();
    await Promise.all([
      this.readDir(vscode.Uri.joinPath(this.builtinDir(), kind), 'builtin', out),
      project ? this.readDir(project, 'project', out) : Promise.resolve(),
      this.readDir(this.userDir(), 'user', out),
    ]);
    const order: Record<BookSource, number> = { builtin: 0, project: 1, user: 2 };
    return out.filter((e) => fitsDb(e, kind)).sort((a, b) => order[a.source] - order[b.source] || a.path.localeCompare(b.path));
  }

  /** 폴더 아래 .md 전부 (한 단계 아래 폴더까지 — 분류별로 나눠 둔 경우) */
  private async readDir(dir: vscode.Uri, source: BookSource, out: BookEntry[], depth = 0): Promise<void> {
    let list: [string, vscode.FileType][];
    try {
      list = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return; // 폴더가 없다
    }
    await Promise.all(
      list.map(async ([name, type]) => {
        const uri = vscode.Uri.joinPath(dir, name);
        if (type === vscode.FileType.Directory && depth < 2) return this.readDir(uri, source, out, depth + 1);
        if (type !== vscode.FileType.File || !name.toLowerCase().endsWith('.md')) return;
        try {
          const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          const e = parseEntry(text, source, uri.fsPath);
          if (e) out.push(e);
        } catch {
          // 읽지 못한 파일은 건너뛴다
        }
      })
    );
  }

  /** 새 항목 파일 이름 (제목에서, 겹치면 번호) */
  async newFile(where: 'project' | 'user', title: string): Promise<vscode.Uri | undefined> {
    const dir = where === 'project' ? this.projectDir() : this.userDir();
    if (!dir) return undefined;
    await vscode.workspace.fs.createDirectory(dir);
    const base = title.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || '쿼리';
    for (let n = 0; n < 100; n++) {
      const uri = vscode.Uri.joinPath(dir, `${base}${n ? '_' + n : ''}.md`);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return uri;
      }
    }
    return vscode.Uri.joinPath(dir, `${base}_${Date.now()}.md`);
  }

  categories(entries: BookEntry[]): string[] {
    return [...new Set(entries.map((e) => e.category))];
  }

  label(e: BookEntry): string {
    return e.source === 'builtin' ? '내장' : e.source === 'project' ? `프로젝트 · ${path.basename(e.path)}` : `내 사전 · ${path.basename(e.path)}`;
  }
}
