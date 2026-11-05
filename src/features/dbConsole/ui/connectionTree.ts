import * as vscode from 'vscode';
import { DbConnectionConfig, describeConnection } from '../connection/connectString';
import { ConnectionStore } from '../connectionStore';
import { Sessions } from '../sessions';

export const CONNECTIONS_VIEW_ID = 'devBoost.dbConsole.connections';

/** 사이드바 "DB 연결" 목록의 한 줄 */
export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly config: DbConnectionConfig,
    state: 'connected' | 'connecting' | 'disconnected',
    version?: string
  ) {
    super(config.name, vscode.TreeItemCollapsibleState.None);
    this.id = config.id;
    const flags = [config.production ? '운영' : '', config.readOnly ? '읽기 전용' : ''].filter(Boolean).join(' · ');
    this.description = describeConnection(config) + (flags ? `  [${flags}]` : '');
    // package.json 의 메뉴 조건(viewItem)에 쓴다
    this.contextValue = `dbConnection.${state}`;
    // 접속됨 = 플러그 아이콘(초록), 접속 안 됨 = DB 아이콘. 운영 DB 는 어느 쪽이든 빨간색
    const color = config.production ? 'charts.red' : state === 'connected' ? 'charts.green' : undefined;
    this.iconPath =
      state === 'connecting'
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon(state === 'connected' ? 'plug' : 'database', color ? new vscode.ThemeColor(color) : undefined);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${config.name}**${flags ? ` — ${flags}` : ''}\n\n`);
    tip.appendCodeblock(describeConnection(config), 'text');
    tip.appendMarkdown(
      state === 'connected' ? `접속됨${version ? ` · Oracle ${version}` : ''}` : state === 'connecting' ? '접속하는 중…' : '접속 안 됨'
    );
    this.tooltip = tip;
  }
}

export class ConnectionTree implements vscode.TreeDataProvider<ConnectionItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: Sessions
  ) {
    this.subs = [store.onDidChange(() => this.changed.fire()), sessions.onDidChange(() => this.changed.fire())];
  }

  dispose() {
    this.subs.forEach((d) => d.dispose());
    this.changed.dispose();
  }

  getTreeItem(item: ConnectionItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: ConnectionItem): ConnectionItem[] {
    if (parent) return [];
    return this.store.list().map((c) => {
      const s = this.sessions.get(c.id);
      return new ConnectionItem(c, s ? 'connected' : this.sessions.isConnecting(c.id) ? 'connecting' : 'disconnected', s?.info.version);
    });
  }
}
