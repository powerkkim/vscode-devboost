import * as vscode from 'vscode';
import { LoggedQuery, consoleText, displaySql, excludeWords, queryInfo, queryMapper, queryTitle, summarize } from './parse';
import { newNonce } from '../../../core/webview';

/**
 * 최근 쿼리를 고르는 창: 왼쪽 목록(종류·쿼리 id·테이블·조건), 오른쪽에 고른 쿼리의 전체 SQL.
 * 창을 연 순간의 목록을 그대로 보여 준다 — 그 뒤에 들어온 쿼리는 다시 열어야 보인다 (고르는 동안 목록이 밀리지 않게).
 * 다른 곳을 누르면 닫힌다.
 * 고른 쿼리의 쿼리 id · 테이블을 "수집 제외" 에 더할 수 있다 — 더하면 이 창의 목록에서도 그 쿼리들을 뺀다.
 */

type Entry = LoggedQuery & { id: number };

interface Deps {
  /** 지금의 최근 쿼리 (새 것부터) */
  items: () => readonly Entry[];
  /** 고른 쿼리를 DB 콘솔로 */
  send: (q: LoggedQuery) => Promise<void>;
  timeText: (ms: number) => string;
  /** 수집 필터로 뺀 쿼리 수 */
  excluded: () => number;
  /** 낱말을 수집 제외에 더한다 */
  exclude: (word: string) => Promise<void>;
  /** 지금 필터를 통과하는지 */
  accepts: (q: LoggedQuery) => boolean;
}

let current: vscode.WebviewPanel | undefined;

export function closeSqlLogPicker() {
  current?.dispose();
}

export function showSqlLogPicker(context: vscode.ExtensionContext, deps: Deps) {
  current?.dispose(); // 다시 열면 최신 목록으로
  // 연 순간의 목록 (쿼리 객체는 건수·시간이 나중에 채워질 수 있어 값으로 떠 둔다)
  let snapshot: Entry[] = deps.items().map((q) => ({ ...q }));
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'dbConsole', 'sqlLog');
  const panel = vscode.window.createWebviewPanel(
    'devBoost.sqlLog',
    'SQL 로그',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [mediaRoot] }
  );
  current = panel;
  panel.iconPath = new vscode.ThemeIcon('database');
  const subs: vscode.Disposable[] = [];
  let sending = false;

  const post = () =>
    panel.webview.postMessage({
      type: 'init',
      openedAt: deps.timeText(Date.now()),
      excluded: deps.excluded(),
      items: snapshot.map((q) => ({
        id: q.id,
        title: queryTitle(q),
        mapper: queryMapper(q),
        ...summarize(q.sql),
        info: queryInfo(q),
        time: deps.timeText(q.time),
        warn: q.warn ?? '',
        sql: displaySql(q),
        excludes: excludeWords(q),
      })),
    });

  panel.webview.onDidReceiveMessage(
    async (m: { type: string; id?: number; word?: string }) => {
      const q = snapshot.find((x) => x.id === m.id);
      if (m.type === 'ready') {
        void post();
      } else if (m.type === 'close') {
        panel.dispose();
      } else if (m.type === 'copy' && q) {
        await vscode.env.clipboard.writeText(consoleText(q, deps.timeText(q.time)));
        void panel.webview.postMessage({ type: 'copied' });
      } else if (m.type === 'exclude' && m.word) {
        try {
          await deps.exclude(m.word);
        } catch (e) {
          void panel.webview.postMessage({ type: 'excluded', word: m.word, ids: [], error: String(e instanceof Error ? e.message : e) });
          return;
        }
        const gone = snapshot.filter((x) => !deps.accepts(x)).map((x) => x.id);
        snapshot = snapshot.filter((x) => !gone.includes(x.id));
        void panel.webview.postMessage({ type: 'excluded', word: m.word, ids: gone, excluded: deps.excluded() });
      } else if (m.type === 'send' && q && !sending) {
        sending = true; // 콘솔이 열리며 포커스가 옮겨 가도 여기서 닫는다
        panel.dispose();
        await deps.send(q);
      }
    },
    null,
    subs
  );
  panel.onDidChangeViewState((e) => !e.webviewPanel.active && panel.dispose(), null, subs);
  panel.onDidDispose(
    () => {
      if (current === panel) current = undefined;
      subs.forEach((d) => d.dispose());
    },
    null,
    subs
  );

  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'picker.css'));
  const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'picker.js'));
  const n = newNonce();
  panel.webview.html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${n}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${css}" rel="stylesheet">
  <title>SQL 로그</title>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <input id="filter" type="text" placeholder="테이블 · 이름 · 값으로 찾기 (띄어 쓰면 모두 포함)" spellcheck="false" autocomplete="off">
      <span class="count" id="count"></span>
    </div>
    <div class="main">
      <div id="list"></div>
      <div class="right">
        <div id="head"></div>
        <pre id="sql"></pre>
        <div class="acts">
          <button class="primary" id="send">새 콘솔로 옮기기</button>
          <button id="copy">복사</button>
        </div>
        <div class="excl"><span class="lbl" title="누르면 앞으로 이 쿼리 id · 테이블이 든 쿼리는 모으지 않습니다 (설정 exclude 에 더함)">수집 제외</span><span id="exclBtns"></span></div>
      </div>
    </div>
    <div class="foot">
      <span><kbd>↑</kbd> <kbd>↓</kbd> 이동</span>
      <span><kbd>Enter</kbd> 새 콘솔로 (실행은 직접)</span>
      <span><kbd>Ctrl+C</kbd> 복사</span>
      <span><kbd>Esc</kbd> 닫기</span>
      <span class="sp"></span>
      <span id="note"></span>
      <span id="filtered"></span>
      <span id="opened"></span>
    </div>
  </div>
  <script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}
