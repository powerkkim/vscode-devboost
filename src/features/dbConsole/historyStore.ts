import * as vscode from 'vscode';

/** 실행 기록 한 줄 */
export interface HistoryEntry {
  sql: string;
  /** 실행한 때 (ms) */
  at: number;
  /** 걸린 시간 (ms) */
  ms?: number;
  /** 결과 요약: "5행", "3행 변경됨", 오류 첫 줄 */
  summary: string;
  ok: boolean;
}

/** 연결 하나에 남기는 최대 수 (넘으면 오래된 것부터 지운다) */
export const MAX_HISTORY = 500;

/**
 * 연결별 실행 기록 (확장 전용 저장 폴더: globalStorage/dbConsole/<연결 id>.history.json).
 * 같은 SQL 을 다시 실행하면 새로 쌓지 않고 맨 앞으로 올린다.
 * 파일 쓰기는 모아서 (실행마다 바로 쓰지 않고 잠깐 기다렸다가)
 */
export class HistoryStore implements vscode.Disposable {
  private readonly dir: vscode.Uri;
  private readonly cache = new Map<string, HistoryEntry[]>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(context.globalStorageUri, 'dbConsole');
  }

  private file(id: string) {
    return vscode.Uri.joinPath(this.dir, `${id.replace(/[^\w-]/g, '_')}.history.json`);
  }

  async list(id: string): Promise<HistoryEntry[]> {
    let l = this.cache.get(id);
    if (l) return l;
    try {
      l = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file(id))).toString('utf8')) as HistoryEntry[];
    } catch {
      l = [];
    }
    this.cache.set(id, l);
    return l;
  }

  async add(id: string, e: HistoryEntry): Promise<void> {
    const l = await this.list(id);
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const key = norm(e.sql);
    const i = l.findIndex((x) => norm(x.sql) === key);
    if (i >= 0) l.splice(i, 1);
    l.unshift(e);
    if (l.length > MAX_HISTORY) l.length = MAX_HISTORY;
    this.dirty.add(id);
    this.schedule();
  }

  async clear(id: string): Promise<void> {
    this.cache.set(id, []);
    this.dirty.add(id);
    await this.flush();
  }

  async remove(id: string): Promise<void> {
    this.cache.delete(id);
    this.dirty.delete(id);
    await vscode.workspace.fs.delete(this.file(id)).then(undefined, () => undefined);
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), 2000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const ids = [...this.dirty];
    this.dirty.clear();
    if (!ids.length) return;
    await vscode.workspace.fs.createDirectory(this.dir);
    for (const id of ids) {
      await vscode.workspace.fs.writeFile(this.file(id), Buffer.from(JSON.stringify(this.cache.get(id) ?? []), 'utf8')).then(undefined, () => undefined);
    }
  }

  dispose() {
    void this.flush();
  }
}
