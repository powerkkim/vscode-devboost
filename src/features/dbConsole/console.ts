import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { DbConnectionConfig, kindOf } from './connection/config';
import type { RowCursor, RunResult } from './driver/types';
import type { DbSession } from './driver/session';
import { driverFor } from './driver/registry';
import { ConnectionStore } from './connectionStore';
import { ConsoleStore, ConsoleSaved } from './consoleStore';
import { Sessions } from './sessions';
import { Statement, StatementInfo, classify, changesData } from './sql/statements';
import { BindInput, bindValuesFor, toDriverSql } from './sql/binds';
import { MAX_ROWS_LIMIT, ResultView } from './ui/resultView';
import { FormActions, FormDialog, DialogMessage } from './ui/formDialog';

/** 콘솔 화면(Webview 패널)의 종류 — package.json 의 단축키 조건(activeWebviewPanelId)과 같아야 한다 */
export const CONSOLE_VIEW_TYPE = 'devBoostDbConsole';

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}초`;
const firstLine = (sql: string) => {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
};

/** 화면이 보내는 문장: 편집기 안의 자리, 시작 줄 번호(1부터), 쿼리 아래 결과를 붙일 표시(key) */
type Target = Statement & { line: number; key: string };
type Params = Record<string, BindInput>;

type FromWebview =
  | { type: 'ready' }
  | { type: 'save'; sql: string; params: Params; confirmEach: boolean }
  | { type: 'run'; statements: Target[]; params: Params }
  | { type: 'explain'; statements: Target[]; params: Params }
  | { type: 'commit' }
  | { type: 'rollback' }
  | { type: 'connect' }
  | { type: 'more'; resultId: number; all?: boolean }
  | { type: 'limits'; pageSize: number; maxRows: number }
  | { type: 'toPanel'; resultId: number }
  | { type: 'copy'; text: string }
  | { type: 'copyInsert'; resultId: number }
  | { type: 'csv'; resultId: number }
  | { type: 'serverOutput'; on: boolean }
  | DialogMessage;

/** 쿼리 아래에 붙는 결과 하나 (화면이 그린다) */
type Inline =
  | { status: 'rows'; resultId: number; columns: { name: string; type: string; numeric: boolean }[]; rows: (string | null)[][]; done: boolean; capped: boolean; ms: number; output?: string[] }
  | { status: 'done'; text: string; ms: number; output?: string[] }
  | { status: 'error'; text: string; output?: string[] }
  | { status: 'plan'; lines: string[]; ms: number }
  | { status: 'cancel'; text: string }
  | { status: 'skip'; text: string };

export interface ConsoleDeps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  consoles: ConsoleStore;
  sessions: Sessions;
  results: ResultView;
  formActions: FormActions;
  /** 접속돼 있지 않으면 접속한다 (비밀번호를 묻는 것까지). 실패·취소면 undefined */
  ensureSession(cfg: DbConnectionConfig): Promise<DbSession | undefined>;
  /** 연결을 고르게 한다 */
  pickConnection(title: string): Promise<DbConnectionConfig | undefined>;
  /** 그 연결의 테이블 이름들 (자동 완성용). 모르면 [] */
  tableNames(connectionId: string): string[];
}

/** 콘솔 탭 하나 (연결 하나에 하나. 연결을 아직 정하지 않은 빈 콘솔도 있다 — 연결 추가 팝업을 띄우는 자리) */
interface ConsoleTab {
  panel: vscode.WebviewPanel;
  connectionId: string | undefined;
  ready: boolean;
  /** 화면이 준비되기 전에 보내려던 메시지 */
  queue: unknown[];
  dialog?: FormDialog;
  /** 서버 출력을 켜 두었는지 (기억해 둔 값. 접속할 때 맞춘다) */
  serverOutput: boolean;
}

/**
 * 쿼리 콘솔: 실행 도구 줄 · 파라미터 줄 · SQL 편집기를 한 화면(Webview)에 그린다.
 * 결과·실행계획은 실행한 문장 바로 아래(편집기 안)에 낸다. 하단 패널 "DB 결과"에도 쌓아 두지만 열지는 않는다
 * (크게 보거나 기록을 볼 때 사용자가 연다. 쿼리 아래의 "패널" 버튼은 그 결과를 패널에서 보여 준다).
 *  - 연결마다 콘솔 하나. 쓰던 SQL·파라미터 값은 연결별 파일로 기억한다
 *  - Ctrl+Enter: 선택 영역의 문장들, 없으면 커서가 있는 문장. Ctrl+E: 실행계획
 *  - 자동 커밋하지 않는다. 변경한 문장 수를 "커밋 안 한 변경 N건"으로 보여 주고 커밋·롤백으로 확정한다
 *  - 안전장치: 읽기 전용 연결은 조회만, WHERE 없는 UPDATE·DELETE 와 운영 DB 변경은 실행 전에 확인
 *  - 한 DB에만 있는 기능(Oracle 서버 출력)은 그 DB 접속일 때만 화면에 나온다
 */
export class DbConsole implements vscode.Disposable {
  private readonly tabs = new Set<ConsoleTab>();
  /** 연결 id → 커밋하지 않은 변경 문장 수 */
  private readonly dirty = new Map<string, number>();
  /** 사용자가 실행 중인 연결 (실행을 두 번 겹쳐 누르지 않게. 트리 읽기 같은 일은 줄을 서서 기다린다) */
  private readonly running = new Set<string>();
  /** 결과 탭 id → 그 결과를 쿼리 아래에 보여 주는 콘솔 */
  private readonly owners = new Map<number, ConsoleTab>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: ConsoleDeps) {
    deps.results.fetchMore = (connectionId, cursor, count) => this.fetchMore(connectionId, cursor, count);
    deps.results.setLimits(pageSize(), maxRows());
    this.subs.push(
      // 접속이 닫히면(끊김 포함) 그 접속의 변경은 롤백된 것이고, 열어 둔 커서도 못 쓴다
      deps.sessions.onDidChange(() => {
        for (const id of [...this.dirty.keys()]) if (!deps.sessions.isConnected(id)) this.dirty.delete(id);
        for (const tab of this.tabs) void this.syncServerOutput(tab);
        this.refresh();
      }),
      deps.sessions.onDidLose(({ id }) => deps.results.dropConnection(id)),
      deps.store.onDidChange(() => {
        // 지운 연결의 콘솔은 닫고, 이름이 바뀐 연결은 탭 제목을 맞춘다
        for (const tab of [...this.tabs]) {
          if (!tab.connectionId) continue;
          const cfg = deps.store.get(tab.connectionId);
          if (!cfg) tab.panel.dispose();
          else tab.panel.title = `${cfg.name}.sql`;
        }
        this.refresh();
      }),
      // 패널이나 쿼리 아래 어느 쪽에서 더 가져왔든 양쪽을 맞춘다
      deps.results.onDidAppend((a) => {
        const tab = this.owners.get(a.id);
        if (tab) this.post(tab, { type: 'inlineAppend', ...a });
      }),
      deps.results.onDidDrop((ids) => {
        const byTab = new Map<ConsoleTab, number[]>();
        for (const id of ids) {
          const tab = this.owners.get(id);
          this.owners.delete(id);
          if (tab) byTab.set(tab, [...(byTab.get(tab) ?? []), id]);
        }
        for (const [tab, list] of byTab) this.post(tab, { type: 'inlineDropped', ids: list });
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devBoost.dbConsole.pageSize') || e.affectsConfiguration('devBoost.dbConsole.maxRows')) this.sendLimits();
      })
    );
  }

  /** 한 번에 가져올 행 수·최대 행 수를 결과 패널과 모든 콘솔에 알린다 */
  private sendLimits() {
    const limits = { pageSize: pageSize(), maxRows: maxRows() };
    this.deps.results.setLimits(limits.pageSize, limits.maxRows);
    for (const tab of this.tabs) this.post(tab, { type: 'limits', ...limits });
  }

  dispose() {
    this.subs.forEach((d) => d.dispose());
    for (const tab of [...this.tabs]) tab.panel.dispose();
  }

  /** 이 연결에 커밋하지 않은 변경이 있는가 (끊기 전에 물어보려고) */
  isDirty(connectionId: string): boolean {
    return (this.dirty.get(connectionId) ?? 0) > 0;
  }

  private activeTab(): ConsoleTab | undefined {
    return [...this.tabs].find((t) => t.panel.active);
  }

  private post(tab: ConsoleTab, msg: unknown) {
    if (tab.ready) void tab.panel.webview.postMessage(msg);
    else tab.queue.push(msg);
  }

  /** 모든 콘솔의 도구 줄(연결 상태·커밋 안 한 변경·실행 중)을 지금 상태에 맞춘다 */
  refresh() {
    for (const tab of this.tabs) this.sendStatus(tab);
  }

  private sendStatus(tab: ConsoleTab) {
    const cfg = tab.connectionId ? this.deps.store.get(tab.connectionId) : undefined;
    const s = cfg && this.deps.sessions.get(cfg.id);
    this.post(tab, {
      type: 'status',
      name: cfg?.name,
      kind: cfg ? kindOf(cfg) : undefined,
      product: s?.info.product,
      schema: s?.info.schema,
      connected: !!s,
      connecting: !!cfg && this.deps.sessions.isConnecting(cfg.id),
      busy: !!cfg && this.running.has(cfg.id),
      dirty: cfg ? (this.dirty.get(cfg.id) ?? 0) : 0,
      readOnly: !!cfg?.readOnly,
      production: !!cfg?.production,
      // 그 DB에만 있는 기능: 접속이 내놓을 때만 화면에 보인다
      features: { serverOutput: !!s?.connection.extras.output },
      serverOutput: tab.serverOutput,
    });
  }

  /** 그 연결의 테이블 이름을 콘솔에 알린다 (자동 완성) */
  sendTables(connectionId: string) {
    for (const tab of this.tabs) if (tab.connectionId === connectionId) this.post(tab, { type: 'tables', names: this.deps.tableNames(connectionId) });
  }

  /** 연결의 콘솔을 연다. 이미 열려 있으면 그 탭으로 간다 */
  open(cfg: DbConnectionConfig): ConsoleTab {
    const have = [...this.tabs].find((t) => t.connectionId === cfg.id);
    if (have) {
      have.panel.reveal(undefined, false);
      return have;
    }
    // 연결을 아직 정하지 않은 빈 콘솔이 있으면 그것을 쓴다
    const blank = [...this.tabs].find((t) => !t.connectionId);
    const tab = blank ?? this.create();
    void this.bind(tab, cfg);
    tab.panel.reveal(undefined, false);
    void this.deps.ensureSession(cfg); // 쓰는 동안 미리 접속해 둔다
    return tab;
  }

  private create(): ConsoleTab {
    const { context } = this.deps;
    const panel = vscode.window.createWebviewPanel(CONSOLE_VIEW_TYPE, 'DB 콘솔', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'dbConsole')],
    });
    panel.iconPath = new vscode.ThemeIcon('database');
    const tab: ConsoleTab = { panel, connectionId: undefined, ready: false, queue: [], serverOutput: false };
    this.tabs.add(tab);
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(tab, m).catch((e) => this.fail(tab, e)));
    panel.onDidDispose(() => {
      tab.dialog?.cancel();
      this.tabs.delete(tab);
      for (const [id, owner] of [...this.owners]) if (owner === tab) this.owners.delete(id);
      this.warnUncommitted(tab.connectionId);
    });
    return tab;
  }

  /**
   * 콘솔을 닫았는데 커밋하지 않은 변경이 남아 있으면 알린다.
   * 접속은 열려 있으므로 여기서 커밋·롤백할 수 있다 (닫는 것 자체는 막을 수 없다)
   */
  private warnUncommitted(connectionId: string | undefined) {
    if (!connectionId || !this.isDirty(connectionId)) return;
    const cfg = this.deps.store.get(connectionId);
    if (!cfg) return;
    const commit = '커밋';
    const rollback = '롤백';
    void vscode.window
      .showWarningMessage(`${cfg.name} 에 커밋하지 않은 변경 ${this.dirty.get(connectionId)}건이 남아 있습니다.`, commit, rollback)
      .then((b) => {
        if (b === commit || b === rollback) void this.endTransaction(cfg, b === commit ? 'commit' : 'rollback');
      });
  }

  /** 콘솔에 연결을 정하고 기억해 둔 SQL·파라미터를 불러온다 */
  private async bind(tab: ConsoleTab, cfg: DbConnectionConfig) {
    tab.connectionId = cfg.id;
    tab.panel.title = `${cfg.name}.sql`;
    const saved = await this.deps.consoles.load(cfg.id);
    tab.serverOutput = !!saved?.serverOutput;
    this.post(tab, {
      type: 'init',
      kind: kindOf(cfg),
      sql: saved?.sql ?? '',
      params: saved?.params ?? {},
      confirmEach: saved?.confirmEach ?? true,
      limits: { pageSize: pageSize(), maxRows: maxRows() },
    });
    this.post(tab, { type: 'tables', names: this.deps.tableNames(cfg.id) });
    this.sendStatus(tab);
    void this.syncServerOutput(tab);
  }

  /** 기억해 둔 서버 출력 켬·끔을 접속에 맞춘다 (그 기능이 있는 DB일 때만) */
  private async syncServerOutput(tab: ConsoleTab) {
    const s = tab.connectionId ? this.deps.sessions.get(tab.connectionId) : undefined;
    const out = s?.connection.extras.output;
    if (!s || !out || out.enabled === tab.serverOutput) return;
    try {
      await s.use(() => out.setEnabled(tab.serverOutput));
    } catch (e) {
      this.fail(tab, e);
    }
  }

  /** 연결 추가 팝업: 보고 있는 콘솔 위에 띄운다. 콘솔이 없으면 빈 콘솔을 열어 그 위에 */
  showAddDialog() {
    const tab = this.activeTab() ?? [...this.tabs][0] ?? this.create();
    tab.panel.reveal(undefined, false);
    this.openDialog(tab);
  }

  /** 연결 수정 팝업: 그 연결의 콘솔 위에 띄운다 */
  showEditDialog(cfg: DbConnectionConfig, hasSavedPassword: boolean) {
    const tab = this.open(cfg);
    this.openDialog(tab, cfg, hasSavedPassword);
  }

  private openDialog(tab: ConsoleTab, existing?: DbConnectionConfig, hasSavedPassword = false) {
    tab.dialog?.cancel();
    tab.dialog = new FormDialog((m) => this.post(tab, m), this.deps.formActions, existing, hasSavedPassword);
    tab.dialog.open();
  }

  /** 단축키·명령: 보고 있는 콘솔에서 실행 / 실행계획 / 지금 문장 고르기 */
  trigger(what: 'run' | 'explain' | 'selectStatement') {
    const tab = this.activeTab();
    if (tab) this.post(tab, { type: 'do', what });
  }

  /**
   * 그 연결의 콘솔에 글을 넣는다.
   *  - 기본: 커서 자리에 (트리에서 테이블 이름을 누를 때)
   *  - asBlock: 글 끝에 새 문단으로 넣고 고른다 (트리에서 만든 SELECT·JOIN). run 이면 이어서 실행
   */
  insertText(connectionId: string, text: string, opts: { asBlock?: boolean; run?: boolean } = {}) {
    const cfg = this.deps.store.get(connectionId);
    if (!cfg) return;
    this.post(this.open(cfg), { type: 'insert', text, asBlock: !!opts.asBlock, run: !!opts.run });
  }

  private fail(tab: ConsoleTab, e: unknown) {
    const cfg = tab.connectionId ? this.deps.store.get(tab.connectionId) : undefined;
    const text = cfg ? driverFor(cfg).errors.explain(e) : String((e as Error)?.message ?? e);
    this.deps.results.addLog({ kind: 'error', text, connectionName: cfg?.name ?? 'DB 콘솔' });
  }

  private async onMessage(tab: ConsoleTab, m: FromWebview) {
    switch (m.type) {
      case 'ready':
        tab.ready = true;
        for (const q of tab.queue.splice(0)) void tab.panel.webview.postMessage(q);
        this.sendStatus(tab);
        return;
      case 'save':
        if (tab.connectionId) {
          const saved: ConsoleSaved = { sql: m.sql, params: m.params, confirmEach: m.confirmEach, serverOutput: tab.serverOutput };
          await this.deps.consoles.save(tab.connectionId, saved);
        }
        return;
      case 'connect': {
        const cfg = tab.connectionId ? this.deps.store.get(tab.connectionId) : undefined;
        if (cfg) await this.deps.ensureSession(cfg);
        return;
      }
      case 'run':
        return this.run(tab, m.statements, m.params);
      case 'explain':
        return this.explain(tab, m.statements[0], m.params);
      case 'commit':
      case 'rollback': {
        const cfg = tab.connectionId ? this.deps.store.get(tab.connectionId) : undefined;
        if (cfg) await this.endTransaction(cfg, m.type, tab);
        return;
      }
      case 'more':
        try {
          await this.deps.results.more(m.resultId, !!m.all);
        } catch (e) {
          this.post(tab, { type: 'inlineMoreFailed', resultId: m.resultId, message: String((e as Error)?.message ?? e).split('\n')[0] });
        }
        return;
      case 'toPanel':
        await this.deps.results.showTab(m.resultId);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('복사했습니다', 2000);
        return;
      case 'copyInsert':
        await this.deps.results.copyAsInsert(m.resultId);
        return;
      case 'limits': {
        // 도구 줄의 행 수 칸 → 설정 (모든 콘솔·패널에 같이 적용)
        const cfg = vscode.workspace.getConfiguration('devBoost.dbConsole');
        await cfg.update('pageSize', clamp(m.pageSize, 10, 5000, 500), vscode.ConfigurationTarget.Global);
        await cfg.update('maxRows', clamp(m.maxRows, 100, MAX_ROWS_LIMIT, 10_000), vscode.ConfigurationTarget.Global);
        return;
      }
      case 'csv':
        await this.deps.results.exportCsv(m.resultId);
        return;
      case 'serverOutput':
        tab.serverOutput = m.on;
        await this.syncServerOutput(tab);
        this.sendStatus(tab);
        return;
      default: {
        // 연결 팝업
        const r = await tab.dialog?.onMessage(m);
        if (!r) return;
        tab.dialog = undefined;
        if (r.done === 'saved' && !tab.connectionId) await this.bind(tab, r.config); // 빈 콘솔이면 방금 만든 연결의 콘솔이 된다
        else if (r.done === 'cancelled' && !tab.connectionId) tab.panel.dispose(); // 팝업만 띄우려고 연 빈 콘솔은 닫는다
      }
    }
  }

  /** 실행할 준비: 연결·접속·겹침 확인. 안 되면 undefined */
  private async prepare(tab: ConsoleTab): Promise<{ cfg: DbConnectionConfig; session: DbSession } | undefined> {
    const cfg = tab.connectionId ? this.deps.store.get(tab.connectionId) : undefined;
    if (!cfg) return undefined;
    if (this.running.has(cfg.id)) {
      this.post(tab, { type: 'hint', message: '다른 쿼리를 실행하는 중입니다. 끝난 뒤에 다시 실행하세요.' });
      return undefined;
    }
    const session = await this.deps.ensureSession(cfg);
    if (!session) return undefined;
    return { cfg, session };
  }

  /** 쿼리 아래 결과를 화면에 보낸다 */
  private inline(tab: ConsoleTab, key: string, result: Inline) {
    this.post(tab, { type: 'inline', key, result });
  }

  private async run(tab: ConsoleTab, statements: Target[], params: Params) {
    const cfg0 = tab.connectionId ? this.deps.store.get(tab.connectionId) : undefined;
    if (!cfg0 || !statements.length) return;
    const rules = driverFor(cfg0).rules;
    const infos = statements.map((s) => classify(s.sql, rules));
    const cancelAll = (why: string) => statements.forEach((s) => this.inline(tab, s.key, { status: 'skip', text: why }));
    if (!(await this.confirmSafe(cfg0, statements, infos))) return cancelAll('실행하지 않았습니다');
    const ready = await this.prepare(tab);
    if (!ready) return cancelAll('실행하지 않았습니다');
    const { cfg, session } = ready;

    const { results } = this.deps;
    results.setLimits(pageSize(), maxRows());
    results.beginRun();

    this.running.add(cfg.id);
    this.refresh();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${cfg.name}: 실행 중…`, cancellable: true },
        async (progress, token) => {
          let cancelled = false;
          token.onCancellationRequested(() => {
            cancelled = true;
            void session.connection.cancel().catch(() => undefined);
          });
          for (let i = 0; i < statements.length; i++) {
            const st = statements[i];
            if (cancelled) {
              this.inline(tab, st.key, { status: 'skip', text: '취소해서 실행하지 않았습니다' });
              continue;
            }
            if (statements.length > 1) progress.report({ message: `${i + 1} / ${statements.length}` });
            const binds = bindValuesFor(st.sql, params, rules);
            if (!binds.ok) {
              const text = `파라미터 값이 맞지 않습니다: ${binds.message}`;
              results.addLog({ kind: 'error', text, sql: firstLine(st.sql), connectionName: cfg.name });
              this.inline(tab, st.key, { status: 'error', text });
              statements.slice(i + 1).forEach((s) => this.inline(tab, s.key, { status: 'skip', text: '앞 문장이 실패해 실행하지 않았습니다' }));
              break;
            }
            try {
              const r = await session.use((c) => c.execute(toDriverSql(st.sql, rules), binds.values, results.pageSize));
              const output = await this.readOutput(session);
              this.afterRun(tab, cfg, st, infos[i], r, output);
            } catch (e) {
              const output = await this.readOutput(session).catch(() => undefined);
              this.runFailed(tab, cfg, st, e, cancelled, output);
              statements.slice(i + 1).forEach((s) => this.inline(tab, s.key, { status: 'skip', text: '앞 문장이 실패해 실행하지 않았습니다' }));
              break; // 뒤 문장은 실행하지 않는다
            }
          }
        }
      );
    } finally {
      this.running.delete(cfg.id);
      this.refresh();
    }
  }

  /** 서버 출력(켜 두었고 그 DB에 있을 때만). 꺼낸 줄은 메시지 기록에도 남긴다 */
  private async readOutput(session: DbSession): Promise<string[] | undefined> {
    const out = session.connection.extras.output;
    if (!out?.enabled) return undefined;
    const lines = await session.use(() => out.read());
    return lines.length ? lines : undefined;
  }

  /** 실행 오류: 메시지·쿼리 아래에 남기고, 난 자리를 알면 커서를 옮긴다. 접속이 끊겨서 난 오류면 목록에서도 뺀다 (Sessions 가 알림) */
  private runFailed(tab: ConsoleTab, cfg: DbConnectionConfig, st: Target, e: unknown, cancelled: boolean, output?: string[]) {
    const errors = driverFor(cfg).errors;
    const lost = this.deps.sessions.reportError(cfg.id, e);
    const wasCancel = cancelled || errors.isCancel(e);
    const off = errors.offset(e);
    // 드라이버에 보낸 SQL 은 #{name} → :name 으로 길이가 달라질 수 있어, 줄 번호는 원문 기준으로 대략 맞춘다
    const line = st.line + (off !== undefined ? st.sql.slice(0, off).split('\n').length - 1 : 0);
    const text = wasCancel ? '취소했습니다' : `${errors.explain(e)} (${line}번째 줄)`;
    this.deps.results.addLog({ kind: wasCancel ? 'info' : 'error', text, sql: firstLine(st.sql), connectionName: cfg.name });
    this.logOutput(cfg, output);
    this.inline(tab, st.key, wasCancel ? { status: 'cancel', text } : { status: 'error', text, output });
    if (!wasCancel && !lost && off !== undefined) this.post(tab, { type: 'cursor', pos: st.start + off });
  }

  private logOutput(cfg: DbConnectionConfig, output: string[] | undefined) {
    if (output?.length) this.deps.results.addLog({ kind: 'output', text: output.join('\n'), connectionName: cfg.name });
  }

  /** 실행 결과를 패널·쿼리 아래에 넣고, 커밋할 것이 생겼는지 기록한다 */
  private afterRun(tab: ConsoleTab, cfg: DbConnectionConfig, st: Target, info: StatementInfo, r: RunResult, output: string[] | undefined) {
    const { results } = this.deps;
    const sql = firstLine(st.sql);
    const addDirty = () => this.dirty.set(cfg.id, (this.dirty.get(cfg.id) ?? 0) + 1);
    this.logOutput(cfg, output);
    if (r.kind === 'rows') {
      const resultId = results.addRows({ sql: st.sql, connectionId: cfg.id, columns: r.columns, rows: r.page.rows, done: r.page.done, ms: r.ms, cursor: r.cursor });
      this.owners.set(resultId, tab);
      const n = r.page.rows.length.toLocaleString('ko-KR');
      results.addLog({ kind: 'ok', text: `${n}행${r.page.done ? '' : ' (더 있음)'} · ${seconds(r.ms)}`, sql, connectionName: cfg.name });
      if (info.forUpdate) addDirty(); // 행을 잠갔다 → 커밋·롤백으로 풀어야 한다
      this.inline(tab, st.key, {
        status: 'rows',
        resultId,
        columns: r.columns,
        rows: r.page.rows,
        done: r.page.done,
        capped: !r.page.done && r.page.rows.length >= results.maxRows,
        ms: r.ms,
        output,
      });
      return;
    }
    if ((info.kind === 'tx' && info.verb !== 'SAVEPOINT') || info.kind === 'ddl') {
      this.dirty.delete(cfg.id); // 직접 친 COMMIT·ROLLBACK, 또는 DDL (오라클은 DDL 을 실행하면서 그 앞의 변경까지 커밋한다)
    } else if (!(r.kind === 'count' && r.rowsAffected === 0)) {
      addDirty(); // DML·PL/SQL·그 밖: 바뀐 것이 있을 수 있다 (0행 변경은 세지 않는다)
    }
    const what =
      r.kind === 'count'
        ? `${r.rowsAffected.toLocaleString('ko-KR')}행 ${info.verb === 'INSERT' ? '추가됨' : info.verb === 'DELETE' ? '삭제됨' : '변경됨'}`
        : info.kind === 'ddl'
          ? '실행됨 (DDL — 자동으로 커밋됩니다)'
          : '실행됨';
    const pending = this.isDirty(cfg.id) && info.kind !== 'tx' ? ' · 아직 커밋하지 않음' : '';
    results.addLog({ kind: 'ok', text: `${what} · ${seconds(r.ms)}${pending}`, sql, connectionName: cfg.name });
    this.inline(tab, st.key, { status: 'done', text: `${what}${pending}`, ms: r.ms, output });
  }

  /** 실행계획 (문장을 실제로 실행하지는 않는다) */
  private async explain(tab: ConsoleTab, st: Target | undefined, params: Params) {
    if (!st) return;
    const ready = await this.prepare(tab);
    if (!ready) return this.inline(tab, st.key, { status: 'skip', text: '실행하지 않았습니다' });
    const { cfg, session } = ready;
    const { results } = this.deps;
    const rules = session.driver.rules;
    const binds = bindValuesFor(st.sql, params, rules);
    if (!binds.ok) {
      const text = `파라미터 값이 맞지 않습니다: ${binds.message}`;
      results.addLog({ kind: 'error', text, sql: firstLine(st.sql), connectionName: cfg.name });
      this.inline(tab, st.key, { status: 'error', text });
      return;
    }
    this.running.add(cfg.id);
    this.refresh();
    try {
      const started = Date.now();
      const lines = await session.use((c) => c.explain(toDriverSql(st.sql, rules), binds.values));
      const ms = Date.now() - started;
      results.setPlan({ sql: st.sql, lines, ms });
      this.inline(tab, st.key, { status: 'plan', lines, ms });
      results.addLog({ kind: 'ok', text: `실행계획 · ${seconds(ms)}`, sql: firstLine(st.sql), connectionName: cfg.name });
    } catch (e) {
      this.runFailed(tab, cfg, st, e, false);
    } finally {
      this.running.delete(cfg.id);
      this.refresh();
    }
  }

  /**
   * 실행 전 확인. 막거나 사용자가 취소하면 false
   *  - 읽기 전용 연결: 조회가 아닌 문장은 실행하지 않는다
   *  - WHERE 없는 UPDATE·DELETE: 테이블 전체가 바뀐다고 알리고 확인
   *  - 운영 DB 에서 조회가 아닌 문장: 확인
   */
  private async confirmSafe(cfg: DbConnectionConfig, statements: Statement[], infos: StatementInfo[]): Promise<boolean> {
    const changing = statements.filter((_, i) => changesData(infos[i]));
    if (cfg.readOnly && changing.length) {
      void vscode.window.showErrorMessage(`${cfg.name} 은 읽기 전용 연결이라 조회만 실행합니다: ${firstLine(changing[0].sql)}`);
      return false;
    }
    const noWhere = statements.filter((_, i) => infos[i].noWhere);
    if (noWhere.length) {
      const go = '전체 행에 실행';
      const answer = await vscode.window.showWarningMessage(
        `WHERE 가 없습니다. 테이블의 모든 행이 바뀝니다.\n\n${noWhere.map((s) => firstLine(s.sql)).join('\n')}`,
        { modal: true },
        go
      );
      if (answer !== go) return false;
    }
    if (cfg.production && changing.length) {
      const go = '운영 DB 에 실행';
      const answer = await vscode.window.showWarningMessage(
        `운영 DB "${cfg.name}" 의 데이터나 구조를 바꾸는 문장입니다.\n\n${changing.map((s) => firstLine(s.sql)).join('\n')}`,
        { modal: true },
        go
      );
      if (answer !== go) return false;
    }
    return true;
  }

  /** "다음 행 가져오기" (패널·쿼리 아래 어느 쪽에서든) */
  private async fetchMore(connectionId: string, cursor: RowCursor, count: number) {
    const session = this.deps.sessions.get(connectionId);
    if (!session) throw new Error('접속이 끊겨 더 가져올 수 없습니다. 쿼리를 다시 실행하세요.');
    if (this.running.has(connectionId)) throw new Error('다른 쿼리를 실행하는 중입니다. 끝난 뒤에 다시 누르세요.');
    try {
      return await session.use(() => cursor.next(count));
    } catch (e) {
      this.deps.sessions.reportError(connectionId, e);
      throw new Error(session.driver.errors.explain(e));
    }
  }

  /** 명령 팔레트에서 부른 커밋·롤백: 보고 있는 콘솔의 연결 */
  async commit() {
    const cfg = this.activeConfig();
    if (cfg) await this.endTransaction(cfg, 'commit', this.activeTab());
  }

  async rollback() {
    const cfg = this.activeConfig();
    if (cfg) await this.endTransaction(cfg, 'rollback', this.activeTab());
  }

  private activeConfig(): DbConnectionConfig | undefined {
    const id = this.activeTab()?.connectionId;
    return id ? this.deps.store.get(id) : undefined;
  }

  private async endTransaction(cfg: DbConnectionConfig, what: 'commit' | 'rollback', tab?: ConsoleTab) {
    const label = what === 'commit' ? '커밋' : '롤백';
    const hint = (message: string) => (tab ? this.post(tab, { type: 'hint', message }) : void vscode.window.showInformationMessage(message));
    const session = this.deps.sessions.get(cfg.id);
    if (!session) return hint(`접속돼 있지 않아 ${label}할 것이 없습니다.`);
    if (this.running.has(cfg.id)) return hint(`쿼리를 실행하는 중입니다. 끝난 뒤에 ${label}하세요.`);
    try {
      await session.use((c) => (what === 'commit' ? c.commit() : c.rollback()));
      this.dirty.delete(cfg.id);
      this.deps.results.addLog({ kind: 'ok', text: `${label}했습니다`, connectionName: cfg.name });
      vscode.window.setStatusBarMessage(`${cfg.name}: ${label}했습니다`, 4000);
    } catch (e) {
      const text = session.driver.errors.explain(e);
      this.deps.sessions.reportError(cfg.id, e);
      this.deps.results.addLog({ kind: 'error', text: `${label} 실패: ${text}`, connectionName: cfg.name });
      void vscode.window.showErrorMessage(`${cfg.name} ${label} 실패: ${text}`);
    }
    this.refresh();
  }

  private html(wv: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.deps.context.extensionUri, 'media', 'dbConsole');
    const js = wv.asWebviewUri(vscode.Uri.joinPath(base, 'console.js'));
    const grid = wv.asWebviewUri(vscode.Uri.joinPath(base, 'grid.css'));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(base, 'console.css'));
    const nonce = randomBytes(16).toString('base64');
    // 편집기(CodeMirror)가 실행 중에 <style> 을 넣으므로 스타일에도 nonce 를 허용한다
    // data-vscode-context: 오른쪽 클릭 메뉴(webview/context)에 콘솔 명령을 붙이고, 잘라내기·복사·붙여넣기는 그대로 둔다
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<link rel="stylesheet" href="${grid}">
<title>DB 콘솔</title></head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div class="toolbar">
  <button type="button" id="run" class="primary" title="커서가 있는 문장 실행 (선택 영역이 있으면 그 안의 문장들)">
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M1 0.5 L9 5 L1 9.5 Z" fill="currentColor"/></svg>실행
  </button>
  <button type="button" id="explain" title="커서가 있는 문장의 실행계획 (실제로 실행하지는 않습니다)">
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 1.5 V10.5 M2 4 H6 M2 8.5 H6"/><rect x="6.5" y="2.5" width="4" height="3"/><rect x="6.5" y="7" width="4" height="3"/></svg>실행계획
  </button>
  <span id="hint" class="hint" role="status"></span>
  <span class="spacer"></span>
  <label class="check hidden" id="outputBox" title="DBMS_OUTPUT.PUT_LINE 으로 찍은 줄을 결과와 함께 보여 줍니다"><input type="checkbox" id="serverOutput"> 서버 출력</label>
  <button type="button" id="conn" class="chip hidden"><span class="dot" aria-hidden="true"></span><span id="connText"></span></button>
  <span id="dirty" class="chip dirty hidden"><span class="dot" aria-hidden="true"></span><span id="dirtyText"></span></span>
  <button type="button" id="commit">커밋</button>
  <button type="button" id="rollback">롤백</button>
</div>
<div class="params">
  <span class="title">파라미터</span>
  <span id="paramList"></span>
  <button type="button" id="addParam">+ 파라미터</button>
  <span class="spacer"></span>
  <label class="check hidden" id="confirmBox" title="파라미터가 있는 문장을 실행하면 먼저 값 칸으로 커서를 옮깁니다. 값을 보고 Enter(또는 실행을 한 번 더)를 누르면 실행합니다"><input type="checkbox" id="confirmEach" checked> 실행 전 값 확인</label>
  <label class="limit" title="조회 결과를 한 번에 가져오는 행 수 (10~5,000)">한 번에 <input type="number" id="pageSize" min="10" max="5000" step="100">행</label>
  <label class="limit" title="한 결과에 가져오는 최대 행 수 (100~200,000). '끝까지'도 여기까지만">최대 <input type="number" id="maxRows" min="100" max="200000" step="1000">행</label>
</div>
<div id="editor" data-vscode-context='{"webviewSection": "editor", "preventDefaultContextMenuItems": false}'></div>

<div class="overlay hidden" id="overlay">
  <form class="dialog" id="dialog" role="dialog" aria-modal="true" aria-labelledby="d-title" autocomplete="off" novalidate>
    <div class="dialog-head">
      <h1 id="d-title">DB 연결 추가</h1>
      <div class="right">
        <a href="#" id="d-urlToggle">JDBC URL로 입력</a>
        <button type="button" id="d-close" class="icon-btn" aria-label="닫기">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 2 L12 12 M12 2 L2 12"/></svg>
        </button>
      </div>
    </div>
    <div class="fld hidden" id="d-urlRow">
      <label for="d-url">JDBC URL</label>
      <input id="d-url" type="text" spellcheck="false" placeholder="jdbc:oracle:thin:@//10.0.0.5:1521/ORCLPDB1">
      <div class="error" id="d-urlError"></div>
    </div>
    <div class="fld">
      <label for="d-name">이름</label>
      <input id="d-name" type="text" spellcheck="false">
      <div class="error" data-for="name"></div>
    </div>
    <div class="cols-host">
      <div class="fld"><label for="d-host">호스트</label><input id="d-host" type="text" spellcheck="false"><div class="error" data-for="host"></div></div>
      <div class="fld"><label for="d-port">포트</label><input id="d-port" type="text" spellcheck="false" inputmode="numeric"><div class="error" data-for="port"></div></div>
    </div>
    <div class="cols-kind">
      <div class="fld">
        <label for="d-kind">접속 방식</label>
        <select id="d-kind"><option value="service">서비스 이름</option><option value="sid">SID</option><option value="raw">연결 문자열</option></select>
      </div>
      <div class="fld">
        <label for="d-target" id="d-targetLabel">서비스 이름</label>
        <input id="d-target" type="text" spellcheck="false">
        <textarea id="d-targetRaw" class="hidden" rows="3" spellcheck="false" aria-labelledby="d-targetLabel" placeholder="(DESCRIPTION=(ADDRESS=…)(CONNECT_DATA=(SERVICE_NAME=…)))"></textarea>
        <div class="error" data-for="target"></div>
      </div>
    </div>
    <div class="cols-2">
      <div class="fld"><label for="d-user">사용자</label><input id="d-user" type="text" spellcheck="false"><div class="error" data-for="user"></div></div>
      <div class="fld"><label for="d-password">비밀번호</label><input id="d-password" type="password"><div class="error" data-for="password"></div></div>
    </div>
    <div class="checks">
      <label class="check"><input type="checkbox" id="d-savePassword"> 비밀번호 저장</label>
      <label class="check"><input type="checkbox" id="d-readOnly"> 읽기 전용</label>
      <label class="check"><input type="checkbox" id="d-production"> 운영 DB</label>
    </div>
    <div class="dialog-foot">
      <button type="button" id="d-test">접속 테스트</button>
      <span class="spacer"></span>
      <button type="button" id="d-cancel">취소</button>
      <button type="submit" id="d-save" class="primary">저장</button>
      <span id="d-testResult" class="test-result" role="status"></span>
    </div>
  </form>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}

const clamp = (n: unknown, min: number, max: number, fallback: number) => Math.min(max, Math.max(min, Math.floor(Number(n)) || fallback));

/** 한 번에 가져올 행 수 (설정 devBoost.dbConsole.pageSize, 10~5000) */
function pageSize(): number {
  return clamp(vscode.workspace.getConfiguration('devBoost.dbConsole').get<number>('pageSize', 500), 10, 5000, 500);
}

/** 한 결과에 싣는 최대 행 수 (설정 devBoost.dbConsole.maxRows) */
function maxRows(): number {
  return clamp(vscode.workspace.getConfiguration('devBoost.dbConsole').get<number>('maxRows', 10_000), 100, MAX_ROWS_LIMIT, 10_000);
}
