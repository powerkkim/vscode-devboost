import * as vscode from 'vscode';
import { describeRunEnd, fmtElapsed, RunSummary, summarizeRunResult } from './runResult';

/**
 * Oracle 워크시트에서 SQL 이 "실행 중"인지, 언제 끝났는지 알아낸다.
 *
 * 확인한 내용 (oracle.sql-developer 26.3 의 dist/extension.js):
 *  - 실행 명령(runStatement/runScript 등)은 실행을 시작만 하고 바로 돌아온다 → executeCommand 의 끝 = 실행 끝이 아님
 *  - 대신 확장이 API 를 내보낸다: exports.worksheets() 의
 *      onWillExecuteCommand({ worksheet, commandId })            실행 시작 (바인드 입력 창보다 먼저)
 *      onDidExecuteCommand({ worksheet, commandId, result })     결과 창에 그린 뒤 = 실행 끝
 *    worksheet.editor 는 그 워크시트의 TextEditor
 *  - API 가 없거나 모양이 다르면(다른 버전) 조용히 꺼지고, 예전처럼 "보냈습니다" 까지만 알린다
 *
 * 두 기능(DB 스키마, MyBatis SQL 실행)이 같이 쓰므로 하나만 만들고 참조 수로 정리한다.
 * 상태 표시줄: 실행 중이면 "SQL 실행 중 12초", 끝나면 잠깐 "실행 끝 1.2초" / "오류 1건".
 */

const ORACLE_EXT = 'oracle.sql-developer';
const LABEL: Record<string, string> = {
  'sqldeveloper.worksheet.runStatement': '문장 실행',
  'sqldeveloper.worksheet.runScript': '스크립트 실행',
  'sqldeveloper.worksheet.explainPlan': '실행 계획',
  'sqldeveloper.worksheet.autotrace': 'Autotrace',
  'sqldeveloper.worksheet.runInSQLcl': 'SQLcl 실행',
};
/** 실행으로 볼 명령만 (같은 이벤트가 접속 연결·해제에도 온다) */
const isRun = (id: string | undefined) => !!id && id in LABEL;
const labelOf = (id: string) => LABEL[id] ?? '실행';

export interface RunEnd {
  commandId: string;
  summary: RunSummary;
  ms: number;
}

interface WorksheetEvent {
  worksheet?: { editor?: vscode.TextEditor };
  commandId?: string;
  result?: unknown;
}
interface WorksheetsApi {
  onWillExecuteCommand: vscode.Event<WorksheetEvent>;
  onDidExecuteCommand: vscode.Event<WorksheetEvent>;
}

interface Running {
  commandId: string;
  started: number;
  uri: vscode.Uri;
  done: Promise<RunEnd>;
  finish: (e: RunEnd) => void;
}

export class OracleRuns implements vscode.Disposable {
  private static shared: OracleRuns | undefined;
  private static users = 0;

  /** 같이 쓰는 감시자 하나를 받는다. 돌려받은 Disposable 을 정리하면 마지막 사용자가 끝낼 때 사라진다 */
  static acquire(): { runs: OracleRuns; release: vscode.Disposable } {
    OracleRuns.shared ??= new OracleRuns();
    OracleRuns.users++;
    const runs = OracleRuns.shared;
    let released = false;
    return {
      runs,
      release: {
        dispose: () => {
          if (released) return;
          released = true;
          if (--OracleRuns.users === 0) {
            OracleRuns.shared?.dispose();
            OracleRuns.shared = undefined;
          }
        },
      },
    };
  }

  private hooked: Promise<boolean> | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private readonly running = new Map<string, Running>();
  /** 최근에 끝난 실행 (시작 시각과 함께) — 기다리기 전에 이미 끝난 짧은 실행을 놓치지 않게 */
  private readonly recent = new Map<string, { started: number; end: RunEnd }>();
  private readonly started = new vscode.EventEmitter<string>();
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private tick: ReturnType<typeof setInterval> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor() {
    this.item.name = 'DevBoost SQL 실행 상태';
    this.subs.push(
      this.item,
      this.started,
      vscode.workspace.onDidCloseTextDocument((d) => {
        const key = d.uri.toString();
        const r = this.running.get(key);
        if (r) this.end(key, r, { outcome: 'unknown' });
      }),
      vscode.extensions.onDidChange(() => {
        if (!this.hooked) void this.ensure();
      })
    );
    void this.ensure();
  }

  /** Oracle 확장 API 에 연결 (한 번만). 연결되면 true */
  ensure(): Promise<boolean> {
    if (this.hooked) return this.hooked;
    const ext = vscode.extensions.all.find((x) => x.id.toLowerCase() === ORACLE_EXT);
    if (!ext) return Promise.resolve(false);
    this.hooked = (async () => {
      try {
        const exp = (ext.isActive ? ext.exports : await ext.activate()) as { worksheets?: () => WorksheetsApi } | undefined;
        const ws = typeof exp?.worksheets === 'function' ? exp.worksheets() : undefined;
        if (!ws || typeof ws.onWillExecuteCommand !== 'function' || typeof ws.onDidExecuteCommand !== 'function') return false;
        this.subs.push(
          ws.onWillExecuteCommand((e) => this.onWill(e)),
          ws.onDidExecuteCommand((e) => this.onDid(e))
        );
        return true;
      } catch {
        return false;
      }
    })();
    return this.hooked;
  }

  private keyOf(e: WorksheetEvent): { key: string; uri: vscode.Uri } | undefined {
    const uri = e.worksheet?.editor?.document?.uri;
    return uri ? { key: uri.toString(), uri } : undefined;
  }

  private onWill(e: WorksheetEvent) {
    const k = this.keyOf(e);
    if (!k || !isRun(e.commandId)) return;
    const old = this.running.get(k.key);
    if (old) this.end(k.key, old, { outcome: 'unknown' });
    let finish!: (x: RunEnd) => void;
    const done = new Promise<RunEnd>((r) => (finish = r));
    this.running.set(k.key, { commandId: e.commandId ?? '', started: Date.now(), uri: k.uri, done, finish });
    this.started.fire(k.key);
    this.render();
  }

  private onDid(e: WorksheetEvent) {
    const k = this.keyOf(e);
    if (!k) return;
    const r = this.running.get(k.key);
    if (r) this.end(k.key, r, summarizeRunResult(e.result));
  }

  private end(key: string, r: Running, summary: RunSummary) {
    this.running.delete(key);
    const end: RunEnd = { commandId: r.commandId, summary, ms: Date.now() - r.started };
    this.recent.set(key, { started: r.started, end });
    r.finish(end);
    this.render(end);
  }

  /**
   * DevBoost 가 since 시각 이후에 doc 으로 보낸 실행이 끝나기를 기다린다.
   * 시작 신호가 startWaitMs 안에 오지 않으면(연결 안 됨·실행 안 됨) undefined.
   * 끝 신호가 오지 않을 때를 대비해 maxMs 가 지나면 undefined.
   */
  async waitFor(doc: vscode.TextDocument, since: number, startWaitMs = 3000, maxMs = 60 * 60_000): Promise<RunEnd | undefined> {
    if (!(await this.ensure())) return undefined;
    const key = doc.uri.toString();
    const timeout = <T>(ms: number) => new Promise<T | undefined>((r) => setTimeout(() => r(undefined), ms));
    const current = () => {
      const r = this.running.get(key);
      if (r && r.started >= since) return r.done;
      const p = this.recent.get(key);
      if (p && p.started >= since) return Promise.resolve(p.end);
      return undefined;
    };
    let done = current();
    if (!done) {
      // 시작 신호를 기다린다. (Promise 를 resolve 값으로 넘기면 그 Promise 가 끝날 때까지 기다리게 되므로 true/false 만 넘김)
      let sub: vscode.Disposable | undefined;
      const seen = new Promise<boolean>((resolve) => {
        sub = this.started.event((k) => {
          if (k === key) resolve(true);
        });
      });
      const ok = await Promise.race([seen, timeout<boolean>(startWaitMs)]);
      sub?.dispose();
      done = ok ? current() : undefined;
      if (!done) return undefined;
    }
    return Promise.race([done, timeout<RunEnd>(maxMs)]);
  }

  /** 상태 표시줄 */
  private render(justEnded?: RunEnd) {
    clearTimeout(this.hideTimer);
    if (this.running.size) {
      const update = () => {
        const list = [...this.running.values()];
        const first = list.reduce((a, b) => (a.started <= b.started ? a : b));
        const sec = Math.floor((Date.now() - first.started) / 1000);
        const more = list.length > 1 ? ` 외 ${list.length - 1}개` : '';
        this.item.text = `$(loading~spin) SQL ${labelOf(first.commandId)} 중 ${sec < 60 ? `${sec}초` : fmtElapsed(sec * 1000)}${more}`;
        this.item.tooltip = `Oracle 워크시트에서 실행 중: ${vscode.workspace.asRelativePath(first.uri)}\n누르면 워크시트로 갑니다.`;
        this.item.command = { title: '워크시트 열기', command: 'vscode.open', arguments: [first.uri] };
        this.item.backgroundColor = undefined;
      };
      update();
      this.tick ??= setInterval(update, 1000);
      this.item.show();
      return;
    }
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    if (!justEnded) {
      this.item.hide();
      return;
    }
    const s = justEnded.summary;
    const t = fmtElapsed(justEnded.ms);
    const { text } = describeRunEnd(s, justEnded.ms);
    this.item.text =
      s.outcome === 'ok' ? `$(check) SQL 실행 끝 ${t}`
      : s.outcome === 'sqlError' ? `$(error) SQL 오류 ${s.errors}건 (${t})`
      : s.outcome === 'cancel' ? '$(circle-slash) SQL 실행 취소'
      : s.outcome === 'fail' ? `$(error) SQL 실행 실패`
      : `$(check) SQL 실행 끝 ${t}`;
    this.item.tooltip = text;
    this.item.backgroundColor = s.outcome === 'sqlError' || s.outcome === 'fail' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.item.show();
    this.hideTimer = setTimeout(() => this.item.hide(), s.outcome === 'ok' || s.outcome === 'unknown' ? 8000 : 15000);
  }

  dispose() {
    if (this.tick) clearInterval(this.tick);
    clearTimeout(this.hideTimer);
    for (const [key, r] of this.running) {
      this.running.delete(key);
      r.finish({ commandId: r.commandId, summary: { outcome: 'unknown' }, ms: Date.now() - r.started });
    }
    this.subs.forEach((d) => d.dispose());
  }
}
