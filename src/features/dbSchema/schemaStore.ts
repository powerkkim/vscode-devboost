import * as vscode from 'vscode';
import { schemaFileName } from './schema/merge';
import { SchemaFile } from './schema/types';

/** 저장한 스키마 파일 하나의 요약 (화면 목록용) */
export interface SavedSchemaInfo {
  file: string;
  schema: string;
  label?: string;
  database?: string;
  collectedAt?: string;
  prefixes?: string[];
  tables: number;
  views: number;
  columns: number;
}

/**
 * 워크스페이스의 .devboost/schema/*.json 읽기·쓰기.
 * 워크스페이스 폴더가 여러 개면 화면을 열 때 활성 편집기가 속한 폴더, 없으면 첫 번째 폴더.
 */
export class SchemaStore {
  private pinned: vscode.Uri | undefined;

  /**
   * 화면을 여는 순간의 활성 편집기 기준으로 폴더를 정해 둔다.
   * 화면(Webview)에 포커스가 가면 activeTextEditor 가 없어져 매번 계산하면 첫 폴더로 바뀌기 때문.
   */
  pinRoot() {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = active && vscode.workspace.getWorkspaceFolder(active);
    if (folder) this.pinned = folder.uri;
  }

  root(): vscode.Uri | undefined {
    if (this.pinned && vscode.workspace.getWorkspaceFolder(this.pinned)) return this.pinned;
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  dir(): vscode.Uri | undefined {
    const r = this.root();
    return r && vscode.Uri.joinPath(r, '.devboost', 'schema');
  }

  async list(): Promise<SavedSchemaInfo[]> {
    const dir = this.dir();
    if (!dir) return [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }
    const out: SavedSchemaInfo[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
      const s = await this.read(name);
      if (!s) continue;
      out.push({
        file: name,
        schema: s.source.schema,
        label: s.source.label,
        database: s.source.database,
        collectedAt: s.source.collectedAt,
        prefixes: s.source.prefixes,
        tables: s.tables.filter((t) => t.kind === 'table').length,
        views: s.tables.filter((t) => t.kind === 'view').length,
        columns: s.columns.length,
      });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }

  async read(file: string): Promise<SchemaFile | undefined> {
    const dir = this.dir();
    if (!dir) return undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, file));
      const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as SchemaFile;
      if (j.format !== 'devboost-schema' || !j.source?.schema) return undefined;
      // 손으로 고친 파일에서 목록이 빠져 있어도 화면이 멈추지 않게
      for (const k of ['tables', 'columns', 'constraints', 'indexes'] as const) {
        if (!Array.isArray(j[k])) (j as unknown as Record<string, unknown[]>)[k] = [];
      }
      return j;
    } catch {
      return undefined;
    }
  }

  /** 저장하고 파일 이름을 돌려준다 */
  async write(schema: SchemaFile): Promise<string> {
    const dir = this.dir();
    if (!dir) throw new Error('워크스페이스 폴더를 먼저 여세요.');
    await vscode.workspace.fs.createDirectory(dir);
    const name = schemaFileName(schema.source);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), Buffer.from(JSON.stringify(schema, null, 1) + '\n', 'utf8'));
    return name;
  }
}
