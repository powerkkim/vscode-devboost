import * as vscode from 'vscode';
import { DbConnectionConfig, describeConnection } from '../connection/connectString';
import { SchemaObjects, TableColumn } from '../connection/schema';
import { ConnectionStore } from '../connectionStore';
import { Sessions } from '../sessions';

export const CONNECTIONS_VIEW_ID = 'devBoost.dbConsole.connections';

type State = 'connected' | 'connecting' | 'disconnected';

/** 사이드바 "DB 연결" 목록의 연결 한 줄. 접속돼 있으면 펼쳐서 테이블·뷰를 본다 */
export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly config: DbConnectionConfig,
    state: State,
    version?: string
  ) {
    super(config.name, state === 'connected' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
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
    tip.appendMarkdown(state === 'connected' ? `접속됨${version ? ` · Oracle ${version}` : ''}` : state === 'connecting' ? '접속하는 중…' : '접속 안 됨');
    this.tooltip = tip;
  }
}

/** "테이블" / "뷰" 묶음 */
class GroupItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly kind: 'tables' | 'views',
    readonly names: string[]
  ) {
    super(kind === 'tables' ? '테이블' : '뷰', names.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `${connectionId}/${kind}`;
    this.description = String(names.length);
    this.iconPath = new vscode.ThemeIcon(kind === 'tables' ? 'table' : 'eye');
    if (kind === 'tables' && names.length) this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  }
}

/** 테이블·뷰 한 줄. 펼치면 칸, 누르면 콘솔에 이름을 넣는다 */
export class TableItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly tableName: string,
    kind: 'tables' | 'views'
  ) {
    super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${connectionId}/${kind}/${tableName}`;
    this.contextValue = 'dbTable';
    this.iconPath = new vscode.ThemeIcon(kind === 'tables' ? 'symbol-class' : 'symbol-interface');
    this.tooltip = '눌러서 콘솔의 커서 자리에 이름 넣기';
    this.command = { command: 'devBoost.dbConsole.insertName', title: '이름 넣기', arguments: [connectionId, tableName] };
  }
}

class ColumnItem extends vscode.TreeItem {
  constructor(connectionId: string, table: string, c: TableColumn) {
    super(c.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${connectionId}/col/${table}/${c.name}`;
    this.description = c.type + (c.nullable ? '' : ' NOT NULL');
    this.iconPath = new vscode.ThemeIcon('symbol-field');
    this.command = { command: 'devBoost.dbConsole.insertName', title: '이름 넣기', arguments: [connectionId, c.name] };
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
  }
}

type Node = ConnectionItem | GroupItem | TableItem | ColumnItem | InfoItem;

/** 테이블·뷰·칸을 가져오는 쪽 (index.ts 가 채운다: 접속을 쓰고, 결과를 기억해 둔다) */
export interface SchemaSource {
  objects(connectionId: string): Promise<SchemaObjects>;
  columns(connectionId: string, table: string): Promise<TableColumn[]>;
}

export class ConnectionTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: { dispose(): void }[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: Sessions,
    private readonly schema: SchemaSource
  ) {
    this.subs = [store.onDidChange(() => this.changed.fire()), sessions.onDidChange(() => this.changed.fire())];
  }

  /** 테이블 목록을 다시 그린다 (새로 고침 뒤) */
  refresh() {
    this.changed.fire();
  }

  dispose() {
    this.subs.forEach((d) => d.dispose());
    this.changed.dispose();
  }

  getTreeItem(item: Node): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: Node): Promise<Node[]> {
    if (!parent) {
      return this.store.list().map((c) => {
        const s = this.sessions.get(c.id);
        return new ConnectionItem(c, s ? 'connected' : this.sessions.isConnecting(c.id) ? 'connecting' : 'disconnected', s?.info.version);
      });
    }
    try {
      if (parent instanceof ConnectionItem) {
        if (!this.sessions.isConnected(parent.config.id)) return [];
        const o = await this.schema.objects(parent.config.id);
        return [new GroupItem(parent.config.id, 'tables', o.tables), new GroupItem(parent.config.id, 'views', o.views)];
      }
      if (parent instanceof GroupItem) return parent.names.map((n) => new TableItem(parent.connectionId, n, parent.kind));
      if (parent instanceof TableItem) {
        const cols = await this.schema.columns(parent.connectionId, parent.tableName);
        return cols.map((c) => new ColumnItem(parent.connectionId, parent.tableName, c));
      }
    } catch (e) {
      return [new InfoItem(`가져오지 못했습니다: ${String((e as Error)?.message ?? e).split('\n')[0]}`)];
    }
    return [];
  }
}
