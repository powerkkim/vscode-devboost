import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { looksLikeMapper, parseMapper, statementAt } from './mapper/mapperDoc';
import { MapperIndex } from './mapperIndex';
import { RunnerStore } from './store';
import { consolePanel, Deps, sendToConsole } from './consoleLink';
import { ParamInput } from './mapper/values';

/**
 * MyBatis SQL 실행 — mapper XML 의 쿼리를 DevBoost DB 콘솔에서 실행한다.
 *  - 쿼리 위의 CodeLens: "▶ 콘솔에서 실행" / "SQL 복사" (마지막 입력값으로 값을 넣은 SQL)
 *  - 에디터 우클릭·Ctrl+Alt+Enter: 커서가 있는 쿼리를 콘솔에서 실행
 *  - 콘솔에서는 왼쪽 패널에서 파라미터 값을 바꾸면 if·foreach 를 다시 풀어 SQL 이 바뀐다 (consoleLink)
 */
export const mybatisRunner: Feature = {
  id: 'mybatisRunner',
  name: 'MyBatis SQL 실행',
  start(context) {
    const deps: Deps = {
      store: new RunnerStore(context.workspaceState),
      index: new MapperIndex(),
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

    const copy = vscode.commands.registerCommand('devBoost.mybatisRunner.copy', async (uri?: vscode.Uri, id?: string) => {
      const t = target(uri, id);
      if (!t) return;
      const text = (await vscode.workspace.openTextDocument(t.uri)).getText();
      const doc = parseMapper(text, t.uri.fsPath);
      const st = doc?.statements.find((s) => s.id === t.id);
      if (!doc || !st) return;
      await deps.index.ensureBuilt();
      const p = deps.store.prepare(doc, st, deps.index.resolver(), 'literal', { ignoreOverrides: true });
      await vscode.env.clipboard.writeText(p.text);
      const unknown = p.result.branches.filter((b) => b.how === 'unknown').length;
      const empty = p.specs.filter((s) => (p.inputs[s.path]?.value ?? '') === '').length;
      const tail = [empty ? `빈 파라미터 ${empty}개` : '', unknown ? `자동 평가 못 한 조건 ${unknown}개(꺼짐)` : ''].filter(Boolean).join(', ');
      void vscode.window.setStatusBarMessage(`$(copy) ${st.id} SQL 복사됨${tail ? ` — ${tail}` : ''}`, 5000);
    });

    /**
     * 커서 위치 쿼리를 DevBoost DB 콘솔에서 실행.
     * 동적 태그는 마지막 입력값으로 풀고 #{} 는 :이름 파라미터로 보내, 값은 콘솔의 파라미터 칸에서 확인·수정한다.
     */
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
      if (!(await sendToConsole(deps, doc, st))) void vscode.window.showWarningMessage(`${st.id}: 마지막 입력값으로 만든 SQL 이 비어 있습니다.`);
    });

    /** DB 콘솔 왼쪽 패널이 묻는다: (네임스페이스, id) 의 파라미터·SQL. set 이 있으면 값을 바꾼 뒤 */
    const panel = vscode.commands.registerCommand('devBoost.mybatisRunner.consolePanel', (ns: string, id: string, set?: { path: string; input: ParamInput }) =>
      consolePanel(deps, String(ns), String(id), set)
    );
    const lens = new MapperCodeLens();
    const lensReg = vscode.languages.registerCodeLensProvider(
      [{ language: 'xml' }, { pattern: '**/*.xml' }],
      lens
    );
    const cfgWatch = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devBoost.mybatisRunner.codeLens') || e.affectsConfiguration('devBoost.dbConsole.enabled')) lens.refresh();
    });

    return [
      copy, runInConsole, panel, lensReg, lens, cfgWatch, deps.index,
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
      if (console)
        out.push(
          new vscode.CodeLens(range, { title: '▶ 콘솔에서 실행', command: 'devBoost.mybatisRunner.runInConsole', arguments: [document.uri, st.id], tooltip: 'DevBoost DB 콘솔에서 실행 — 파라미터 값은 콘솔 왼쪽 칸에서 바꾸면 if·foreach 까지 다시 풀립니다' })
        );
      out.push(new vscode.CodeLens(range, { title: 'SQL 복사', command: 'devBoost.mybatisRunner.copy', arguments: [document.uri, st.id], tooltip: '마지막으로 입력한 값으로 SQL 을 만들어 클립보드에 복사' }));
    }
    return out;
  }

  dispose() {
    this.changed.dispose();
  }
}
