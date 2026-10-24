import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { MapperDoc, MapperStatement, parseMapper } from '../mapper/mapperDoc';
import { BranchOverride } from '../mapper/render';
import { ParamInput, ParamType } from '../mapper/values';
import { MapperIndex } from '../mapperIndex';
import { OracleBridge } from '../oracleBridge';
import { RunnerStore, Prepared } from '../store';

/**
 * SQL 실행 화면 (Webview). 한 번에 하나만 띄우고, 다른 쿼리에서 열면 같은 화면이 그 쿼리로 바뀐다.
 *
 * 화면 → 확장: ready | input{path,type,value} | override{key,state} | overrideAll{state} | mode{mode}
 *              | clear | copy | send{action: run|insert|explain} | reveal{file,line}
 * 확장 → 화면: state{…} | notice{text,kind}
 */
export class RunnerPanel {
  private static current: RunnerPanel | undefined;

  private uri: vscode.Uri;
  private stmtId: string;
  private last: Prepared | undefined;
  private lastDoc: MapperDoc | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly dimmed: vscode.TextEditorDecorationType;

  static show(context: vscode.ExtensionContext, deps: Deps, uri: vscode.Uri, stmtId: string) {
    if (RunnerPanel.current) {
      const c = RunnerPanel.current;
      c.uri = uri;
      c.stmtId = stmtId;
      c.panel.reveal(undefined, true);
      c.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'devBoostMybatisRunner',
      'SQL 실행',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'mybatisRunner')],
      }
    );
    RunnerPanel.current = new RunnerPanel(context, deps, panel, uri, stmtId);
  }

  /** 기능을 끌 때 */
  static closeAll() {
    RunnerPanel.current?.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: Deps,
    private readonly panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    stmtId: string
  ) {
    this.uri = uri;
    this.stmtId = stmtId;
    this.dimmed = vscode.window.createTextEditorDecorationType({ opacity: '0.4' });
    panel.iconPath = new vscode.ThemeIcon('database');
    panel.webview.html = this.html();
    this.disposables.push(
      this.dimmed,
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      // 편집 중에도 바로 반영 (저장 전 내용 기준)
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.uri.toString()) this.schedule();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      deps.index.onDidChange(() => this.schedule()),
      deps.oracle.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devBoost.mybatisRunner')) this.schedule();
      })
    );
    // 다른 mapper 의 <sql> 조각을 위해 색인 (끝나면 onDidChange 로 다시 그림)
    void deps.index.ensureBuilt();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 200);
  }

  private async currentDoc(): Promise<{ doc: MapperDoc; st: MapperStatement } | { error: string }> {
    let text: string;
    try {
      text = (await vscode.workspace.openTextDocument(this.uri)).getText();
    } catch {
      return { error: '파일을 열 수 없습니다.' };
    }
    const doc = parseMapper(text, this.uri.fsPath);
    if (!doc) return { error: 'MyBatis mapper XML 이 아닙니다 (namespace 가 있는 <mapper> 를 찾지 못함).' };
    const st = doc.statements.find((s) => s.id === this.stmtId);
    if (!st) return { error: `'${this.stmtId}' 쿼리를 찾지 못했습니다 (id 가 바뀌었나요?).` };
    return { doc, st };
  }

  private async refresh() {
    const found = await this.currentDoc();
    if ('error' in found) {
      this.last = undefined;
      this.lastDoc = undefined;
      this.decorate();
      void this.panel.webview.postMessage({ type: 'error', message: found.error });
      return;
    }
    const { doc, st } = found;
    const p = this.deps.store.prepare(doc, st, this.deps.index.resolver());
    this.last = p;
    this.lastDoc = doc;
    this.panel.title = `SQL: ${st.id}`;
    this.decorate();
    const rel = vscode.workspace.asRelativePath(this.uri);
    void this.panel.webview.postMessage({
      type: 'state',
      key: p.key,
      namespace: doc.namespace,
      id: st.id,
      stmtType: st.type,
      file: rel,
      fsPath: this.uri.fsPath,
      line: st.line,
      resultMap: st.resultMap,
      resultType: st.resultType,
      mode: p.mode,
      params: p.specs.map((s) => ({ path: s.path, uses: s.uses, jdbcType: s.jdbcType, line: s.line, ...p.inputs[s.path] })),
      branches: p.result.branches.map((b) => ({ ...b, file: b.file === this.uri.fsPath ? '' : path.basename(b.file), fsPath: b.file })),
      warnings: p.result.warnings,
      sql: p.text,
      binds: p.result.binds.map((b) => ({ name: b.name, expr: b.expr, literal: b.literal })),
      oracle: { installed: this.deps.oracle.installed, target: this.deps.oracle.targetName ?? null },
      indexing: !this.deps.index.ready,
    });
  }

  /** 꺼진 분기를 원본 XML 에서 흐리게 */
  private decorate() {
    const enabled = vscode.workspace.getConfiguration('devBoost.mybatisRunner').get<boolean>('dimInactive', true);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() !== this.uri.toString()) continue;
      if (!enabled || !this.last || !this.lastDoc) {
        ed.setDecorations(this.dimmed, []);
        continue;
      }
      const ranges = this.last.result.branches
        .filter((b) => !b.on && b.file === this.uri.fsPath && (b.tag === 'if' || b.tag === 'when' || b.tag === 'otherwise' || b.tag === 'foreach'))
        .map((b) => new vscode.Range(ed.document.positionAt(b.start), ed.document.positionAt(b.end)));
      ed.setDecorations(this.dimmed, ranges);
    }
  }

  private async onMessage(m: Msg) {
    const store = this.deps.store;
    const key = this.last?.key;
    switch (m.type) {
      case 'ready':
        return this.refresh();
      case 'input':
        if (key && m.path) store.setInput(key, m.path, { type: (m.paramType ?? 'auto') as ParamType, value: m.value ?? '' } as ParamInput);
        return this.refresh();
      case 'override':
        if (key && m.key) store.setOverride(key, m.key, (m.state ?? undefined) as BranchOverride | undefined);
        return this.refresh();
      case 'overrideAll': {
        if (!key || !this.last) return;
        const all: Record<string, BranchOverride> = {};
        if (m.state === 'on' || m.state === 'off') {
          for (const b of this.last.result.branches) {
            if (b.tag === 'if' || b.tag === 'when') all[b.key] = m.state;
          }
        }
        store.setOverrides(key, all);
        return this.refresh();
      }
      case 'mode':
        store.setMode(m.mode === 'bind' ? 'bind' : 'literal');
        return this.refresh();
      case 'clear':
        if (key) store.clearInputs(key);
        return this.refresh();
      case 'copy':
        if (this.last) {
          await vscode.env.clipboard.writeText(this.last.text);
          this.notice(this.last.mode === 'bind' ? '바인드 변수 스크립트를 복사했습니다 (F5 로 실행).' : 'SQL 을 복사했습니다.');
        }
        return;
      case 'send':
        return this.send(m.action === 'run' || m.action === 'explain' ? m.action : 'insert');
      case 'reveal':
        return this.reveal(m.file, m.line);
    }
  }

  /**
   * run: 값 넣기면 Ctrl+Enter(문장 실행), 바인드 변수면 F5(스크립트 실행)
   * insert: 워크시트에 넣기만
   * explain: 모드와 관계없이 바인드 변수 형태의 SQL 로 실행 계획 (F10).
   *          운영에서 MyBatis 는 ? 바인드로 실행하므로 리터럴 SQL 의 계획과 다를 수 있어서.
   *          EXPLAIN PLAN 은 바인드 값 없이도 계획을 만든다.
   */
  private async send(kind: 'run' | 'insert' | 'explain') {
    if (!this.last || !this.lastDoc) return;
    const st = this.lastDoc.statements.find((s) => s.id === this.stmtId);
    if (!st) return;
    const cfg = vscode.workspace.getConfiguration('devBoost.mybatisRunner');
    const insert = cfg.get<'append' | 'replace'>('worksheetInsert', 'append');
    if (kind === 'explain') {
      const bindSql = this.deps.store.prepare(this.lastDoc, st, this.deps.index.resolver(), 'bind').result.sql;
      if (!bindSql.trim()) return this.notice('보낼 SQL 이 비어 있습니다.', 'warn');
      this.notice(await this.deps.oracle.send(bindSql, { action: 'explain', insert }));
      return;
    }
    const text = this.last.text;
    if (!this.last.result.sql.trim()) return this.notice('보낼 SQL 이 비어 있습니다.', 'warn');
    if (kind === 'run' && st.type !== 'select') {
      const ok = await vscode.window.showWarningMessage(
        `${st.type.toUpperCase()} 문을 실행합니다. 데이터가 바뀔 수 있습니다.`,
        { modal: true, detail: `${this.lastDoc.namespace}.${st.id}\n접속 대상과 커밋 설정을 확인하세요.` },
        '실행'
      );
      if (ok !== '실행') return;
    }
    const action = kind === 'insert' ? 'none' : this.last.mode === 'bind' ? 'script' : 'statement';
    this.notice(await this.deps.oracle.send(text, { action, insert }));
  }

  private async reveal(file: string | undefined, line: number | undefined) {
    const target = file ? vscode.Uri.file(file) : this.uri;
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      const shown = vscode.window.visibleTextEditors.find((e) => e.document === doc);
      await vscode.window.showTextDocument(doc, {
        viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One,
        selection: new vscode.Range(pos, pos),
        preserveFocus: false,
      });
    } catch {
      this.notice('파일을 열 수 없습니다.', 'warn');
    }
  }

  private notice(text: string, kind: 'info' | 'warn' = 'info') {
    void this.panel.webview.postMessage({ type: 'notice', text, kind });
  }

  private html(): string {
    const wv = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mybatisRunner');
    const js = wv.asWebviewUri(vscode.Uri.joinPath(base, 'runner.js'));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(base, 'runner.css'));
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>SQL 실행</title></head>
<body><div id="app"><div class="empty">불러오는 중…</div></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private dispose() {
    RunnerPanel.current = undefined;
    if (this.timer) clearTimeout(this.timer);
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(this.dimmed, []);
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

export interface Deps {
  store: RunnerStore;
  index: MapperIndex;
  oracle: OracleBridge;
}

interface Msg {
  type: string;
  path?: string;
  paramType?: string;
  value?: string;
  key?: string;
  state?: string | null;
  mode?: string;
  action?: string;
  file?: string;
  line?: number;
}
