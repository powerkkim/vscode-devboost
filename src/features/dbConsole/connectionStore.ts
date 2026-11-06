import * as vscode from 'vscode';
import { DbConnectionConfig } from './connection/config';

const LIST_KEY = 'devBoost.dbConsole.connections';
const secretKey = (id: string) => `devBoost.dbConsole.password.${id}`;
const viewKey = (id: string) => `devBoost.dbConsole.view.${id}`;

/** 트리에서 보는 방법 (연결마다) */
export interface TreeView {
  /** 보는 스키마. 없으면 접속한 계정의 스키마 */
  schema?: string;
  /** 테이블 이름 필터 (sql/nameFilter.ts 의 글) */
  filter?: string;
}

/**
 * 저장한 DB 연결 목록.
 *  - 연결 정보(이름·주소·사용자)는 VS Code 전역 상태에 (이 PC 의 모든 프로젝트에서 같이 씀, 설정 동기화 대상 아님)
 *  - 비밀번호는 SecretStorage 에 (OS 의 자격 증명 저장소). 연결 정보와 따로 둔다
 */
export class ConnectionStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose() {
    this.changed.dispose();
  }

  /** 이름순 */
  list(): DbConnectionConfig[] {
    const all = this.context.globalState.get<DbConnectionConfig[]>(LIST_KEY, []);
    return [...all].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): DbConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  /**
   * 연결을 추가하거나 고친다.
   * password: 문자열 = 그 값으로 저장, undefined = 저장된 비밀번호를 그대로 둔다.
   * savePassword 가 false 면 저장된 비밀번호를 지운다
   */
  async save(cfg: DbConnectionConfig, password?: string): Promise<void> {
    const rest = this.list().filter((c) => c.id !== cfg.id);
    await this.context.globalState.update(LIST_KEY, [...rest, cfg]);
    if (!cfg.savePassword) {
      await this.context.secrets.delete(secretKey(cfg.id));
    } else if (password !== undefined) {
      await this.context.secrets.store(secretKey(cfg.id), password);
    }
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(
      LIST_KEY,
      this.list().filter((c) => c.id !== id)
    );
    await this.context.secrets.delete(secretKey(id));
    await this.context.globalState.update(viewKey(id), undefined);
    this.changed.fire();
  }

  view(id: string): TreeView {
    return this.context.globalState.get<TreeView>(viewKey(id)) ?? {};
  }

  async setView(id: string, view: TreeView): Promise<void> {
    await this.context.globalState.update(viewKey(id), view);
  }

  /** 저장된 비밀번호 (없으면 undefined) */
  async password(id: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }
}
