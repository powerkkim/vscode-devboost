import * as vscode from 'vscode';
import type { BindInput } from './sql/binds';

/** 콘솔 하나에 기억해 두는 것 (콘솔 1 은 연결 id, 콘솔 2부터는 "연결 id#N" 파일) */
export interface ConsoleSaved {
  sql: string;
  params: Record<string, BindInput>;
  confirmEach: boolean;
  /** 서버 출력(Oracle DBMS_OUTPUT)을 켜 두었는지 */
  serverOutput?: boolean;
}

const OLD_KEY = (id: string) => `devBoost.dbConsole.console.${id}`;

/**
 * 콘솔에 쓰던 SQL·파라미터를 연결별 파일로 둔다 (확장 전용 저장 폴더: globalStorage/dbConsole/<연결 id>.json).
 * 예전에는 전역 상태(globalState)에 두었다 — 그곳은 VS Code 를 켤 때 통째로 메모리에 올라가므로 긴 SQL 을 두기에 맞지 않다.
 * 예전 것이 있으면 처음 읽을 때 파일로 옮긴다.
 */
export class ConsoleStore {
  private readonly dir: vscode.Uri;
  /** 같은 파일에 겹쳐 쓰지 않게 연결마다 줄을 세운다 */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(context.globalStorageUri, 'dbConsole');
  }

  private file(id: string) {
    return vscode.Uri.joinPath(this.dir, `${id.replace(/[^\w-]/g, '_')}.json`);
  }

  async load(id: string): Promise<ConsoleSaved | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.file(id));
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as ConsoleSaved;
    } catch {
      // 파일이 없으면 예전 자리(전역 상태)를 본다
      const old = this.context.globalState.get<ConsoleSaved>(OLD_KEY(id));
      if (old) {
        await this.save(id, old);
        await this.context.globalState.update(OLD_KEY(id), undefined);
      }
      return old;
    }
  }

  save(id: string, saved: ConsoleSaved): Promise<void> {
    const prev = this.writing.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      await vscode.workspace.fs.createDirectory(this.dir);
      await vscode.workspace.fs.writeFile(this.file(id), Buffer.from(JSON.stringify(saved), 'utf8'));
    });
    const settled = next.catch(() => undefined);
    this.writing.set(id, settled);
    void settled.then(() => {
      if (this.writing.get(id) === settled) this.writing.delete(id);
    });
    return next;
  }

  /** 연결을 지울 때: 콘솔 1 과 콘솔 2부터(연결 id#N)의 파일을 모두 */
  async removeAll(connectionId: string): Promise<void> {
    await this.remove(connectionId);
    const prefix = `${connectionId}#`.replace(/[^\w-]/g, '_');
    const files = await vscode.workspace.fs.readDirectory(this.dir).then(
      (list) => list,
      () => [] as [string, vscode.FileType][]
    );
    for (const [name] of files) {
      if (name.startsWith(prefix) && name.endsWith('.json')) await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, name)).then(undefined, () => undefined);
    }
  }

  async remove(id: string): Promise<void> {
    await vscode.workspace.fs.delete(this.file(id)).then(undefined, () => undefined);
    await this.context.globalState.update(OLD_KEY(id), undefined);
  }
}
