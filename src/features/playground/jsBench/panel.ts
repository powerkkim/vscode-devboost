import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { newNonce } from '../../../core/webview';
import { parseExamples } from './examples';
import { generatePipeline, PipelineSpec, OPS, AGGS } from './pipeline';
import { BenchResult, Mode, Run, failed, runs, startRun, viewOf } from './runner';

/**
 * JavaScript 작업대 화면.
 * 왼쪽: "예제"(찾기 · 목록 · 설명) · "고르기로 만들기". 가운데: 코드 위, 입력 데이터(data) 아래. 오른쪽: 실행 결과(출력 · 표).
 * 화면을 열 때만 예제를 읽어 보내고 여기에는 두지 않는다. 쓰던 코드 · 데이터는 화면 쪽이 기억해(탭을 가렸다 와도) 다시 그린다.
 */

const cfg = () => vscode.workspace.getConfiguration('devBoost.playground.jsBench');

interface Initial {
  code: string;
  typescript: boolean;
}

type Msg =
  | { type: 'ready' }
  | { type: 'run'; code: string; data: string; typescript: boolean }
  | { type: 'convert'; mode: Mode; data: string }
  | { type: 'stop' }
  | { type: 'generate'; spec: PipelineSpec }
  | { type: 'copy'; text: string; what: string }
  | { type: 'insert'; code: string };

let current: JsBenchPanel | undefined;

export function closeJsBench() {
  current?.dispose();
}

export function openJsBench(context: vscode.ExtensionContext, initial?: Initial) {
  if (!current) current = new JsBenchPanel(context);
  current.show(initial);
}

class JsBenchPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private readonly mediaRoot: vscode.Uri;
  private running: Run | undefined;
  /** 화면이 아직 준비되지 않았을 때 넣어 달라고 한 코드 */
  private pending: Initial | undefined;
  private ready = false;
  /** "편집기에 넣기" 가 쓸 편집기 — 마지막으로 쓰던 글 편집기 */
  private target: vscode.TextEditor | undefined = vscode.window.activeTextEditor;

  constructor(context: vscode.ExtensionContext) {
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'playground', 'jsBench');
    this.panel = vscode.window.createWebviewPanel('devBoost.jsBench', 'JavaScript 작업대', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [this.mediaRoot],
    });
    this.panel.iconPath = new vscode.ThemeIcon('beaker');
    this.panel.webview.onDidReceiveMessage((m: Msg) => void this.onMessage(m), null, this.subs);
    vscode.window.onDidChangeActiveTextEditor((e) => e && (this.target = e), null, this.subs);
    this.panel.onDidDispose(
      () => {
        this.running?.stop();
        this.subs.forEach((d) => d.dispose());
        if (current === this) current = undefined;
      },
      null,
      this.subs
    );
    this.panel.webview.html = this.html();
  }

  show(initial?: Initial) {
    this.panel.reveal(undefined, false);
    if (!initial) return;
    if (this.ready) void this.post({ type: 'use', ...initial });
    else this.pending = initial;
  }

  dispose() {
    this.panel.dispose();
  }

  private post(m: unknown) {
    return this.panel.webview.postMessage(m);
  }

  private async onMessage(m: Msg) {
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        let examples: unknown[] = [];
        let failedToRead = false;
        try {
          examples = parseExamples(await fs.promises.readFile(vscode.Uri.joinPath(this.mediaRoot, 'examples.txt').fsPath, 'utf8'));
        } catch {
          failedToRead = true;
        }
        await this.post({ type: 'init', examples, failedToRead, ops: OPS, aggs: AGGS, initial: this.pending });
        this.pending = undefined;
        return;
      }
      case 'run':
        return this.execute(m.typescript ? 'run-ts' : 'run-js', m.code, m.data);
      case 'convert':
        return this.execute(m.mode, '', m.data);
      case 'stop':
        this.running?.stop();
        return;
      case 'generate':
        return void this.post({ type: 'generated', code: generatePipeline(m.spec) });
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return void this.post({ type: 'status', text: `${m.what} 복사했습니다.` });
      case 'insert':
        return this.insert(m.code);
    }
  }

  /** 쓸 Node: 설정에 적은 것, 없으면 VS Code 에 들어 있는 것 */
  private node(): { node: string; electron: boolean } {
    const set = cfg().get<string>('nodePath', '').trim();
    return set ? { node: set, electron: false } : { node: process.execPath, electron: !!process.versions.electron };
  }

  /** typescript/lib 폴더: 작업 폴더의 node_modules → VS Code 에 들어 있는 것 */
  private tsLib(): string | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => path.join(f.uri.fsPath, 'node_modules', 'typescript', 'lib'));
    roots.push(path.join(vscode.env.appRoot, 'extensions', 'node_modules', 'typescript', 'lib'));
    return roots.find((dir) => fs.existsSync(path.join(dir, 'typescript.js')));
  }

  private async execute(mode: Mode, code: string, data: string) {
    if (this.running) return;
    let tsLib: string | undefined;
    if (mode === 'run-ts') {
      tsLib = this.tsLib();
      if (!tsLib) return void this.post({ type: 'done', status: 'TypeScript 를 찾지 못했습니다. 작업 폴더에 typescript 를 설치하거나 JavaScript 로 실행하세요.', error: true });
    }
    const timeoutMs = Math.min(60, Math.max(1, cfg().get<number>('timeoutSeconds', 5))) * 1000;
    const run = startRun({ ...this.node(), harness: vscode.Uri.joinPath(this.mediaRoot, 'harness.js').fsPath, mode, code, data, tsLib, timeoutMs });
    this.running = run;
    void this.post({ type: 'running', convert: !runs(mode) });
    let result: BenchResult | undefined;
    let failure = '';
    try {
      result = await run.done;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (this.running !== run) return;
    this.running = undefined;
    if (!result) return void this.post({ type: 'done', status: `Node.js 를 띄우지 못했습니다: ${failure}`, error: true });
    if (!runs(mode)) return void this.post(convertDone(mode, result));
    const seconds = (result.elapsedMs / 1000).toFixed(2);
    const bad = failed(result);
    const status = result.timedOut
      ? `${timeoutMs / 1000}초가 넘어 멈췄습니다. 끝나지 않는 반복이나 기다림이 있는지 보세요.`
      : result.truncated
        ? '출력이 너무 많아 멈췄습니다. 반복 안의 console.log 를 줄여 보세요.'
        : result.cancelled
          ? '멈췄습니다.'
          : bad
            ? `오류 · ${seconds}초 · "출력" 탭을 보세요.`
            : `끝 · ${seconds}초`;
    void this.post({ type: 'done', status, error: bad, ...viewOf(result) });
  }

  private async insert(code: string) {
    const editor = this.target;
    const open = editor && vscode.window.visibleTextEditors.includes(editor);
    if (!editor || !open) return void this.post({ type: 'status', text: '넣을 편집기가 없습니다. "코드 복사" 로 붙여 넣으세요.', error: true });
    const ok = await editor.edit((b) => b.replace(editor.selection, code));
    void this.post(ok ? { type: 'status', text: `편집기에 넣었습니다 (${path.basename(editor.document.fileName)}).` } : { type: 'status', text: '편집기가 읽기 전용입니다. "코드 복사" 로 붙여 넣으세요.', error: true });
  }

  private html(): string {
    const wv = this.panel.webview;
    const css = wv.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'jsBench.css'));
    const js = wv.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'jsBench.js'));
    const nonce = newNonce();
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${css}" rel="stylesheet">
  <title>JavaScript 작업대</title>
</head>
<body>
  <div class="wrap">
    <section class="col left">
      <div class="head">
        <label><input type="radio" name="leftTab" value="examples" checked> 예제</label>
        <label><input type="radio" name="leftTab" value="pipeline"> 고르기로 만들기</label>
      </div>
      <div class="pane" id="examplesPane">
        <input id="search" type="text" placeholder="찾기 (예: 날짜, 금액, 중복, 트리, 초성)" spellcheck="false" autocomplete="off">
        <div id="list" tabindex="0"></div>
        <div id="desc"></div>
      </div>
      <div class="pane hidden" id="pipelinePane">
        <div class="note warn hidden" id="noData">먼저 가운데 "입력 데이터" 에 엑셀 표(첫 줄이 칸 이름)나 JSON 배열을 붙여 넣으세요. 칸 이름이 아래 상자들에 채워집니다.</div>
        <div class="note">입력 데이터(객체 배열)의 칸을 골라 가공 코드를 만듭니다. 쓰지 않는 단계는 비워 둡니다. 순서는 거르기 → 중복 빼기 → 묶기 → 정렬 → 앞에서 몇 개입니다. 묶은 뒤에는 묶은 칸이나 집계 칸(SUM_금액 등)으로 정렬하세요.</div>
        <datalist id="columns"></datalist>
        <div class="form">
          <label>거를 칸</label><input id="pFilterColumn" list="columns" spellcheck="false">
          <label>조건</label><select id="pFilterOp"></select>
          <label>값</label><input id="pFilterValue" placeholder="비교할 값" spellcheck="false">
          <hr>
          <label>중복 뺄 칸</label><input id="pDistinct" list="columns" spellcheck="false">
          <hr>
          <label>묶을 칸</label><input id="pGroup" list="columns" spellcheck="false">
          <label>집계</label><select id="pAgg"></select>
          <label>집계할 칸</label><input id="pAggColumn" list="columns" spellcheck="false">
          <hr>
          <label>정렬 칸</label><input id="pSort" list="columns" spellcheck="false">
          <label>순서</label><select id="pOrder"><option value="asc">작은 것부터</option><option value="desc">큰 것부터</option></select>
          <label>앞에서 몇 개</label><input id="pLimit" type="number" min="0" max="100000" step="10" value="0" title="0 = 모두">
        </div>
        <button class="primary" id="pMake">코드 만들고 실행</button>
      </div>
    </section>
    <section class="col center">
      <div class="head">
        <span class="title">코드 <span class="dim">(Ctrl+Enter 로 실행)</span></span>
        <label><input type="radio" name="lang" value="js" checked> JavaScript</label>
        <label><input type="radio" name="lang" value="ts"> TypeScript</label>
      </div>
      <textarea id="code" spellcheck="false" placeholder="코드를 쓰거나 왼쪽에서 예제를 고르세요."></textarea>
      <div class="head">
        <span class="title">입력 데이터 <span class="dim">(data)</span></span>
        <select id="convert">
          <option value="">바꾸기…</option>
          <option value="tsv">엑셀 표 → JSON 배열 (데이터 칸을 바꿈)</option>
          <option value="camel">칸 이름 USER_NM → userNm (데이터 칸을 바꿈)</option>
          <option value="pretty">JSON 보기 좋게 줄 맞추기 (데이터 칸을 바꿈)</option>
          <option value="ts">JSON → TypeScript 타입 (출력에 만듦)</option>
          <option value="props">JSON → Vue defineProps (출력에 만듦)</option>
        </select>
      </div>
      <textarea id="data" spellcheck="false" placeholder="JSON 이나 엑셀 표를 붙이면 코드에서 data 로 씁니다."></textarea>
      <div class="acts">
        <button class="primary" id="run">실행</button>
        <button id="stop" disabled>멈추기</button>
        <button id="undo" disabled>되돌리기</button>
        <span class="sp"></span>
        <button id="copyCode">코드 복사</button>
        <button id="insert">편집기에 넣기</button>
      </div>
    </section>
    <section class="col right">
      <div class="head">
        <label><input type="radio" name="resultTab" value="output" checked> 출력</label>
        <label><input type="radio" name="resultTab" value="table"> 표</label>
        <select id="tablePick" class="hidden"></select>
        <span class="sp"></span>
        <button id="copyOutput">출력 복사</button>
      </div>
      <pre id="output" class="pane"></pre>
      <div id="tablePane" class="pane hidden"><div id="tableNote" class="note hidden"></div><div id="tableWrap"></div></div>
      <div id="status"></div>
    </section>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** 바꾸기 결과: 데이터를 바꾸는 것은 데이터 칸에, 코드를 만드는 것은 출력에 놓는다 */
export function convertDone(mode: Mode, result: BenchResult): Record<string, unknown> {
  const out = [...result.events].reverse().find((e) => e.kind === 'out')?.text;
  if (out === undefined || failed(result)) {
    const errors = result.events
      .filter((e) => e.kind === 'error' || e.kind === 'text')
      .map((e) => e.text.split('\n')[0])
      .join(' ')
      .trim();
    return { type: 'done', status: `바꾸지 못했습니다: ${errors}`, error: true };
  }
  return mode === 'ts' || mode === 'props'
    ? { type: 'done', status: '만든 코드를 "출력" 에 놓았습니다. "출력 복사" 로 가져가세요.', output: out, tables: [] }
    : { type: 'done', status: '입력 데이터를 바꿨습니다. "되돌리기" 로 돌아갈 수 있습니다.', data: out };
}
