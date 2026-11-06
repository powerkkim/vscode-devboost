import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { looksLikeMapper, parseMapper, statementAt } from './mapper/mapperDoc';
import { MapperIndex } from './mapperIndex';
import { OracleBridge } from '../../core/oracleBridge';
import { RunnerStore } from './store';
import { RunnerPanel, Deps } from './ui/runnerPanel';

/**
 * MyBatis SQL 실행 — mapper XML 의 쿼리를 파라미터 값으로 풀어 실행 가능한 SQL 로 만들고
 * Oracle SQL Developer 워크시트로 보낸다.
 *  - 쿼리 위의 CodeLens: "▶ SQL 실행" (화면 열기) / "SQL 복사" (마지막 입력값으로 바로 복사)
 *  - 에디터 우클릭 / 명령 팔레트: 커서가 있는 쿼리 기준
 */
export const mybatisRunner: Feature = {
  id: 'mybatisRunner',
  name: 'MyBatis SQL 실행',
  start(context) {
    const deps: Deps = {
      store: new RunnerStore(context.workspaceState),
      index: new MapperIndex(),
      oracle: new OracleBridge(),
    };

    /** 명령 인자(uri, id) 또는 활성 편집기의 커서 위치로 대상 쿼리를 정한다 */
    const target = (uri?: vscode.Uri, id?: string): { uri: vscode.Uri; id: string } | undefined => {
      if (uri && id) return { uri, id };
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        void vscode.window.showWarningMessage('MyBatis mapper XML 을 열고 쿼리 안에 커서를 두세요.');
        return undefined;
      }
      const doc = parseMapper(ed.document.getText(), ed.document.uri.fsPath);
      if (!doc) {
        void vscode.window.showWarningMessage('MyBatis mapper XML 이 아닙니다 (namespace 가 있는 <mapper> 가 필요).');
        return undefined;
      }
      const st = statementAt(doc, ed.document.offsetAt(ed.selection.active));
      if (!st) {
        void vscode.window.showWarningMessage('이 파일에서 select / insert / update / delete 쿼리를 찾지 못했습니다.');
        return undefined;
      }
      return { uri: ed.document.uri, id: st.id };
    };

    const open = vscode.commands.registerCommand('devBoost.mybatisRunner.open', (uri?: vscode.Uri, id?: string) => {
      const t = target(uri, id);
      if (t) RunnerPanel.show(context, deps, t.uri, t.id);
    });

    const copy = vscode.commands.registerCommand('devBoost.mybatisRunner.copy', async (uri?: vscode.Uri, id?: string) => {
      const t = target(uri, id);
      if (!t) return;
      const text = (await vscode.workspace.openTextDocument(t.uri)).getText();
      const doc = parseMapper(text, t.uri.fsPath);
      const st = doc?.statements.find((s) => s.id === t.id);
      if (!doc || !st) return;
      await deps.index.ensureBuilt();
      const p = deps.store.prepare(doc, st, deps.index.resolver());
      await vscode.env.clipboard.writeText(p.text);
      const unknown = p.result.branches.filter((b) => b.how === 'unknown').length;
      const empty = p.specs.filter((s) => (p.inputs[s.path]?.value ?? '') === '').length;
      const tail = [empty ? `빈 파라미터 ${empty}개` : '', unknown ? `자동 평가 못 한 조건 ${unknown}개(꺼짐)` : ''].filter(Boolean).join(', ');
      void vscode.window.setStatusBarMessage(`$(copy) ${st.id} SQL 복사됨${tail ? ` — ${tail}` : ''}`, 5000);
    });

    /** 마지막 입력값으로 값을 넣은 SQL 을 DevBoost DB 콘솔에서 바로 실행 (콘솔이 연결을 고르고 결과는 쿼리 아래에) */
    const runInConsole = vscode.commands.registerCommand('devBoost.mybatisRunner.runInConsole', async (uri?: vscode.Uri, id?: string) => {
      const t = target(uri, id);
      if (!t) return;
      if (!vscode.workspace.getConfiguration('devBoost.dbConsole').get<boolean>('enabled', true)) {
        void vscode.window.showWarningMessage('DB 콘솔이 꺼져 있습니다 (설정 devBoost.dbConsole.enabled).');
        return;
      }
      const text = (await vscode.workspace.openTextDocument(t.uri)).getText();
      const doc = parseMapper(text, t.uri.fsPath);
      const st = doc?.statements.find((s) => s.id === t.id);
      if (!doc || !st) return;
      await deps.index.ensureBuilt();
      const p = deps.store.prepare(doc, st, deps.index.resolver(), 'literal');
      if (!p.result.sql.trim()) {
        void vscode.window.showWarningMessage(`${st.id}: 만들어진 SQL 이 비어 있습니다.`);
        return;
      }
      const empty = p.specs.filter((s) => (p.inputs[s.path]?.value ?? '') === '').length;
      if (empty) {
        // 값을 안 넣은 파라미터가 있으면 실행 화면을 열어 값을 넣게 한다
        void vscode.window.setStatusBarMessage(`${st.id}: 값이 빈 파라미터 ${empty}개 — 실행 화면에서 넣으세요`, 5000);
        RunnerPanel.show(context, deps, t.uri, t.id);
        return;
      }
      await vscode.commands.executeCommand('devBoost.dbConsole.runSql', `-- ${doc.namespace}.${st.id}\n${p.result.sql.trim()}`);
    });

    const lens = new MapperCodeLens();
    const lensReg = vscode.languages.registerCodeLensProvider(
      [{ language: 'xml' }, { pattern: '**/*.xml' }],
      lens
    );
    const cfgWatch = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devBoost.mybatisRunner.codeLens') || e.affectsConfiguration('devBoost.dbConsole.enabled')) lens.refresh();
    });

    return [
      open, copy, runInConsole, lensReg, lens, cfgWatch, deps.index, deps.oracle,
      { dispose: () => RunnerPanel.closeAll() },
    ];
  },
};

class MapperCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh() {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('devBoost.mybatisRunner').get<boolean>('codeLens', true)) return [];
    const text = document.getText();
    if (!looksLikeMapper(text)) return [];
    const doc = parseMapper(text, document.uri.fsPath);
    if (!doc) return [];
    const out: vscode.CodeLens[] = [];
    const console = vscode.workspace.getConfiguration('devBoost.dbConsole').get<boolean>('enabled', true);
    for (const st of doc.statements) {
      const pos = document.positionAt(st.el.start);
      const range = new vscode.Range(pos, pos);
      out.push(
        new vscode.CodeLens(range, { title: '▶ SQL 실행', command: 'devBoost.mybatisRunner.open', arguments: [document.uri, st.id], tooltip: '파라미터를 넣어 SQL 을 만들고 Oracle 워크시트로 보냅니다' }),
        new vscode.CodeLens(range, { title: 'SQL 복사', command: 'devBoost.mybatisRunner.copy', arguments: [document.uri, st.id], tooltip: '마지막으로 입력한 값으로 SQL 을 만들어 클립보드에 복사' })
      );
      if (console)
        out.push(
          new vscode.CodeLens(range, { title: '▶ 콘솔에서 실행', command: 'devBoost.mybatisRunner.runInConsole', arguments: [document.uri, st.id], tooltip: '마지막으로 입력한 값으로 SQL 을 만들어 DevBoost DB 콘솔에서 바로 실행 (결과는 쿼리 아래)' })
        );
    }
    return out;
  }

  dispose() {
    this.changed.dispose();
  }
}
