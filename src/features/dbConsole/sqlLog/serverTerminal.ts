import * as vscode from 'vscode';
import { MARK, redirectJavaLaunch, toTerminalText } from './launch';

/**
 * Run · Debug 로 띄운 Java 서버를 "읽을 수 있는 터미널" 에 보이기.
 *
 * Java 디버거가 서버를 자기 터미널(Debug: 앱 이름)에서 띄우면 VS Code 가 그 터미널의 출력을 확장에 넘겨주지 않는다 (셸 통합 없음).
 * 그래서 Java 실행 설정의 출력 곳을 디버그 콘솔(internalConsole)로 바꿔 출력을 디버그 출력 이벤트로 받고,
 * 그것을 이 확장이 만든 같은 이름의 터미널에 그대로 써서 보여 준다. 디버그 콘솔은 열지 않는다.
 * 사용자가 출력 곳을 따로 정해 둔 실행(internalConsole · externalTerminal)은 건드리지 않는다.
 */

/** 서버 하나를 보여 주는 터미널. 열리기 전에 온 출력은 모아 두었다가 연 뒤에 쓴다 */
class ServerTerminal {
  readonly terminal: vscode.Terminal;
  private readonly write = new vscode.EventEmitter<string>();
  private opened = false;
  private pending: string[] = [];
  ended = false;

  constructor(name: string, private readonly session: vscode.DebugSession) {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.write.event,
      open: () => {
        this.opened = true;
        for (const t of this.pending) this.write.fire(t);
        this.pending = [];
      },
      // 터미널을 닫으면 서버도 멈춘다 (Java 디버거의 터미널과 같게)
      close: () => {
        if (!this.ended) void vscode.debug.stopDebugging(this.session);
      },
      // Ctrl+C 는 서버 멈추기. 다른 입력은 서버에 보낼 곳이 없다 (디버그 콘솔로 받는 실행)
      handleInput: (data) => {
        if (data === '\x03' && !this.ended) void vscode.debug.stopDebugging(this.session);
      },
    };
    this.terminal = vscode.window.createTerminal({ name, pty, iconPath: new vscode.ThemeIcon('debug-alt') });
  }

  output(text: string) {
    const t = toTerminalText(text);
    if (this.opened) this.write.fire(t);
    else this.pending.push(t);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.output('\r\n\x1b[2m[서버가 끝났습니다 — 이 터미널은 닫아도 됩니다]\x1b[0m\r\n');
  }

  dispose() {
    this.terminal.dispose();
    this.write.dispose();
  }
}

/**
 * 실행 설정을 바꾸는 곳과 서버 터미널들. enabled() 가 false 면 아무것도 바꾸지 않는다 (설정 debugTerminal)
 */
export function registerServerTerminals(enabled: () => boolean) {
  const terminals = new Map<string, ServerTerminal>(); // 세션 id → 터미널
  const provider: vscode.DebugConfigurationProvider = {
    // 변수까지 풀린 마지막 단계에서 바꾼다 (Java 확장이 기본 출력 곳을 채운 뒤)
    resolveDebugConfigurationWithSubstitutedVariables: (_folder, config) => (enabled() ? redirectJavaLaunch(config) : config),
  };
  const subs: vscode.Disposable[] = [
    vscode.debug.registerDebugConfigurationProvider('java', provider),
    vscode.debug.onDidStartDebugSession((session) => {
      if (!session.configuration[MARK]) return;
      const name = `${session.configuration.noDebug ? 'Run' : 'Debug'}: ${session.name}`;
      // 같은 이름의 끝난 터미널은 닫고 새로 (다시 띄울 때 터미널이 쌓이지 않게)
      for (const [id, t] of terminals) {
        if (t.ended && t.terminal.name === name) {
          t.dispose();
          terminals.delete(id);
        }
      }
      const t = new ServerTerminal(name, session);
      terminals.set(session.id, t);
      t.terminal.show(true);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => terminals.get(session.id)?.end()),
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, t] of terminals) if (t.terminal === closed) terminals.delete(id);
    }),
    { dispose: () => terminals.forEach((t) => t.dispose()) },
  ];
  return {
    /** 이 확장이 만든 서버 터미널인지 */
    owns: (terminal: vscode.Terminal) => [...terminals.values()].some((t) => t.terminal === terminal),
    /** 디버그 출력 하나 (SQL 로그가 받은 것을 그대로 넘긴다) */
    output(session: vscode.DebugSession, text: string) {
      terminals.get(session.id)?.output(text);
    },
    disposables: subs,
  };
}
