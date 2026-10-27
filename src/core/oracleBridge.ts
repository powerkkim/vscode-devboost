import * as vscode from 'vscode';
import { OracleRuns } from './oracleRuns';
import { describeRunEnd } from './runResult';

/**
 * Oracle SQL Developer for VS Code 확장으로 SQL 을 넘긴다.
 *
 * 확인한 내용 (oracle.sql-developer 26.3 의 package.json):
 *  - .sql 워크시트의 언어 ID 는 'oracle-sql'
 *  - 실행 명령 'sqldeveloper.worksheet.runStatement' (Ctrl+Enter 와 같음, 커서/선택 문장 실행)
 *    when: sqldeveloper.activeEditorType == sqlWorksheet → 워크시트에 포커스가 있어야 한다
 *  - 접속에서 워크시트를 여는 명령은 트리 항목을 인자로 받아 밖에서 부르기 어렵다
 *    → 사용자가 접속에서 연 워크시트를 기억해 두고 그곳으로 보낸다
 */
const ORACLE_LANG = 'oracle-sql';
const COMMANDS = {
  statement: 'sqldeveloper.worksheet.runStatement', // Ctrl+Enter: 선택(커서) 문장 실행
  script: 'sqldeveloper.worksheet.runScript', //       F5: 스크립트 실행 (VARIABLE / EXEC 포함)
  explain: 'sqldeveloper.worksheet.explainPlan', //    F10: 실행 계획
} as const;

/** 워크시트에 넣은 뒤 할 일 */
export type SendAction = 'none' | keyof typeof COMMANDS;

const KEY_OF: Record<SendAction, string> = { none: '', statement: 'Ctrl+Enter', script: 'F5', explain: 'F10' };
const DONE: Record<SendAction, string> = { none: '', statement: '실행했습니다', script: '스크립트로 실행했습니다', explain: '실행 계획을 열었습니다' };
const DOING: Record<SendAction, string> = { none: '', statement: '실행 중', script: '스크립트 실행 중', explain: '실행 계획 만드는 중' };

/** 화면에 알릴 한 줄. busy 는 끝날 때까지 남아 있고 since 부터 경과 시간을 센다 */
export type Report = (text: string, kind: 'info' | 'warn' | 'busy', since?: number) => void;

/**
 * SQL 을 보낼 워크시트인지: Oracle 언어이면서 프로젝트 파일이 아닌 것 (접속에서 연 워크시트·제목 없는 문서).
 * 프로젝트의 .sql 파일도 oracle-sql 이라, 여기에 수집 SQL 이 덧붙으면 안 된다.
 */
function isWorksheet(d: vscode.TextDocument): boolean {
  return d.languageId === ORACLE_LANG && d.uri.scheme !== 'file';
}

/** 줄바꿈을 한 가지로 맞춤 */
export function toEol(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, eol);
}

export class OracleBridge implements vscode.Disposable {
  private last: vscode.TextDocument | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly runs = OracleRuns.acquire();

  constructor() {
    const track = (e: vscode.TextEditor | undefined) => {
      if (e && isWorksheet(e.document) && this.last !== e.document) {
        this.last = e.document;
        this.changed.fire();
      }
    };
    track(vscode.window.activeTextEditor);
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(track),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d === this.last) {
          this.last = undefined;
          this.changed.fire();
        }
      }),
      vscode.workspace.onDidOpenTextDocument((d) => {
        if (isWorksheet(d) && !this.last) {
          this.last = d;
          this.changed.fire();
        }
      })
    );
  }

  get installed(): boolean {
    return vscode.extensions.all.some((x) => x.id.toLowerCase().startsWith('oracle.sql-developer'));
  }

  /** 보낼 워크시트 이름 (화면 표시용) */
  get targetName(): string | undefined {
    const d = this.target();
    if (!d) return undefined;
    return d.isUntitled ? d.uri.path : vscode.workspace.asRelativePath(d.uri);
  }

  private target(): vscode.TextDocument | undefined {
    if (this.last && !this.last.isClosed) return this.last;
    // 이미 열린 Oracle 워크시트 중 하나
    return vscode.workspace.textDocuments.find((d) => isWorksheet(d) && !d.isClosed);
  }

  /**
   * SQL 을 워크시트에 넣고(append/replace) 넣은 부분을 선택해 둔다. action 이 있으면 그 명령까지.
   * 선택해 두는 이유: 실행·스크립트 실행·실행 계획 모두 선택 영역이 있으면 그 부분만 대상으로 한다
   * 돌려주는 값: 사용자에게 보여 줄 한 줄 결과
   */
  /**
   * send + 실행이 끝날 때까지 알림.
   *  report(…, 'busy', 시작 시각) → 끝나면 report(결과 한 줄). okTail: 성공했을 때 덧붙일 안내
   * Oracle 확장 API 로 끝을 알 수 없으면(다른 버전 등) 예전처럼 "실행했습니다" 한 번만 알린다.
   */
  async run(sql: string, opts: { action: SendAction; insert: 'append' | 'replace' }, report: Report, okTail = ''): Promise<void> {
    const tail = okTail ? ` ${okTail}` : '';
    const r = await this.sendTracked(sql, opts);
    if (!r.wait) return report(r.text + (opts.action === 'none' ? '' : tail), r.warn ? 'warn' : 'info');
    report(r.busyText!, 'busy', r.since);
    const end = await r.wait;
    if (!end) return report(r.text + tail, 'info');
    const d = describeRunEnd(end.summary, end.ms);
    report(d.text + (end.summary.outcome === 'ok' ? tail : ''), d.kind);
  }

  async send(sql: string, opts: { action: SendAction; insert: 'append' | 'replace' }): Promise<string> {
    return (await this.sendTracked(sql, opts)).text;
  }

  private async sendTracked(
    sql: string,
    opts: { action: SendAction; insert: 'append' | 'replace' }
  ): Promise<{ text: string; warn?: boolean; wait?: Promise<import('./oracleRuns').RunEnd | undefined>; busyText?: string; since?: number }> {
    const text = /;\s*$/.test(sql) ? sql.trim() : `${sql.trim()};`;
    let doc = this.target();
    let created = false;
    if (!doc) {
      const langs = await vscode.languages.getLanguages();
      doc = await vscode.workspace.openTextDocument({ language: langs.includes(ORACLE_LANG) ? ORACLE_LANG : 'sql', content: '' });
      created = true;
    }
    const shown = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false,
    });
    // 문서의 줄바꿈(Windows 는 CRLF)에 맞춰 넣어야 넣은 부분의 길이·위치가 맞는다
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const body = toEol(text, eol);
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    await editor.edit((b) => {
      if (opts.insert === 'replace' || created || doc!.getText().trim() === '') {
        b.replace(full, body);
      } else {
        const sep = doc!.getText().endsWith('\n') ? eol : eol + eol;
        b.insert(full.end, sep + body);
      }
    });
    // 넣은 글은 항상 문서 맨 끝 → 끝에서 넣은 길이만큼이 선택 범위
    const total = doc.getText().length;
    const start = doc.positionAt(Math.max(0, total - body.length));
    const end = doc.positionAt(total);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.last = doc;
    this.changed.fire();

    if (opts.action === 'none') {
      const key = /^\s*(VARIABLE|EXEC)\b/im.test(text) ? 'F5' : 'Ctrl+Enter';
      return {
        text: created ? `새 워크시트에 넣었습니다. 접속을 연결한 뒤 ${key} 로 실행하세요.` : `워크시트에 넣었습니다. ${key} 로 실행하세요.`,
      };
    }
    if (doc.languageId !== ORACLE_LANG) {
      return { text: 'Oracle SQL Developer 확장이 없어 SQL 편집기에만 넣었습니다.', warn: true };
    }
    // 실행 시작·끝을 받으려면 명령 전에 Oracle 확장 API 에 붙어 있어야 한다
    const tracking = await this.runs.runs.ensure();
    // 포커스가 옮겨진 뒤 Oracle 확장이 context key(activeEditorType)를 갱신할 시간을 준다
    await new Promise((r) => setTimeout(r, 150));
    const since = Date.now();
    try {
      await vscode.commands.executeCommand(COMMANDS[opts.action]);
    } catch (e) {
      return { text: `워크시트에 넣었지만 명령이 실패했습니다: ${(e as Error).message} — ${KEY_OF[opts.action]} 로 직접 실행하세요.`, warn: true };
    }
    const doneText = created ? `새 워크시트에서 ${DONE[opts.action]} (접속을 묻는 창이 뜨면 선택하세요).` : `워크시트에서 ${DONE[opts.action]}.`;
    if (!tracking) return { text: doneText };
    return {
      text: doneText,
      wait: this.runs.runs.waitFor(doc, since),
      busyText: `워크시트에서 ${DOING[opts.action]}…${created ? ' (접속을 묻는 창이 뜨면 선택하세요)' : ''}`,
      since,
    };
  }

  dispose() {
    this.runs.release.dispose();
    this.subs.forEach((d) => d.dispose());
    this.changed.dispose();
  }
}
