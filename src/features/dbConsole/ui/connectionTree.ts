import * as vscode from 'vscode';
import type { DbConnectionConfig } from '../connection/config';
import type { SchemaObjects, TableColumn } from '../driver/types';
import { describeConnection } from '../driver/registry';
import { ConnectionStore } from '../connectionStore';
import { Sessions } from '../sessions';
import { parseNameFilter } from '../sql/nameFilter';

export const CONNECTIONS_VIEW_ID = 'devBoost.dbConsole.connections';

type State = 'connected' | 'connecting' | 'disconnected';
type ObjectKind = 'tables' | 'views' | 'synonyms';

const fmt = (n: number) => n.toLocaleString('ko-KR');

/** 사이드바 "DB 연결" 목록의 연결 한 줄. 접속돼 있으면 펼쳐서 테이블·뷰를 본다 */
export class ConnectionItem extends vscode.TreeItem {
  constructor(
    readonly config: DbConnectionConfig,
    state: State,
    info?: { product: string; version: string },
    view: { schema?: string; filter?: string; sessions?: number } = {}
  ) {
    super(config.name, state === 'connected' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = config.id;
    const flags = [config.production ? '운영' : '', config.readOnly ? '읽기 전용' : ''].filter(Boolean).join(' · ');
    const shown = [view.schema ? `스키마 ${view.schema}` : '', view.filter ? `필터 ${view.filter}` : ''].filter(Boolean).join(' · ');
    // 서버에 열어 둔 접속 수 (기본 + 콘솔별). 둘 이상이거나, 기본 접속 없이 콘솔 접속만 있을 때 보인다
    const n = view.sessions ?? 0;
    const count = n > 1 || (n > 0 && state !== 'connected') ? `  · 접속 ${n}` : '';
    this.description = describeConnection(config) + (flags ? `  [${flags}]` : '') + (shown ? `  (${shown})` : '') + count;
    // package.json 의 메뉴 조건(viewItem)에 쓴다: dbConnection.connected / .connected.filtered / .disconnected.sessions(콘솔 접속만 있음) …
    const consoleOnly = state !== 'connected' && n > 0 ? '.sessions' : '';
    this.contextValue = `dbConnection.${state}${consoleOnly}${view.filter ? '.filtered' : ''}`;
    // 접속됨 = 플러그 아이콘(초록), 접속 안 됨 = DB 아이콘. 운영 DB 는 어느 쪽이든 빨간색
    const color = config.production ? 'charts.red' : state === 'connected' ? 'charts.green' : undefined;
    this.iconPath =
      state === 'connecting'
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon(state === 'connected' ? 'plug' : 'database', color ? new vscode.ThemeColor(color) : undefined);
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${config.name}**${flags ? ` — ${flags}` : ''}\n\n`);
    tip.appendCodeblock(describeConnection(config), 'text');
    tip.appendMarkdown(state === 'connected' ? `접속됨${info ? ` · ${info.product} ${info.version}` : ''}` : state === 'connecting' ? '접속하는 중…' : '접속 안 됨');
    if (n > 0) tip.appendMarkdown(`\n\n서버에 열어 둔 접속 ${n}개 (콘솔마다 따로 접속합니다. 콘솔을 닫으면 그 접속도 닫습니다)`);
    if (shown) tip.appendMarkdown(`\n\n${shown}`);
    this.tooltip = tip;
  }
}

/** "테이블" / "뷰" / "시노님" 묶음 */
class GroupItem extends vscode.TreeItem {
  constructor(
    readonly connectionId: string,
    readonly owner: string,
    readonly kind: ObjectKind,
    readonly entries: { name: string; targetOwner?: string; targetName?: string }[],
    total: number,
    filtered: boolean
  ) {
    super(kind === 'tables' ? '테이블' : kind === 'views' ? '뷰' : '시노님', entries.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = `${connectionId}/${owner}/${kind}`;
    this.description = filtered ? `${fmt(entries.length)} / ${fmt(total)}` : fmt(total);
    this.iconPath = new vscode.ThemeIcon(kind === 'tables' ? 'table' : kind === 'views' ? 'eye' : 'link');
    this.contextValue = 'dbGroup';
    if (filtered && entries.length === 0 && total > 0) this.tooltip = '필터에 맞는 것이 없습니다';
    // 테이블은 펼쳐 둔다 (필터를 걸었을 때는 다른 묶음도)
    if (entries.length && (kind === 'tables' || filtered)) this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  }
}

/** 테이블·뷰·시노님 한 줄. 펼치면 칸, 누르면 콘솔에 이름을 넣는다. 여러 개 골라 오른쪽 클릭으로 쿼리를 만든다 */
export class TableItem extends vscode.TreeItem {
  /** 칸을 읽을 실제 대상 (시노님이면 가리키는 테이블) */
  readonly target: { owner: string; name: string };

  constructor(
    readonly connectionId: string,
    readonly owner: string,
    readonly tableName: string,
    readonly kind: ObjectKind,
    /** 쿼리에 쓸 이름 (다른 스키마면 OWNER.NAME) */
    readonly qualified: string,
    target?: { owner: string; name: string }
  ) {
    super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
    this.target = target ?? { owner, name: tableName };
    this.id = `${connectionId}/${owner}/${kind}/${tableName}`;
    this.contextValue = 'dbTable';
    this.iconPath = new vscode.ThemeIcon(kind === 'tables' ? 'symbol-class' : kind === 'views' ? 'symbol-interface' : 'symbol-reference');
    if (kind === 'synonyms') this.description = `→ ${this.target.owner}.${this.target.name}`;
    this.tooltip = '눌러서 콘솔의 커서 자리에 이름 넣기 · 여러 개 골라 오른쪽 클릭으로 SELECT·JOIN 만들기';
    this.command = { command: 'devBoost.dbConsole.insertName', title: '이름 넣기', arguments: [connectionId, qualified] };
  }
}

class ColumnItem extends vscode.TreeItem {
  constructor(connectionId: string, table: TableItem, c: TableColumn) {
    super(c.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${table.id}/col/${c.name}`;
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

export type TreeNode = ConnectionItem | GroupItem | TableItem | ColumnItem | InfoItem;

/** 테이블·뷰·칸을 가져오는 쪽 (index.ts 가 채운다: 접속을 쓰고, 결과를 기억해 둔다) */
export interface SchemaSource {
  /** 그 연결의 지금 스키마 (접속한 계정, 또는 트리에서 바꾼 것) */
  owner(connectionId: string): string | undefined;
  /** 접속한 계정의 스키마 (이 스키마의 이름은 앞에 스키마를 붙이지 않는다) */
  loginSchema(connectionId: string): string | undefined;
  objects(connectionId: string, owner: string): Promise<SchemaObjects>;
  columns(connectionId: string, owner: string, table: string): Promise<TableColumn[]>;
}

export class ConnectionTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: { dispose(): void }[];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: Sessions,
    private readonly schema: SchemaSource
  ) {
    this.subs = [store.onDidChange(() => this.changed.fire(undefined)), sessions.onDidChange(() => this.changed.fire(undefined))];
  }

  /** 테이블 목록을 다시 그린다 (새로 고침·필터를 바꾼 뒤) */
  refresh() {
    this.changed.fire(undefined);
  }

  dispose() {
    this.subs.forEach((d) => d.dispose());
    this.changed.dispose();
  }

  getTreeItem(item: TreeNode): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: TreeNode): Promise<TreeNode[]> {
    if (!parent) {
      return this.store.list().map((c) => {
        const s = this.sessions.get(c.id);
        const view = this.store.view(c.id);
        const shownSchema = view.schema && s && view.schema !== s.info.schema ? view.schema : undefined;
        return new ConnectionItem(c, s ? 'connected' : this.sessions.isConnecting(c.id) ? 'connecting' : 'disconnected', s?.info, {
          schema: shownSchema,
          filter: parseNameFilter(view.filter).text || undefined,
          sessions: this.sessions.countOf(c.id),
        });
      });
    }
    try {
      if (parent instanceof ConnectionItem) {
        const id = parent.config.id;
        const owner = this.schema.owner(id);
        if (!this.sessions.isConnected(id) || !owner) return [];
        const o = await this.schema.objects(id, owner);
        const filter = parseNameFilter(this.store.view(id).filter);
        const groups: GroupItem[] = [];
        const add = (kind: ObjectKind, all: { name: string; targetOwner?: string; targetName?: string }[]) => {
          if (kind === 'synonyms' && !all.length) return; // 시노님이 없으면 묶음을 보이지 않는다
          groups.push(new GroupItem(id, owner, kind, filter.active ? all.filter((e) => filter.test(e.name)) : all, all.length, filter.active));
        };
        add('tables', o.tables.map((name) => ({ name })));
        add('views', o.views.map((name) => ({ name })));
        add('synonyms', o.synonyms.map((s) => ({ name: s.name, targetOwner: s.targetOwner, targetName: s.targetName })));
        return groups;
      }
      if (parent instanceof GroupItem) {
        const login = this.schema.loginSchema(parent.connectionId);
        const qualify = (name: string) => (parent.owner === login ? name : `${parent.owner}.${name}`);
        return parent.entries.map(
          (e) =>
            new TableItem(
              parent.connectionId,
              parent.owner,
              e.name,
              parent.kind,
              qualify(e.name),
              e.targetOwner && e.targetName ? { owner: e.targetOwner, name: e.targetName } : undefined
            )
        );
      }
      if (parent instanceof TableItem) {
        const cols = await this.schema.columns(parent.connectionId, parent.target.owner, parent.target.name);
        return cols.map((c) => new ColumnItem(parent.connectionId, parent, c));
      }
    } catch (e) {
      return [new InfoItem(`가져오지 못했습니다: ${String((e as Error)?.message ?? e).split('\n')[0]}`)];
    }
    return [];
  }
}
