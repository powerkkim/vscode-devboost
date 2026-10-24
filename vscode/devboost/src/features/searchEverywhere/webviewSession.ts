import * as vscode from 'vscode';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { SearchService, SearchItem, TabId } from './searchService';
import { SearchOptions, SCOPES, isScopeId } from './scope';

/**
 * Webview 화면(media/searchEverywhere.js)과 확장 사이의 공통 로직.
 * 담는 그릇이 에디터 탭(WebviewPanel)이든 하단/사이드 패널(WebviewView)이든 같은 코드를 쓴다.
 */

/** Webview → 확장 메시지 */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'search'; runId: number; tab: TabId; query: string; options?: Partial<SearchOptions> }
  | { type: 'toggleNonProject'; value: boolean }
  | { type: 'setOptions'; options: Partial<SearchOptions> }
  | { type: 'currentFolder' }
  | { type: 'open'; runId: number; index: number }
  | { type: 'close' };

/** 확장 → Webview 로 보내는 결과 한 줄 (Uri 같은 객체는 못 보내므로 문자열로 변환) */
export interface ResultRow {
  kind: SearchItem['kind'];
  /** codicon 이름 (symbol-class, symbol-method 등) → 화면에서 배지 글자/색 결정 */
  icon: string;
  label: string;
  secondary?: string; // 이름 옆 회색 글씨 (패키지 등)
  right?: string; // 오른쪽 정렬 (파일명:줄, 폴더 등)
  footer?: string; // 선택 시 하단에 보여줄 전체 경로
}

export interface SessionHost {
  /** 화면이 담긴 그릇 종류 (속도 기록용 이름) */
  readonly kindLabel: string;
  /** 항목을 열거나 Esc를 눌렀을 때 그릇을 닫거나 접는다 */
  close(): void;
  /** 결과를 열 에디터 위치. 패널 모드에서는 마지막으로 쓰던 에디터 자리 */
  targetColumn(): vscode.ViewColumn | undefined;
}

export class WebviewSession {
  private latestRunId = 0;
  private latestItems: SearchItem[] = [];
  private pendingInit: { tab: TabId; query: string } = { tab: 'all', query: '' };
  private openStartedAt = performance.now();
  private ready = false;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly service: SearchService,
    private readonly host: SessionHost
  ) {}

  /** 열기 명령: 화면이 준비됐으면 바로 init, 아니면 ready가 올 때 보낸다 */
  open(tab: TabId, query: string) {
    this.openStartedAt = performance.now();
    this.pendingInit = { tab, query };
    if (this.ready) {
      this.sendInit(0);
    }
  }

  private sendInit(openMs: number) {
    this.post({
      type: 'init',
      ...this.pendingInit,
      includeNonProject: this.service.includeNonProject,
      options: this.service.options,
      scopes: SCOPES,
      fileMasks: vscode.workspace.getConfiguration('devBoost.searchEverywhere').get<string[]>('fileMasks', []),
      recentIncludes: this.service.recentIncludes(),
      timing: showTiming(),
      openMs,
    });
  }

  post(msg: unknown) {
    void this.webview.postMessage(msg);
  }

  async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready': {
        // 화면이 처음 만들어지거나 다시 만들어질 때마다 온다
        this.ready = true;
        const openMs = Math.round(performance.now() - this.openStartedAt);
        this.service.log.appendLine(`[창] 열기(${this.host.kindLabel}) → 화면 준비 ${openMs}ms`);
        this.sendInit(openMs);
        break;
      }

      case 'toggleNonProject':
        this.service.includeNonProject = m.value;
        break;

      case 'setOptions':
        this.applyOptions(m.options);
        break;

      case 'currentFolder':
        this.post({ type: 'currentFolder', path: this.service.currentFolder() ?? '' });
        break;

      case 'search': {
        this.latestRunId = m.runId;
        if (m.options) {
          this.applyOptions(m.options);
        }
        try {
          const r = await this.service.searchTimed(m.tab, m.query, () => this.latestRunId !== m.runId);
          if (this.latestRunId !== m.runId) {
            return; // 더 최신 검색이 있음
          }
          this.latestItems = r.items;
          this.post({
            type: 'results',
            runId: m.runId,
            query: m.query,
            rows: r.items.map(toRow),
            timings: r.timings,
            totalMs: r.totalMs,
          });
        } catch (e) {
          this.post({ type: 'results', runId: m.runId, query: m.query, rows: [], error: String(e) });
        }
        break;
      }

      case 'open': {
        const item = m.runId === this.latestRunId ? this.latestItems[m.index] : undefined;
        const column = this.host.targetColumn();
        // 결과를 실제로 열었을 때의 포함 경로만 최근 목록에 남긴다 (입력 중간값 제외)
        this.service.rememberInclude(this.service.options.paths.include);
        this.host.close(); // 먼저 닫아야 원래 에디터 위치에 파일이 열린다
        if (item) {
          await this.service.open(item, column);
        }
        break;
      }

      case 'close':
        this.host.close();
        break;
    }
  }

  /** 화면에서 보낸 옵션을 검증해서 서비스에 반영 (잘못된 값은 무시) */
  private applyOptions(o: Partial<SearchOptions>) {
    const cur = this.service.options;
    const text = { ...cur.text };
    if (o.text) {
      if (typeof o.text.fileMask === 'string') text.fileMask = o.text.fileMask.slice(0, 200);
      if (typeof o.text.caseSensitive === 'boolean') text.caseSensitive = o.text.caseSensitive;
      if (typeof o.text.wholeWord === 'boolean') text.wholeWord = o.text.wholeWord;
      if (typeof o.text.regex === 'boolean') text.regex = o.text.regex;
    }
    const paths = { ...cur.paths };
    if (o.paths) {
      if (typeof o.paths.include === 'string') paths.include = o.paths.include.slice(0, 500);
      if (typeof o.paths.exclude === 'string') paths.exclude = o.paths.exclude.slice(0, 500);
    }
    this.service.options = { scope: isScopeId(o.scope) ? o.scope : cur.scope, text, paths };
  }

  /** 화면 HTML. layout: 'popup'=가운데 박스, 'fill'=그릇을 꽉 채움(패널용) */
  html(extensionUri: vscode.Uri, layout: 'popup' | 'fill'): string {
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    const css = this.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'searchEverywhere.css'));
    const js = this.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'searchEverywhere.js'));
    const nonce = makeNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${this.webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Search Everywhere</title>
</head>
<body class="layout-${layout}">
  <div class="popup" role="dialog" aria-label="Search Everywhere">
    <div class="header">
      <div class="tabs" role="tablist" id="tabs"></div>
      <div class="controls" id="controls">
        <select id="scope" class="ctl" title="검색 범위 (Alt+N: 프로젝트 ↔ 라이브러리 포함)"></select>
        <input id="fileMask" class="ctl text-only" list="fileMaskList" placeholder="모든 파일 타입" title="파일 타입 (예: *.java, *.xml)" spellcheck="false">
        <datalist id="fileMaskList"></datalist>
        <button id="optCase" class="toggle text-only" title="대소문자 구분 (Alt+C)">Cc</button>
        <button id="optWord" class="toggle text-only" title="단어 단위 (Alt+W)">W</button>
        <button id="optRegex" class="toggle text-only" title="정규식 (Alt+X)">.*</button>
        <button id="optFilter" class="toggle filter-btn" title="포함/제외 경로 (Alt+P)">필터</button>
      </div>
    </div>
    <div class="searchbar">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input id="query" type="text" spellcheck="false" autocomplete="off" aria-label="검색어">
      <span class="hint" id="hint">Tab: 탭 전환 · Enter: 열기 · Esc: 닫기</span>
    </div>
    <div class="filterbar hidden" id="filterbar">
      <label for="incl">포함</label>
      <input id="incl" class="ctl path" list="inclList" spellcheck="false" autocomplete="off"
             placeholder="예: src/main/java/com/demo/module/order, **/common/**">
      <datalist id="inclList"></datalist>
      <button id="useCurDir" class="linkbtn" title="지금 보고 있는 파일의 폴더를 포함에 넣기">현재 폴더</button>
      <label for="excl">제외</label>
      <input id="excl" class="ctl path" spellcheck="false" autocomplete="off" placeholder="예: **/dto/**, *Test.java">
      <button id="clearPaths" class="linkbtn" title="포함/제외 비우기">지우기</button>
    </div>
    <div class="results" id="results" role="listbox"></div>
    <div class="footer"><span class="footer-path" id="footer"></span><span class="footer-timing" id="timing"></span></div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

export function toRow(item: SearchItem): ResultRow {
  const base = { kind: item.kind, icon: item.icon, label: item.label };
  switch (item.kind) {
    case 'classes':
    case 'symbols':
      // description = 패키지/컨테이너, detail = 상대경로:줄
      return {
        ...base,
        secondary: item.description,
        right: item.detail ? fileAndLine(item.detail) : undefined,
        footer: item.detail,
      };
    case 'files':
      return {
        ...base,
        right: item.description,
        footer: item.description ? `${item.description}/${item.label}` : item.label,
      };
    case 'text':
      // description = 파일명:줄, detail = 상대경로
      return { ...base, right: item.description?.replace(/:(\d+)$/, ' $1'), footer: item.detail };
    case 'actions':
      // description = 넘어갈 화면 (명령 팔레트 / 설정 / 단축키)
      return { ...base, right: item.description, footer: 'Enter: VS Code의 해당 화면을 검색어가 채워진 상태로 엽니다' };
  }
}

/** "a/b/Foo.java:12" → "Foo.java 12" (IntelliJ 오른쪽 표시 형식) */
function fileAndLine(detail: string): string {
  const m = /^(.*):(\d+)$/.exec(detail);
  return m ? `${path.basename(m[1])} ${m[2]}` : path.basename(detail);
}

export function showTiming(): boolean {
  return vscode.workspace.getConfiguration('devBoost.searchEverywhere').get<boolean>('showTiming', true);
}

/** 에디터에서 한 줄짜리 선택이 있으면 검색어로 미리 채운다 (IntelliJ와 동일) */
export function selectedText(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return '';
  }
  const text = editor.document.getText(editor.selection);
  return text.includes('\n') ? '' : text.trim().slice(0, 200);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
