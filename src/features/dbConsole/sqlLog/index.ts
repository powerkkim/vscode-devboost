import * as vscode from 'vscode';
import { Feature } from '../../../core/feature';
import { LogReader, LoggedQuery, QueryFilter, QueryRing, consoleText, queryInfo, queryTitle } from './parse';
import { closeSqlLogPicker, showSqlLogPicker } from './picker';
import { registerServerTerminals } from './serverTerminal';

/**
 * SQL 로그: 터미널에서 돌린 서버(gradlew bootRun, mvn spring-boot:run …)의 로그(MyBatis·log4jdbc·SQL 로 시작하는 로그)에서
 * 쿼리를 골라 값까지 채워 두고, 고르면 DB 콘솔(그 연결의 로그용 콘솔 하나)에 옮긴다 (실행은 하지 않는다).
 *  - 상태바 `SQL n`: 마우스를 올리면 최근 쿼리 목록, 누르면 고르는 창 (목록 + 전체 SQL 미리보기)
 *  - 명령 `SQL 로그: 최근 쿼리를 DB 콘솔로`
 * 읽는 곳: 터미널 명령(VS Code 의 셸 통합 — 기능이 켜진 뒤에 시작한 명령부터), Run · Debug 의 출력
 * (Java 서버는 디버그 출력으로 받아 확장이 만든 터미널에 보인다 — serverTerminal.ts),
 * 그리고 사용자가 고른 로그(`SQL 로그: 고른 로그에서 읽기` — 이미 떠 있는 서버의 로그). 쿼리는 메모리에만 둔다.
 * 상태바는 늘 보이고, 쿼리가 없으면 왜 없는지(읽는 곳 · 셸 통합이 없는 터미널 · 읽은 줄 수)를 알려 준다.
 * 수집 필터(include · exclude 낱말, 같은 쿼리 id 는 최신 하나만)는 모을 때 걸러, 필요 없는 공통 쿼리가 자리를 차지하지 않게 한다.
 */


/** 목록을 여는 기본 단축키 (package.json 의 keybindings 와 같게). 사용자가 바꾼 키는 확장에서 읽을 수 없다 */
const PICK_KEY = process.platform === 'darwin' ? 'Cmd+Alt+L' : 'Ctrl+Alt+L';

/** 로그가 이만큼 멈추면 붙잡아 둔 마지막 줄을 처리하고 화면을 맞춘다 */
const IDLE_MS = 300;

function cfg() {
  return vscode.workspace.getConfiguration('devBoost.dbConsole.sqlLog');
}

const FILTER_SETTINGS = ['include', 'exclude', 'latestOnly'].map((k) => `devBoost.dbConsole.sqlLog.${k}`);

function readFilter(): QueryFilter {
  return new QueryFilter(cfg().get<string[]>('include', []), cfg().get<string[]>('exclude', []));
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
  id: 'dbConsole.sqlLog',
  name: 'SQL 로그',
  switches: ['dbConsole.enabled', 'dbConsole.sqlLog.enabled'],
  start(context) {
    const ring = new QueryRing(cfg().get<number>('maxQueries', 10), readFilter(), cfg().get<boolean>('latestOnly', false));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    status.command = 'devBoost.sqlLog.pick';
    status.name = 'DevBoost SQL 로그';
    let disposed = false;

    const serverTerminals = registerServerTerminals(() => cfg().get<boolean>('debugTerminal', true));

    /** 지금 읽고 있는 곳 (터미널 명령 · 디버그 세션) → 읽은 줄 수 */
    const sources = new Map<object, { label: string; lines: number }>();
    /** 지금까지 읽은 줄 수 · 찾은 쿼리 수 (끝난 것 포함) */
    let linesRead = 0;
    let found = 0;

    /** 쿼리가 없을 때 까닭과 할 일 (상태바 · 목록 열기에서 같이 쓴다) */
    const diagnose = (): string[] => {
      const out: string[] = [];
      const reading = [...sources.values()];
      if (reading.length) {
        out.push(`읽는 중: ${reading.map((r) => `${r.label} (${r.lines}줄)`).join(', ')}`);
        if (!ring.items().length && !ring.excluded) {
          out.push(
            found
              ? '목록을 비웠습니다. 화면을 조회하면 다시 모입니다.'
              : linesRead
              ? '로그는 읽고 있지만 SQL 로그를 아직 찾지 못했습니다. 화면을 한 번 조회해 보고, 그래도 없으면 설정 loggers 에 SQL 로그 줄의 로거 이름을 적어 주세요.'
              : '아직 출력이 없습니다. 화면을 한 번 조회해 보세요.'
          );
        }
      } else {
        out.push('읽고 있는 터미널 명령 · 디버그 세션이 없습니다. 이 기능이 켜지기 전에 띄운 서버는 읽지 못합니다 — 서버를 VS Code 터미널에서 다시 띄우거나, 터미널에서 로그를 드래그하고 우클릭 → "SQL 로그 — 고른 로그에서 읽기".');
      }
      const noShell = vscode.window.terminals.filter((t) => 'shellIntegration' in t && !t.shellIntegration && !serverTerminals.owns(t)).map((t) => t.name);
      const debugTerms = noShell.filter((n) => /^(Run|Debug): /.test(n));
      const plainTerms = noShell.filter((n) => !/^(Run|Debug): /.test(n));
      if (debugTerms.length) {
        out.push(
          cfg().get<boolean>('debugTerminal', true)
            ? `Java 디버거가 만든 터미널(${debugTerms.join(', ')})은 읽지 못합니다. 서버를 멈추고 Run · Debug 로 다시 띄우면 DevBoost 가 읽을 수 있는 터미널에 보여 줍니다.`
            : `Java 디버거가 만든 터미널(${debugTerms.join(', ')})은 읽지 못합니다. 설정 devBoost.dbConsole.sqlLog.debugTerminal 을 켜고 서버를 다시 띄우세요.`
        );
      }
      if (plainTerms.length) out.push(`셸 통합이 없는 터미널(읽지 못함): ${plainTerms.join(', ')} — 명령 프롬프트(cmd)이거나 셸 통합이 꺼진 터미널입니다. PowerShell · Git Bash 터미널에서 띄워 주세요.`);
      if (typeof vscode.window.onDidStartTerminalShellExecution !== 'function') out.push('이 VS Code 는 터미널 출력을 읽지 못합니다 (1.93 이상 필요). 고른 로그에서 읽기는 됩니다.');
      return out;
    };

    const refresh = () => {
      const list = ring.items();
      status.text = `$(database) SQL ${list.length}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['devBoost.sqlLog.send', 'devBoost.sqlLog.readSelection', 'devBoost.sqlLog.pick'] };
      if (!list.length) {
        md.appendMarkdown('**SQL 로그** — 모은 쿼리가 없습니다\n\n');
        for (const line of diagnose()) md.appendMarkdown(`- ${line.replace(/[[\]\\*_`]/g, '\\$&')}\n`);
        md.appendMarkdown('\n[$(selection) 고른 로그에서 읽기](command:devBoost.sqlLog.readSelection) · [$(filter) 수집 필터](command:devBoost.sqlLog.pick)\n\n');
      }
      if (ring.excluded) md.appendMarkdown(`[$(filter) 수집 필터로 빠진 쿼리 ${ring.excluded}개](command:devBoost.sqlLog.pick) — 목록 창 위에서 필터를 풀면 돌아옵니다\n\n`);
      if (list.length) md.appendMarkdown('**최근 쿼리** — 누르면 DB 콘솔에 옮깁니다 (실행은 직접)\n\n');
      for (const q of list) {
        const arg = encodeURIComponent(JSON.stringify([q.id]));
        const info = queryInfo(q);
        const head = `${timeText(q.time)} ${queryTitle(q)}${info ? ` · ${info}` : ''}`;
        md.appendMarkdown(`[$(arrow-right) ${head.replace(/[[\]\\]/g, '\\$&')}](command:devBoost.sqlLog.send?${arg})  \n`);
        md.appendMarkdown(`\`${oneLine(q.sql, 90).replace(/`/g, "'")}\`\n\n`);
      }
      if (list.length) md.appendMarkdown(`---\n\n\`${PICK_KEY}\` 또는 여기를 눌러 전체 SQL 을 보며 고르기`);
      status.tooltip = md;
      status.show();
    };

    /** 고른 쿼리를 로그용 DB 콘솔에 넣는다 (실행은 하지 않는다). DB 콘솔을 꺼 뒀으면 클립보드로 */
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

    /** 지금 수집 필터 */
    const currentFilter = () => ({ include: cfg().get<string[]>('include', []), exclude: cfg().get<string[]>('exclude', []), latestOnly: cfg().get<boolean>('latestOnly', false) });

    /** 고르는 창을 연다 — 연 순간의 목록 그대로 (그 뒤 들어온 쿼리는 다시 열면 보인다). 쿼리가 없어도 열어 까닭과 필터를 보인다 */
    const pick = () => {
      showSqlLogPicker(context, {
        items: () => ring.items(),
        send,
        timeText,
        excluded: () => ring.excluded,
        filter: currentFilter,
        setFilter,
        diagnose: () => (ring.items().length ? [] : diagnose()),
        readSelection: () => readSelection(),
      });
    };

    /**
     * 수집 필터를 바꾼다: 바뀐 설정만 적어 둔 곳(작업 영역에 적어 뒀으면 그곳, 아니면 사용자)에 쓰고, 모인 목록에 바로 적용한다.
     * 걸려 있던 최근 쿼리는 풀리면 목록으로 돌아온다
     */
    const setFilter = async (next: { include: string[]; exclude: string[]; latestOnly: boolean }) => {
      const clean = (list: string[]) => [...new Map(list.map((w) => w.trim()).filter(Boolean).map((w) => [w.toLowerCase(), w])).values()];
      const want = { include: clean(next.include), exclude: clean(next.exclude), latestOnly: !!next.latestOnly };
      const result = ring.setFilter(new QueryFilter(want.include, want.exclude), want.latestOnly);
      refresh();
      const now = currentFilter();
      for (const key of ['include', 'exclude', 'latestOnly'] as const) {
        if (JSON.stringify(now[key]) === JSON.stringify(want[key])) continue;
        const where = cfg().inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await cfg().update(key, want[key], where);
      }
      return result;
    };

    const newReader = () => new LogReader(Date.now, { auto: cfg().get<boolean>('autoDetect', true), keywords: cfg().get<string[]>('loggers', []) });

    /**
     * 출력 한 줄기(터미널 명령 하나 · 디버그 세션 하나)를 읽는 곳. push 로 글을 넣고 끝나면 end.
     * 로그가 IDLE_MS 동안 멈추면 붙잡아 둔 마지막 줄을 처리하고 화면을 맞춘다 (건수 <== Total 은 쿼리보다 늦게 온다)
     */
    const openSource = (key: object, label: string) => {
      const reader = newReader();
      const source = { label, lines: 0 };
      sources.set(key, source);
      refresh();
      let idle: ReturnType<typeof setTimeout> | undefined;
      const take = (list: LoggedQuery[]) => {
        found += list.length;
        for (const q of list) ring.add(q);
      };
      return {
        push(chunk: string) {
          if (disposed) return;
          const n = chunk.split('\n').length - 1;
          source.lines += n;
          linesRead += n;
          take(reader.push(chunk));
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            if (disposed) return;
            take(reader.flush());
            refresh();
          }, IDLE_MS);
        },
        end() {
          if (idle) clearTimeout(idle);
          sources.delete(key);
          if (disposed) return;
          take(reader.flush());
          refresh();
        },
      };
    };

    /** 터미널 명령 하나의 출력을 끝까지 읽는다 */
    const consume = async (execution: vscode.TerminalShellExecution, terminal: vscode.Terminal) => {
      const src = openSource(execution, `터미널 "${terminal.name}"`);
      try {
        for await (const chunk of execution.read()) {
          if (disposed) break;
          src.push(chunk);
        }
      } catch {
        // 터미널이 닫히는 등으로 읽기가 끊김
      } finally {
        src.end();
      }
    };

    /**
     * Run · Debug 로 띄운 서버: 디버그 콘솔로 나가는 출력(output 이벤트)을 엿본다.
     * 출력이 터미널로 가는 설정(console: integratedTerminal)이면 여기로는 오지 않고 터미널 쪽에서 읽힌다
     */
    const debugTracker: vscode.DebugAdapterTrackerFactory = {
      createDebugAdapterTracker(session) {
        let src: ReturnType<typeof openSource> | undefined;
        return {
          onDidSendMessage(m: { type?: string; event?: string; body?: { category?: string; output?: string } }) {
            if (m.type !== 'event' || m.event !== 'output' || !m.body?.output) return;
            const cat = m.body.category ?? 'console';
            if (cat !== 'stdout' && cat !== 'stderr' && cat !== 'console') return;
            serverTerminals.output(session, m.body.output);
            (src ??= openSource(session, `디버그 "${session.name}"`)).push(m.body.output);
          },
          onWillStopSession: () => src?.end(),
          onExit: () => src?.end(),
        };
      },
    };

    /**
     * 고른 로그에서 읽기: 터미널에서 고른 글 → 편집기에서 고른 글 → 클립보드 순으로 찾아 쿼리를 넣는다.
     * 터미널의 고른 글은 복사 명령으로만 가져올 수 있어, 잠깐 클립보드를 쓰고 원래 내용으로 돌려 둔다
     */
    const readSelection = async () => {
      const before = await vscode.env.clipboard.readText();
      let text = '';
      let from = '터미널에서 고른 글';
      try {
        await vscode.env.clipboard.writeText('');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        text = await vscode.env.clipboard.readText();
      } catch {
        // 터미널이 없으면 다음 곳에서 찾는다
      } finally {
        await vscode.env.clipboard.writeText(before);
      }
      const editor = vscode.window.activeTextEditor;
      if (!text.trim() && editor && !editor.selection.isEmpty) {
        text = editor.document.getText(editor.selection);
        from = '편집기에서 고른 글';
      }
      if (!text.trim()) {
        text = before;
        from = '클립보드';
      }
      if (!text.trim()) {
        void vscode.window.showInformationMessage('읽을 로그가 없습니다. 터미널에서 SQL 로그(==> Preparing 줄부터 <== Total 까지)를 드래그해 고른 뒤 다시 실행하세요.');
        return;
      }
      const reader = newReader();
      const found = [...reader.push(text.endsWith('\n') ? text : text + '\n'), ...reader.flush()];
      const before2 = ring.excluded;
      const added = found.filter((q) => ring.add(q)).length;
      refresh();
      const skipped = ring.excluded - before2;
      if (!found.length) {
        void vscode.window.showInformationMessage(`${from}에서 SQL 로그를 찾지 못했습니다. ==> Preparing 줄이 들어 있게 골라 주세요.`);
        return;
      }
      void vscode.window.showInformationMessage(`${from}에서 쿼리 ${added}개를 넣었습니다${skipped ? ` (수집 필터로 ${skipped}개 뺌)` : ''}.`);
      if (added) pick();
    };

    const subs: vscode.Disposable[] = [
      { dispose: () => ((disposed = true), closeSqlLogPicker()) },
      status,
      vscode.commands.registerCommand('devBoost.sqlLog.pick', pick),
      vscode.commands.registerCommand('devBoost.sqlLog.readSelection', readSelection),
      vscode.debug.registerDebugAdapterTrackerFactory('*', debugTracker),
      ...serverTerminals.disposables,
      vscode.window.onDidOpenTerminal(refresh),
      vscode.window.onDidCloseTerminal(refresh),
      vscode.commands.registerCommand('devBoost.sqlLog.send', (id: number) => send(ring.get(Number(id)))),
      vscode.commands.registerCommand('devBoost.sqlLog.clear', () => {
        ring.clear();
        refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devBoost.dbConsole.sqlLog.maxQueries')) {
          ring.setMax(cfg().get<number>('maxQueries', 10));
          refresh();
        }
        // 필터를 바꾸면 이미 모인 목록에도 적용한다
        if (FILTER_SETTINGS.some((k) => e.affectsConfiguration(k))) {
          ring.setFilter(readFilter(), cfg().get<boolean>('latestOnly', false));
          refresh();
        }
      }),
    ];
    // 터미널 출력 읽기는 VS Code 1.93 부터 (그 전 버전에서는 명령만 등록되고 쿼리는 모이지 않는다)
    if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
      subs.push(vscode.window.onDidStartTerminalShellExecution((e) => void consume(e.execution, e.terminal)));
    }
    if (typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') subs.push(vscode.window.onDidChangeTerminalShellIntegration(refresh));
    refresh();
    return subs;
  },
};
