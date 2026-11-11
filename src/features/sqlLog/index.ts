import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { LogReader, LoggedQuery, QueryRing, consoleText, queryInfo, queryTitle } from './parse';
import { closeSqlLogPicker, showSqlLogPicker } from './picker';

/**
 * SQL 로그: 터미널에서 돌린 서버(gradlew bootRun, mvn spring-boot:run …)의 로그(MyBatis·log4jdbc·SQL 로 시작하는 로그)에서
 * 쿼리를 골라 값까지 채워 두고, 고르면 새 DB 콘솔에 옮긴다 (실행은 하지 않는다).
 *  - 상태바 `SQL n`: 마우스를 올리면 최근 쿼리 목록, 누르면 고르는 창 (목록 + 전체 SQL 미리보기)
 *  - 명령 `SQL 로그: 최근 쿼리를 DB 콘솔로`
 * 터미널 출력은 VS Code 의 셸 통합으로 읽는다. 기능이 켜진 뒤에 시작한 명령부터 읽고, 쿼리는 메모리에만 둔다.
 */


/** 목록을 여는 기본 단축키 (package.json 의 keybindings 와 같게). 사용자가 바꾼 키는 확장에서 읽을 수 없다 */
const PICK_KEY = process.platform === 'darwin' ? 'Cmd+Alt+L' : 'Ctrl+Alt+L';

/** 로그가 이만큼 멈추면 붙잡아 둔 마지막 줄을 처리하고 화면을 맞춘다 */
const IDLE_MS = 300;

function cfg() {
  return vscode.workspace.getConfiguration('devBoost.sqlLog');
}

const two = (n: number) => String(n).padStart(2, '0');
function timeText(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** 목록 한 줄에 보일 SQL (한 줄로, 길면 자름) */
function oneLine(sql: string, max: number): string {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const sqlLog: Feature = {
  id: 'sqlLog',
  name: 'SQL 로그',
  start(context) {
    const ring = new QueryRing(cfg().get<number>('maxQueries', 10));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    status.command = 'devBoost.sqlLog.pick';
    status.name = 'DevBoost SQL 로그';
    let disposed = false;

    const refresh = () => {
      const list = ring.items();
      if (!list.length) {
        status.hide();
        return;
      }
      status.text = `$(database) SQL ${list.length}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['devBoost.sqlLog.send'] };
      md.appendMarkdown('**최근 쿼리** — 누르면 새 DB 콘솔에 옮깁니다 (실행은 직접)\n\n');
      for (const q of list) {
        const arg = encodeURIComponent(JSON.stringify([q.id]));
        const info = queryInfo(q);
        const head = `${timeText(q.time)} ${queryTitle(q)}${info ? ` · ${info}` : ''}`;
        md.appendMarkdown(`[$(arrow-right) ${head.replace(/[[\]\\]/g, '\\$&')}](command:devBoost.sqlLog.send?${arg})  \n`);
        md.appendMarkdown(`\`${oneLine(q.sql, 90).replace(/`/g, "'")}\`\n\n`);
      }
      md.appendMarkdown(`---\n\n\`${PICK_KEY}\` 또는 여기를 눌러 전체 SQL 을 보며 고르기`);
      status.tooltip = md;
      status.show();
    };

    /** 고른 쿼리를 새 DB 콘솔에 넣는다 (실행은 하지 않는다). DB 콘솔을 꺼 뒀으면 클립보드로 */
    const send = async (q: LoggedQuery | undefined) => {
      if (!q) {
        void vscode.window.showInformationMessage('그 쿼리는 목록에서 밀려났습니다. 목록을 다시 열어 주세요.');
        return;
      }
      const text = consoleText(q, timeText(q.time));
      const all = await vscode.commands.getCommands(true);
      if (all.includes('devBoost.dbConsole.runSql')) {
        await vscode.commands.executeCommand('devBoost.dbConsole.runSql', text, { run: false, newConsole: true });
      } else {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage('DB 콘솔이 꺼져 있어 SQL 을 클립보드에 복사했습니다.');
      }
    };

    /** 고르는 창을 연다 — 연 순간의 목록 그대로 (그 뒤 들어온 쿼리는 다시 열면 보인다) */
    const pick = () => {
      if (!ring.items().length) {
        void vscode.window.showInformationMessage(
          '아직 읽은 쿼리가 없습니다. VS Code 터미널에서 서버를 실행하고(SQL 로그가 찍히는 상태로) 화면을 한 번 조회해 보세요.'
        );
        return;
      }
      showSqlLogPicker(context, { items: () => ring.items(), send, timeText });
    };

    /** 터미널 명령 하나의 출력을 끝까지 읽는다 */
    const consume = async (execution: vscode.TerminalShellExecution) => {
      const reader = new LogReader(Date.now, { auto: cfg().get<boolean>('autoDetect', true), keywords: cfg().get<string[]>('loggers', []) });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const take = (found: LoggedQuery[]) => {
        for (const q of found) ring.add(q);
      };
      try {
        for await (const chunk of execution.read()) {
          if (disposed) break;
          take(reader.push(chunk));
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            if (disposed) return;
            take(reader.flush());
            refresh(); // 건수(<== Total)는 쿼리보다 늦게 오므로 멈췄을 때 한 번에 맞춘다
          }, IDLE_MS);
        }
      } catch {
        // 터미널이 닫히는 등으로 읽기가 끊김
      } finally {
        if (idle) clearTimeout(idle);
        if (!disposed) {
          take(reader.flush());
          refresh();
        }
      }
    };

    const subs: vscode.Disposable[] = [
      { dispose: () => ((disposed = true), closeSqlLogPicker()) },
      status,
      vscode.commands.registerCommand('devBoost.sqlLog.pick', pick),
      vscode.commands.registerCommand('devBoost.sqlLog.send', (id: number) => send(ring.get(Number(id)))),
      vscode.commands.registerCommand('devBoost.sqlLog.clear', () => {
        ring.clear();
        refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devBoost.sqlLog.maxQueries')) {
          ring.setMax(cfg().get<number>('maxQueries', 10));
          refresh();
        }
      }),
    ];
    // 터미널 출력 읽기는 VS Code 1.93 부터 (그 전 버전에서는 명령만 등록되고 쿼리는 모이지 않는다)
    if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
      subs.push(vscode.window.onDidStartTerminalShellExecution((e) => void consume(e.execution)));
    }
    return subs;
  },
};
