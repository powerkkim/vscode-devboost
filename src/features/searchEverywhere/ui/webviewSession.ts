import * as vscode from 'vscode';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { SearchService, SearchItem, SearchResult, TabId } from '../search/searchService';
import { SymbolThrottle } from '../search/symbolThrottle';
import { SearchOptions, SCOPES, isScopeId } from '../search/scope';

/**
 * Webview 화면(media/searchEverywhere.js)과 확장 사이의 공통 로직.
 * 담는 그릇이 에디터 탭(WebviewPanel)이든 하단/사이드 패널(WebviewView)이든 같은 코드를 쓴다.
 */

/** Webview → 확장 메시지 */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'search'; runId: number; tab: TabId; query: string; options?: Partial<SearchOptions>; limit?: number }
  | { type: 'toggleNonProject'; value: boolean }
  | { type: 'setOptions'; options: Partial<SearchOptions> }
  | { type: 'currentFolder' }
  | { type: 'open'; runId: number; index: number; seq?: number }
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

/** 언어 서버에 묻는 간격 */
const SYMBOL_INTERVAL_MS = 1000;
/** 세션이 같은 조건의 언어 서버 응답을 다시 쓰는 시간 (넘으면 다시 묻는다) */
const SYMBOL_REUSE_MS = 5000;
/** "언어 서버 결과 기다리는 중" 표시를 이 시간 뒤에는 끈다 */
const LS_WAIT_HINT_MS = 10000;

export class WebviewSession {
  private latestRunId = 0;
  /** 보낸 결과 묶음 번호 → 항목. 먼저 보낸 결과(partial)를 보고 Enter 를 눌러도 화면의 그 줄이 열리도록 */
  private sent = new Map<number, SearchItem[]>();
  private seq = 0;
  /** 언어 서버 요청: 1초 단위, 마지막 요청 응답만 (SymbolThrottle) */
  private readonly throttle: SymbolThrottle<vscode.SymbolInformation[]>;
  /** 마지막 언어 서버 응답 (같은 검색어·범위면 탭을 바꿔도 다시 묻지 않고 합친다) */
  private symbols: { key: string; list: vscode.SymbolInformation[]; time: number } | undefined;
  /** cancel() 마다 바뀌는 번호. 진행 중이던 검색은 이 번호가 달라지면 멈춘다 (latestRunId 는 그대로 둬서 화면의 결과는 계속 열 수 있게) */
  private gen = 0;
  /** 취소된 뒤 다시 보이면 검색을 새로 해야 함 */
  private cancelled = false;
  /** "언어 서버 결과 기다리는 중" 표시를 끝내는 타이머 (응답이 끝내 안 오는 경우) */
  private lsWaitTimer: ReturnType<typeof setTimeout> | undefined;
  /** 언어 서버 응답을 합칠 대상: 가장 최근 검색 결과 */
  private latest: { runId: number; query: string; key: string; result: SearchResult } | undefined;
  private pendingInit: { tab: TabId; query: string } = { tab: 'all', query: '' };
  private openStartedAt = performance.now();
  private ready = false;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly service: SearchService,
    private readonly host: SessionHost
  ) {
    this.throttle = new SymbolThrottle((q, key) => {
      // 1초를 기다리는 사이 범위·필터가 바뀌었으면 그 조건으로 묻지 않는다 (키와 실제 요청이 어긋나지 않게)
      if (this.service.symbolRequestKey(q) !== key) {
        this.service.logLine(`[언어서버] 요청 안 함 "${q}" (범위·필터가 바뀜)`);
        return Promise.reject(new Error('조건 변경'));
      }
      return this.service.requestSymbols(q);
    }, SYMBOL_INTERVAL_MS, (q) => this.service.logLine(`[언어서버] 응답 버림 "${q}" (그사이 새 검색어로 요청함)`));
  }

  /** 언어 서버 응답을 더 기다리지 않음: 화면의 "기다리는 중" 표시를 끈다 */
  private endLsWait(runId: number) {
    if (this.lsWaitTimer) clearTimeout(this.lsWaitTimer);
    this.lsWaitTimer = undefined;
    if (runId === this.latestRunId) this.post({ type: 'lsDone', runId });
  }

  /** 언어 서버 응답 도착: 지금 화면의 검색과 같은 조건이면 합쳐서 다시 보낸다 */
  private onSymbols(key: string, list: vscode.SymbolInformation[]) {
    // 응답을 기다리는 동안 범위·필터가 바뀌었으면 이 응답은 다른 조건의 것이라 버린다
    const l = this.latest;
    if (l && this.service.symbolRequestKey(l.query) !== key) {
      this.service.logLine('[언어서버] 응답 버림 (범위·필터가 바뀜)');
      this.endLsWait(l.runId);
      return;
    }
    this.symbols = { key, list, time: Date.now() };
    if (!l || l.key !== key || l.runId !== this.latestRunId || !l.result.withSymbols) {
      this.service.logLine('[언어서버] 응답을 화면에는 안 붙임 (검색어·탭이 바뀜, 5초 동안 재사용)');
      return; // 그사이 검색어·탭이 바뀜 → 다음 검색 때 캐시로 합쳐진다
    }
    if (this.lsWaitTimer) clearTimeout(this.lsWaitTimer);
    this.lsWaitTimer = undefined;
    const merged = l.result.withSymbols(list);
    const had = new Set(l.result.items);
    this.service.logLine(`[언어서버] "${l.query}" → 화면에 ${merged.items.filter((x) => !had.has(x)).length}건 추가`);
    this.post({
      type: 'results',
      runId: l.runId,
      seq: this.remember(merged.items),
      query: l.query,
      rows: merged.items.map(toRow),
      groups: merged.groups,
      timings: merged.timings,
      late: true,
    });
  }

  /**
   * 창이 닫히거나 숨겨질 때: 진행 중인 검색(rg)은 25ms 안에 멈추고(isStale), 언어 서버 응답은 버린다.
   * (언어 서버 요청 자체는 VS Code 가 취소 수단을 주지 않아 서버 안에서 끝까지 돈다)
   */
  cancel(reason?: string) {
    if (reason) this.service.logLine(`[검색] ${reason} → 진행 중 검색 중단, 늦게 오는 언어 서버 응답은 버림`);
    this.gen++;
    this.cancelled = true;
    this.latest = undefined;
    this.symbols = undefined;
    this.throttle.stop();
    if (this.lsWaitTimer) clearTimeout(this.lsWaitTimer);
    this.lsWaitTimer = undefined;
  }

  /** 다시 보일 때: 취소된 상태였으면 화면에 같은 검색을 다시 하라고 알린다 (결과가 낡았거나 중간에 멈췄을 수 있음) */
  resume() {
    if (this.cancelled) {
      this.cancelled = false;
      this.post({ type: 'rerun' });
    }
  }

  /** 열기 명령: 화면이 준비됐으면 바로 init, 아니면 ready가 올 때 보낸다 */
  open(tab: TabId, query: string) {
    this.openStartedAt = performance.now();
    this.service.warmUp(); // 입력하는 동안 클래스 색인·파일 목록을 미리 만든다 (이미 있으면 아무 일 없음)
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
      maxResults: vscode.workspace.getConfiguration('devBoost.searchEverywhere').get<number>('maxResults', 50),
      openMs,
    });
  }

  /** 보낼 결과 묶음을 기억하고 번호를 돌려준다 (최근 몇 개만 유지) */
  private remember(items: SearchItem[]): number {
    this.sent.set(++this.seq, items);
    this.sent.delete(this.seq - 4);
    return this.seq;
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
        const runId = m.runId;
        const gen = this.gen;
        this.cancelled = false;
        const isStale = () => this.latestRunId !== runId || this.gen !== gen;
        try {
          // 검색은 언어 서버를 기다리지 않는다 (rg 결과로 바로 확정)
          const r = await this.service.searchTimed(m.tab, m.query, isStale, m.limit);
          if (isStale()) {
            return; // 더 최신 검색이 있음 (또는 창이 닫힘)
          }
          let shown = r;
          let lsPending = false;
          if (r.withSymbols) {
            // 언어 서버로 보탤 수 있는 검색: 같은 조건의 응답이 이미 있으면 바로 합치고, 없으면 1초 단위로 요청
            const key = this.service.symbolRequestKey(m.query);
            this.latest = { runId, query: m.query, key, result: r };
            // 세션 캐시는 짧게만 (언어 서버 결과도 파일이 바뀌면 달라짐)
            if (this.symbols?.key === key && Date.now() - this.symbols.time < SYMBOL_REUSE_MS) {
              shown = { ...r.withSymbols(this.symbols.list), late: false };
            } else {
              lsPending = true;
              this.throttle.want(
                key,
                m.query,
                (q, k, list) => this.onSymbols(k, list),
                () => this.endLsWait(runId)
              );
              // 응답이 끝내 오지 않으면(언어 서버 멈춤) 표시만 끈다. 늦게라도 오면 그때 합친다
              if (this.lsWaitTimer) clearTimeout(this.lsWaitTimer);
              this.lsWaitTimer = setTimeout(() => this.endLsWait(runId), LS_WAIT_HINT_MS);
            }
          } else {
            this.latest = undefined;
            this.throttle.stop(); // 언어 서버가 필요 없는 탭(파일·텍스트 등): 대기 중인 요청도 버림
          }
          // 메서드·필드 색인이 아직 만들어지는 중이면, 다 되는 대로 같은 검색을 다시 하게 한다
          if (r.indexIncomplete) {
            void this.service.whenIndexComplete().then(() => {
              if (this.latestRunId === runId && this.gen === gen) this.post({ type: 'rerun' });
            });
          }
          this.post({
            type: 'results',
            runId,
            seq: this.remember(shown.items),
            query: m.query,
            rows: shown.items.map(toRow),
            groups: shown.groups,
            timings: shown.timings,
            totalMs: shown.totalMs,
            lsPending,
          });
        } catch (e) {
          this.post({ type: 'results', runId, query: m.query, rows: [], error: String(e) });
        }
        break;
      }

      case 'open': {
        const item = m.runId === this.latestRunId ? this.sent.get(m.seq ?? this.seq)?.[m.index] : undefined;
        const column = this.host.targetColumn();
        // 결과를 실제로 열었을 때의 포함 경로만 최근 목록에 남긴다 (입력 중간값 제외)
        this.service.rememberInclude(this.service.options.paths.include);
        this.cancel();
        this.host.close(); // 먼저 닫아야 원래 에디터 위치에 파일이 열린다
        if (item) {
          await this.service.open(item, column);
        }
        break;
      }

      case 'close':
        this.cancel('창 닫힘');
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
    const css = this.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'searchEverywhere', 'searchEverywhere.css'));
    const js = this.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'searchEverywhere', 'searchEverywhere.js'));
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
    case 'mappers':
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
