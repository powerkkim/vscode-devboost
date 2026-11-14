import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { newNonce } from '../../../core/webview';
import { CharKind, KINDS, NEEDS, Need, PROBLEMS, Part, Repeating, Shape, ask, compose, guess, javaReplacement, parsePresets, problem, toCode } from './compose';
import { RegexEngine, RegexRequest } from './engine';

/**
 * 정규식 작업대 화면.
 * 위: 만들기 탭 넷(자주 쓰는 것 · 질문 따라가기 · 예시로 만들기 · 직접 만들기). 가운데: 패턴 · 플래그 · 시험 글 · 확인할 글.
 * 오른쪽: 일치(시험 글에 표시) · 그룹 표 · 바꾸기. 아래: 코드(JavaScript /…/ · Java Pattern.compile) 복사 · 편집기에 넣기.
 * 일치 계산은 따로 띄운 스레드에서 하고(engine.ts), 화면을 닫으면 그 스레드도 끝낸다.
 */
const cfg = () => vscode.workspace.getConfiguration('devBoost.playground.regexBench');
const FRONT_LANGS = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'html']);

export interface RegexInitial {
  sample?: string;
  flavor?: 'js' | 'java';
}

type Msg =
  | { type: 'ready' }
  | { type: 'run'; id: number; q: RegexRequest }
  | { type: 'compose'; parts: Part[]; shape: Shape }
  | { type: 'ask'; whole: boolean; kinds: CharKind[]; extra: string; length: Repeating; spaced: boolean; needs: Need[] }
  | { type: 'guess'; good: string[]; bad: string[] }
  | { type: 'code'; flavor: 'js' | 'java'; pattern: string; flags: string; replacement: string }
  | { type: 'copy'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'flavor'; flavor: 'js' | 'java' };

let current: RegexBenchPanel | undefined;

export function closeRegexBench() {
  current?.dispose();
}

export function openRegexBench(context: vscode.ExtensionContext, initial?: RegexInitial) {
  if (!current) current = new RegexBenchPanel(context);
  current.show(initial);
}

/** 편집기의 언어로 고를 문법 */
export function flavorOf(languageId: string | undefined): 'js' | 'java' | undefined {
  if (!languageId) return undefined;
  return FRONT_LANGS.has(languageId) ? 'js' : 'java';
}

class RegexBenchPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private readonly mediaRoot: vscode.Uri;
  private readonly engine = new RegexEngine();
  private ready = false;
  private pending: RegexInitial | undefined;
  private target: vscode.TextEditor | undefined = vscode.window.activeTextEditor;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'playground', 'regexBench');
    this.panel = vscode.window.createWebviewPanel('devBoost.regexBench', '정규식 작업대', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [this.mediaRoot],
    });
    this.panel.iconPath = new vscode.ThemeIcon('regex');
    this.panel.webview.onDidReceiveMessage((m: Msg) => void this.onMessage(m), null, this.subs);
    vscode.window.onDidChangeActiveTextEditor((e) => e && (this.target = e), null, this.subs);
    this.panel.onDidDispose(
      () => {
        this.engine.dispose();
        this.subs.forEach((d) => d.dispose());
        if (current === this) current = undefined;
      },
      null,
      this.subs
    );
    this.panel.webview.html = this.html();
  }

  show(initial?: RegexInitial) {
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
        let presets: unknown[] = [];
        try {
          presets = parsePresets(await fs.promises.readFile(vscode.Uri.joinPath(this.mediaRoot, 'presets.tsv').fsPath, 'utf8'));
        } catch {
          // 자주 쓰는 것만 비고 나머지는 그대로 쓴다
        }
        const flavor = this.context.globalState.get<'js' | 'java'>('devBoost.regexBench.flavor', 'java');
        await this.post({ type: 'init', presets, kinds: Object.keys(KINDS), needs: Object.keys(NEEDS), flavor, initial: this.pending });
        this.pending = undefined;
        return;
      }
      case 'run': {
        const timeoutMs = Math.min(10, Math.max(0.2, cfg().get<number>('timeoutSeconds', 1))) * 1000;
        const result = await this.engine.run(m.q, timeoutMs);
        return void this.post({ type: 'result', id: m.id, result, timeoutMs });
      }
      case 'compose': {
        const p = problem(m.parts);
        return void this.post(p ? { type: 'made', from: 'compose', problem: PROBLEMS[p] } : { type: 'made', from: 'compose', pattern: compose(m.parts, m.shape), lines: !!m.shape.whole });
      }
      case 'ask': {
        const pattern = ask(m.whole, m.kinds, m.extra, m.length, m.spaced, m.needs);
        return void this.post(pattern === undefined ? { type: 'made', from: 'ask', problem: PROBLEMS.NO_KINDS } : { type: 'made', from: 'ask', pattern, lines: m.whole });
      }
      case 'guess': {
        const g = guess(m.good, m.bad);
        return void this.post(
          g
            ? { type: 'made', from: 'guess', pattern: g.pattern, lines: true, sample: [...m.good, ...m.bad].join('\n'), rejectsAll: g.rejectsAll }
            : { type: 'made', from: 'guess', problem: '맞아야 할 글을 한 줄에 하나씩 넣으세요.' }
        );
      }
      case 'code': {
        const code = toCode(m.flavor, m.pattern, m.flags);
        const replace = m.replacement ? (m.flavor === 'js' ? `text.replace(${code}, ${JSON.stringify(m.replacement)})` : `${code}.matcher(text).replaceAll(${JSON.stringify(javaReplacement(m.replacement))})`) : '';
        return void this.post({ type: 'code', code, replace });
      }
      case 'flavor':
        return void this.context.globalState.update('devBoost.regexBench.flavor', m.flavor);
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return void this.post({ type: 'status', text: '복사했습니다.' });
      case 'insert': {
        const editor = this.target;
        if (!editor || !vscode.window.visibleTextEditors.includes(editor)) return void this.post({ type: 'status', text: '넣을 편집기가 없습니다. "복사" 로 붙여 넣으세요.', error: true });
        const ok = await editor.edit((b) => b.replace(editor.selection, m.text));
        return void this.post(ok ? { type: 'status', text: `편집기에 넣었습니다 (${path.basename(editor.document.fileName)}).` } : { type: 'status', text: '편집기가 읽기 전용입니다. "복사" 로 붙여 넣으세요.', error: true });
      }
    }
  }

  private html(): string {
    const wv = this.panel.webview;
    const css = wv.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'regexBench.css'));
    const js = wv.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, 'regexBench.js'));
    const nonce = newNonce();
    const kind = (k: string, label: string, name: string) => `<label><input type="checkbox" name="${name}" value="${k}"> ${label}</label>`;
    const KIND_LABEL: Record<string, string> = { KOREAN: '한글', UPPER: '영문 대문자', LOWER: '영문 소문자', DIGIT: '숫자', SPACE: '공백', SYMBOL: '특수문자' };
    const NEED_LABEL: Record<string, string> = { LETTER: '영문', UPPER: '영문 대문자', LOWER: '영문 소문자', DIGIT: '숫자', SYMBOL: '특수문자', KOREAN: '한글' };
    const kinds = (name: string) => Object.keys(KINDS).map((k) => kind(k, KIND_LABEL[k], name)).join('');
    const needs = (name: string) => Object.keys(NEEDS).map((k) => kind(k, NEED_LABEL[k], name)).join('');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${css}" rel="stylesheet">
  <title>정규식 작업대</title>
</head>
<body>
  <div class="wrap">
    <section class="make">
      <div class="tabs">
        <label><input type="radio" name="make" value="presets" checked> 자주 쓰는 것</label>
        <label><input type="radio" name="make" value="ask"> 질문 따라가기</label>
        <label><input type="radio" name="make" value="examples"> 예시로 만들기</label>
        <label><input type="radio" name="make" value="compose"> 직접 만들기</label>
        <span class="sp"></span>
        <button id="fold" title="만들기 칸 접기 · 펴기">▲</button>
      </div>
      <div class="body" id="makeBody">
        <div class="pane" id="presetsPane"><input id="presetSearch" type="text" placeholder="찾기 (예: 휴대폰, 날짜, 금액)" spellcheck="false"><div id="presets"></div></div>
        <div class="pane hidden form" id="askPane">
          <label>1. 어디에 쓰나요?</label>
          <div><label><input type="radio" name="askWhere" value="whole" checked> 입력값 검사 (글 전체가 이 모양)</label> <label><input type="radio" name="askWhere" value="find"> 글 안에서 찾기</label></div>
          <label>2. 어떤 글자인가요?</label><div class="checks">${kinds('askKind')}</div>
          <label>3. 그 밖의 글자</label><input id="askExtra" type="text" placeholder="종류 말고 더 넣을 글자 (예: -_.)" spellcheck="false">
          <label>4. 몇 자인가요?</label>
          <div><select id="askLength"><option value="ONE_OR_MORE">상관없음 (1자 이상)</option><option value="EXACTLY">정확히</option><option value="RANGE">몇 자에서 몇 자</option><option value="AT_LEAST">몇 자 이상</option></select>
            <input id="askN" type="number" min="0" value="1" class="num hidden"><span id="askTilde" class="hidden">~</span><input id="askM" type="number" min="0" value="10" class="num hidden"><span id="askTail" class="hidden">자</span></div>
          <label>5. 띄어쓰기</label><label><input type="checkbox" id="askSpaced"> 낱말 사이 띄어쓰기 한 칸 허용 (예: 김 철수, 글자 수는 낱말마다)</label>
          <label class="whole">6. 꼭 들어갈 것</label><div class="checks whole">${needs('askNeed')}</div>
        </div>
        <div class="pane hidden" id="examplesPane">
          <div class="two">
            <div><div class="lbl">맞아야 할 글 (한 줄에 하나)</div><textarea id="good" spellcheck="false" placeholder="예: 홍길동, 김 철수"></textarea></div>
            <div><div class="lbl">틀려야 할 글 (없어도 됨)</div><textarea id="bad" spellcheck="false" placeholder="예: 홍길동1, Hong"></textarea></div>
          </div>
          <div class="row"><button class="primary" id="guess">패턴 만들기</button><span id="guessNote"></span></div>
        </div>
        <div class="pane hidden" id="composePane">
          <div class="row">
            <label><input type="checkbox" id="cWhole"> 글 전체가 이 모양 (입력값 검사)</label>
            <label><input type="checkbox" id="cWord"> 낱말 단위로만</label>
            <span class="cwhole">꼭 들어갈 것: <span class="checks">${needs('cNeed')}</span> 글자 수 <input id="cMin" type="number" min="0" value="0" class="num"> 자 이상</span>
          </div>
          <div id="parts"></div>
          <div class="row"><button id="addPiece">＋ 조각</button><button id="addBunch">＋ 묶음 (조각 여럿을 함께 반복 · 또는)</button><span id="composeNote" class="dim">＋ 로 조각을 더해 고르면 패턴이 만들어집니다.</span></div>
        </div>
      </div>
    </section>
    <section class="pattern">
      <div class="row">
        <span class="slash">/</span><input id="pattern" type="text" spellcheck="false" autocomplete="off" placeholder="위 탭에서 만들어지거나 직접 칩니다"><span class="slash">/</span>
        <span class="flags">
          <label title="전체 찾기"><input type="checkbox" name="flag" value="g" checked> g 전체</label>
          <label title="대소문자 무시"><input type="checkbox" name="flag" value="i"> i 대소문자 무시</label>
          <label title="^ $ 가 줄마다"><input type="checkbox" name="flag" value="m"> m 줄마다</label>
          <label title=". 이 줄바꿈도"><input type="checkbox" name="flag" value="s"> s 줄바꿈도</label>
          <label title="유니코드"><input type="checkbox" name="flag" value="u"> u 유니코드</label>
        </span>
      </div>
      <div class="row">
        <span class="lbl">확인할 글</span><input id="check" type="text" spellcheck="false" placeholder="낱말을 치면 맞는지 바로 봅니다"><span id="verdict"></span>
      </div>
    </section>
    <section class="main">
      <div class="col">
        <div class="head"><span class="title">시험 글</span><span class="sp"></span><span id="count" class="dim"></span></div>
        <div class="sampleBox"><div id="marks" aria-hidden="true"></div><textarea id="sample" spellcheck="false" placeholder="맞춰 볼 글을 붙여 넣으세요. 맞는 곳이 표시됩니다."></textarea></div>
      </div>
      <div class="col">
        <div class="head">
          <label><input type="radio" name="resTab" value="groups" checked> 그룹</label>
          <label><input type="radio" name="resTab" value="replace"> 바꾸기</label>
        </div>
        <div class="pane" id="groupsPane"><div id="groups"></div></div>
        <div class="pane hidden" id="replacePane">
          <div class="row"><span class="lbl">바꿀 글</span><input id="replacement" type="text" spellcheck="false" placeholder="$1 그룹 · $<이름> 이름 그룹 · $& 일치 전체 · $$ 는 $ 글자"></div>
          <pre id="replaced"></pre>
        </div>
      </div>
    </section>
    <section class="code">
      <select id="flavor"><option value="java">Java (백엔드)</option><option value="js">JavaScript (프론트)</option></select>
      <code id="codeText"></code>
      <button id="copy">복사</button>
      <button id="insert">편집기에 넣기</button>
      <span id="status"></span>
    </section>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
