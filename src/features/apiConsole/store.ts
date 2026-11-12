import * as vscode from 'vscode';
import { ApiData, ApiEnvironment, ApiNode, HISTORY_MAX, HistoryEntry, emptyData, normalizeData } from './model';

/**
 * API 콘솔의 저장소: 모음·환경·기록을 확장 전역 저장 폴더의 파일 하나에 둔다 (프로젝트 폴더는 건드리지 않는다).
 * 화면을 처음 열 때 읽고, 바뀌면 조금 모아서 쓴다.
 */
export class ApiStore {
  private data: ApiData | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly dir: vscode.Uri;
  private readonly file: vscode.Uri;

  constructor(context: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(context.globalStorageUri, 'apiConsole');
    this.file = vscode.Uri.joinPath(this.dir, 'data.json');
  }

  async load(): Promise<ApiData> {
    if (this.data) return this.data;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file);
      this.data = normalizeData(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch {
      this.data = emptyData(); // 처음이거나 읽을 수 없는 파일
    }
    return this.data;
  }

  /** 화면에서 고친 모음·환경을 받아 둔다 (기록은 확장이 관리) */
  update(part: { collections: ApiNode[]; environments: ApiEnvironment[]; activeEnvironment?: string }) {
    if (!this.data) return;
    const next = normalizeData({ ...part, history: this.data.history });
    this.data = next;
    this.schedule();
  }

  addHistory(entry: HistoryEntry): HistoryEntry[] {
    if (!this.data) return [];
    this.data.history.unshift(entry);
    this.data.history.length = Math.min(this.data.history.length, HISTORY_MAX);
    this.schedule();
    return this.data.history;
  }

  clearHistory() {
    if (!this.data) return;
    this.data.history = [];
    this.schedule();
  }

  current(): ApiData | undefined {
    return this.data;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  /** 밀린 저장을 지금 쓴다 */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const data = this.data;
    if (!data) return this.writing;
    const text = JSON.stringify(data);
    this.writing = this.writing
      .then(async () => {
        await vscode.workspace.fs.createDirectory(this.dir);
        await vscode.workspace.fs.writeFile(this.file, Buffer.from(text, 'utf8'));
      })
      .catch(() => undefined);
    return this.writing;
  }
}
