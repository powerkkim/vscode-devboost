import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { findRipgrep, findRipgrepOnPath, runRipgrep, listFiles, splitGlobs, RgMatch, RG_MAX_PER_FILE } from './ripgrep';
import { GlobMatcher } from './glob';
import {
  SearchOptions,
  DEFAULT_OPTIONS,
  FileFacts,
  scopeAccepts,
  fileMaskToGlobs,
  TEST_GLOBS,
  buildTextRegExp,
  isScopeId,
  splitPathList,
  normalizePathEntry,
  pathListToGlobs,
  hasPathFilter,
} from './scope';
import { RecentFiles, gitChangedFiles } from './recent';
import { ClassIndex, ClassEntry } from './classIndex';
import { MapperIndex } from './mapperIndex';
import { FileIndex } from './fileIndex';
import { SpringEntry, createSpringIndex } from './springIndex';

export type TabId = 'all' | 'classes' | 'files' | 'symbols' | 'mappers' | 'spring' | 'actions' | 'text';
export type ResultKind = Exclude<TabId, 'all'>;

export interface SearchItem {
  kind: ResultKind;
  label: string;
  description?: string;
  detail?: string;
  icon: string;
  /** 선택(Enter) 시 열 대상 */
  uri?: vscode.Uri;
  range?: vscode.Range;
  /** 열 때 그 줄에서 label(클래스 이름)을 찾아 선택한다 (클래스 색인 결과는 줄만 알고 있음) */
  selectName?: boolean;
  /** 액션 탭 전용: 실행할 커맨드 ID와 인자 */
  command?: string;
  args?: unknown[];
}

/** 검색 단계 하나의 소요 시간 (속도 측정용) */
export interface SearchTiming {
  /** 단계 이름: 클래스 / 심볼 / Mapper / 파일 / 텍스트 / 액션 */
  part: string;
  ms: number;
  /** 이 단계에서 나온 결과 수 */
  count: number;
  /** 추가 정보: 색인 개수, rg/파일 직접 읽기 등 */
  note?: string;
}

/** 종류별 개수: 화면에 보인 수 / 전체 수. 잘렸으면 화면이 "더 보기"를 붙인다 */
export interface GroupCount {
  kind: ResultKind;
  shown: number;
  total: number;
  /** 전체 수가 상한에 걸려 실제로는 더 많을 수 있음 (텍스트 2,000건 등) */
  capped?: boolean;
}

export interface SearchResult {
  items: SearchItem[];
  timings: SearchTiming[];
  /** 확장(Node) 쪽에서 검색에 걸린 전체 시간 */
  totalMs: number;
  groups: GroupCount[];
  /** 먼저 보내는 결과 (모두 탭에서 텍스트를 빼고) — 뒤에 최종 결과가 온다 */
  partial?: boolean;
  /** 메서드·필드 색인이 아직 만들어지는 중이라 결과에 빠졌을 수 있음 (whenIndexComplete 뒤 다시 검색) */
  indexIncomplete?: boolean;
}

/** 하위 검색이 전체 개수를 알려 주는 통로 */
type CountSink = (total: number, capped?: boolean) => void;

const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB 넘는 파일은 텍스트 검색에서 제외
/**
 * 텍스트 검색에서 정렬 전에 모으는 최대 매치 수. 이만큼 모은 뒤 우선순위(열린 파일 → src → …)로 정렬해 보여 준다.
 * 흔한 단어도 이 정도는 금방 모인다(수십 ms). 끝까지 다 모으면 큰 프로젝트에서 1초 가까이 걸린다.
 */
const TEXT_COLLECT_MAX = 2000;

function config() {
  return vscode.workspace.getConfiguration('devBoost.searchEverywhere');
}

/**
 * exclude·library 설정값 캐시. 결과 하나마다 설정을 읽으면 후보가 많을 때(클래스 수만 개) 느리므로
 * 설정이 바뀔 때만 다시 읽는다 (SearchService 가 onDidChangeConfiguration 에서 비움)
 */
let globCache: { exclude: string[]; library: string[] } | undefined;
function globSettings() {
  if (!globCache) {
    const c = config();
    globCache = {
      // 검색에서 뺄 경로는 설정 devBoost.searchEverywhere.exclude 하나로 관리 (색인·파일 목록·텍스트·파일 감시 모두 이것을 따름)
      exclude: [...c.get<string[]>('exclude', []), ...splitGlobs(c.get<string>('excludeGlob'))],
      library: [...c.get<string[]>('library', []), ...c.get<string[]>('libraryGlobs', [])],
    };
  }
  return globCache;
}

/** 검색에서 완전히 뺄 glob 목록 (파일·텍스트·클래스·심볼 전부). 예전 excludeGlob(문자열) 설정도 합친다 */
function excludeGlobs(): string[] {
  return globSettings().exclude;
}

/** 라이브러리로 취급할 glob 목록 ("프로젝트 + 라이브러리" 범위에서만 보임). 예전 libraryGlobs도 합친다 */
function libraryGlobs(): string[] {
  return globSettings().library;
}

export class SearchService implements vscode.Disposable {
  /** 현재 검색 범위·텍스트 옵션 (IntelliJ 오른쪽 드롭다운/Cc/W/.*). 화면에서 바꾸면 갱신된다 */
  options: SearchOptions = loadDefaultOptions();

  /** 하위 호환: 예전 "비 프로젝트 항목 포함" 토글 = 범위 project ↔ projectAndLibs */
  get includeNonProject(): boolean {
    return this.options.scope === 'projectAndLibs';
  }
  set includeNonProject(v: boolean) {
    this.options = { ...this.options, scope: v ? 'projectAndLibs' : 'production' };
  }

  private readonly recent: RecentFiles;
  /** 최근 변경 파일 캐시 (검색 한 번 동안만) */
  private changedCache: { time: number; set: Set<string>; list: vscode.Uri[] } | undefined;

  private fileCache: vscode.Uri[] | undefined;
  private fileCachePromise: Promise<vscode.Uri[]> | undefined;
  /** rg 로 만든 프로젝트 클래스·메서드·필드 색인. rg 를 못 찾으면 null (클래스·심볼 탭이 비고 출력 패널에 이유) */
  private classIndex: ClassIndex | null | undefined;
  /** MyBatis mapper 색인 (Mapper 탭). rg 를 못 찾으면 null */
  private mapperIndex: MapperIndex | null | undefined;
  /** Spring 어노테이션 색인 (Spring 탭). rg 를 못 찾으면 null */
  private springIndex: FileIndex<SpringEntry> | null | undefined;
  // 설정 배열이 바뀔 때(globCache 를 비울 때)만 새로 만든다 — 배열 자체를 키로 비교
  private libraryMatcher: { key: string[]; matcher: GlobMatcher } | undefined;
  private excludeMatcher: { key: string[]; matcher: GlobMatcher } | undefined;
  /** 포함/제외 경로 필터 (화면 입력값 기준으로 만들어 둠) */
  private pathMatcher: { key: string; include?: GlobMatcher; exclude?: GlobMatcher } | undefined;
  private readonly context: vscode.ExtensionContext;
  /** undefined = 아직 안 찾음, null = 없음(기존 방식으로 대체) */
  private rgPath: string | null | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  // 속도 측정용: 마지막 심볼/텍스트 검색의 부가 정보
  private lastClassNote: string | undefined;
  private lastTextEngine: 'rg' | 'scan' = 'scan';
  /** 출력 패널 "DevBoost" 채널 (속도 기록) */
  readonly log = vscode.window.createOutputChannel('DevBoost');

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.disposables.push(this.log);
    this.recent = new RecentFiles(context);
    this.disposables.push(this.recent);
    // 파일이 생기거나 지워지면 캐시를 버린다 (다음 검색 때 다시 수집)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const invalidate = () => {
      this.fileCache = undefined;
      this.fileCachePromise = undefined;
    };
    // target·node_modules 같은 제외 폴더의 변경은 무시 (빌드 중 파일이 계속 생기면 입력할 때마다 파일 목록을 다시 모으게 됨)
    watcher.onDidCreate((u) => {
      if (this.isExcluded(u)) return;
      invalidate();
      this.indexFileChanged(u);
    });
    watcher.onDidDelete((u) => {
      if (this.isExcluded(u)) return;
      invalidate();
      if (u.scheme === 'file') {
        this.classIndex?.removeFile(u.fsPath);
        this.mapperIndex?.removeFile(u.fsPath);
        this.springIndex?.removeFile(u.fsPath);
      }
    });
    watcher.onDidChange((u) => this.indexFileChanged(u));
    this.disposables.push(watcher);
    // 제외 설정·워크스페이스 폴더가 바뀌면 파일 목록을 다시 모은다 (클래스 색인은 ensure 의 키로 알아서 다시 만든다)
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('devBoost.searchEverywhere.ripgrepPath') && this.rgPath === null) {
          // rg 를 못 찾았던 상태에서 경로를 넣으면 다음 검색부터 색인을 쓴다
          this.rgPath = undefined;
          this.classIndex = undefined;
          this.mapperIndex = undefined;
          this.springIndex = undefined;
        }
        if (e.affectsConfiguration('devBoost.searchEverywhere')) {
          globCache = undefined;
          invalidate();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate)
    );
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  private get max(): number {
    return config().get<number>('maxResults', 50);
  }

  /** isStale(): 더 새로운 검색이 시작됐으면 true → 긴 작업(텍스트 검색)을 중간에 멈춘다 */
  async search(tab: TabId, query: string, isStale: () => boolean = () => false, limit?: number): Promise<SearchItem[]> {
    return (await this.searchTimed(tab, query, isStale, limit)).items;
  }

  /** 출력 패널 DevBoost 채널에 시각과 함께 한 줄 */
  logLine(msg: string) {
    this.log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  /**
   * 검색. 언어 서버를 쓰지 않는다 (rg 색인·파일 목록·텍스트). 단계별 소요 시간을 함께 돌려준다.
   * - 클래스·메서드·필드: rg 색인 / 파일: rg 파일 목록 / 텍스트: rg
   * limit: 한 탭에서 보여 줄 개수 ("더 보기"로 늘어남). 기본은 maxResults 설정
   */
  async searchTimed(
    tab: TabId,
    query: string,
    isStale: () => boolean = () => false,
    limit?: number,
    /** 먼저 보낼 결과: 모두 탭은 클래스·심볼·파일(+먼저 찾은 텍스트), 텍스트 탭은 먼저 찾은 텍스트. 끝나면 최종 결과를 돌려준다 */
    onPartial?: (r: SearchResult) => void
  ): Promise<SearchResult> {
    const start = performance.now();
    const timings: SearchTiming[] = [];
    const max = Math.max(1, limit ?? this.max);
    /** 종류별 전체 개수 */
    const totals = new Map<ResultKind, { total: number; capped?: boolean }>();
    const sink = (kind: ResultKind): CountSink => (total, capped) => totals.set(kind, { total, capped });
    const groupsOf = (items: SearchItem[], tot = totals): GroupCount[] => {
      const shown = new Map<ResultKind, number>();
      items.forEach((i) => shown.set(i.kind, (shown.get(i.kind) ?? 0) + 1));
      const kinds = [...new Set([...items.map((i) => i.kind), ...tot.keys()])];
      return kinds.map((kind) => {
        const t = tot.get(kind);
        const n = shown.get(kind) ?? 0;
        return { kind, shown: n, total: Math.max(t?.total ?? n, n), capped: t?.capped };
      });
    };

    /** 한 단계를 실행하고 걸린 시간을 기록 */
    const measure = async <T extends unknown[] | undefined>(
      part: string,
      run: () => Promise<T> | T,
      note?: () => string | undefined
    ): Promise<T> => {
      const t0 = performance.now();
      const r = await run();
      timings.push({ part, ms: Math.round(performance.now() - t0), count: r?.length ?? 0, note: note?.() });
      return r;
    };
    const textNote = () => (this.lastTextEngine === 'rg' ? 'ripgrep' : '파일 직접 읽기');
    const classNote = () => this.lastClassNote;

    let items: SearchItem[];
    switch (tab) {
      case 'classes': {
        // 클래스는 rg 색인 (rg 를 못 찾으면 비어 있음, 출력 패널에 이유)
        let indexedTotal = 0;
        const indexed = await measure('클래스', () => this.searchIndexed('classes', query, max, (t) => (indexedTotal = t), isStale), classNote);
        items = indexed ?? [];
        totals.set('classes', { total: indexedTotal });
        break;
      }
      case 'symbols': {
        // 클래스·메서드·필드 색인 (메서드·필드는 Java·Kotlin)
        let indexedTotal = 0;
        const indexed = await measure('심볼', () => this.searchIndexed('all', query, max, (t) => (indexedTotal = t), isStale), classNote);
        items = indexed ?? [];
        totals.set('symbols', { total: indexedTotal });
        break;
      }
      case 'mappers':
        items = await measure('Mapper', () => this.searchMappers(query, max, sink('mappers'), isStale));
        break;
      case 'spring':
        items = await measure('Spring', () => this.searchSpring(query, max, sink('spring'), isStale));
        break;
      case 'files':
        items = await measure('파일', () => this.searchFiles(query, max, sink('files')));
        break;
      case 'actions':
        items = await measure('액션', () => this.searchActions(query));
        break;
      case 'text': {
        // 먼저 찾은 결과를 바로 보내고(VS Code 검색처럼), 다 찾으면 전체를 정렬한 결과로 바꾼다
        const early = onPartial
          ? (e: SearchItem[]) => {
              if (!isStale()) onPartial({ items: e, timings: [...timings], totalMs: Math.round(performance.now() - start), groups: groupsOf(e), partial: true });
            }
          : undefined;
        items = await measure('텍스트', () => this.searchText(query, max, isStale, sink('text'), early), textNote);
        break;
      }
      case 'all': {
        // 클래스·메서드·필드는 색인, 파일·텍스트는 rg. 액션은 '모두'에서 제외 (잡음)
        const per = Math.max(5, Math.floor(this.max / 3));
        let classTotal = 0;
        let memberTotal = 0;
        // 텍스트는 같이 시작하되 기다리지 않는다: 나머지가 끝나면 먼저 보내고(onPartial), 텍스트가 끝나면 최종 결과
        // 텍스트 중간 결과: 클래스·심볼·파일(head)이 준비된 뒤에 그 아래 붙여 보낸다
        let head: SearchItem[] | undefined;
        let textEarly: SearchItem[] = [];
        const sendPartial = () => {
          if (!onPartial || !head || isStale()) return;
          const its = [...head, ...textEarly.slice(0, per)];
          if (its.length) onPartial({ items: its, timings: [...timings], totalMs: Math.round(performance.now() - start), groups: groupsOf(its), partial: true });
        };
        const textP =
          query.length >= 3
            ? measure(
                '텍스트',
                () =>
                  this.searchText(query, per, isStale, sink('text'), (e) => {
                    textEarly = e;
                    sendPartial();
                  }),
                textNote
              )
            : Promise.resolve([] as SearchItem[]);
        const [indexed, members, files] = await Promise.all([
          measure('클래스', () => this.searchIndexed('classes', query, per, (t) => (classTotal = t), isStale), classNote),
          measure('심볼', () => this.searchIndexed('members', query, per, (t) => (memberTotal = t), isStale)),
          measure('파일', () => this.searchFiles(query, per, sink('files'))),
        ]);
        totals.set('classes', { total: classTotal });
        totals.set('symbols', { total: memberTotal });
        head = [...(indexed ?? []).slice(0, per), ...files.slice(0, per), ...(members ?? []).slice(0, per)];
        // 텍스트를 기다리지 않고 먼저 보낸다. 비어 있으면 "결과 없음"이 잠깐 보이지 않게 텍스트 중간 결과까지 기다림
        if (query.length >= 3) sendPartial();
        const text = await textP;
        items = [...head, ...text.slice(0, per)];
        break;
      }
    }

    const totalMs = Math.round(performance.now() - start);
    if (config().get<boolean>('showTiming', true) && !isStale()) {
      const parts = timings
        .map((t) => `${t.part} ${t.ms}ms(${t.count}건${t.note ? ', ' + t.note : ''})`)
        .join(' · ');
      this.log.appendLine(
        `[${new Date().toLocaleTimeString()}] 탭=${tab} 검색어="${query}"` +
          (hasPathFilter(this.options.paths)
            ? ` 포함="${this.options.paths.include}" 제외="${this.options.paths.exclude}"`
            : '') +
          ` → ${parts} | 전체 ${totalMs}ms`
      );
    }
    const result: SearchResult = { items, timings, totalMs, groups: groupsOf(items) };
    if ((tab === 'symbols' || tab === 'all' || tab === 'mappers' || tab === 'spring') && query && this.classIndex?.ready && !this.classIndex.membersReady) {
      result.indexIncomplete = true;
    }
    return result;
  }

  /** 선택된 항목 열기/실행 */
  /** 창 고정: 결과를 열어도 검색 창을 닫지 않는다 (VS Code 를 다시 켜기 전까지 기억) */
  pinned = false;

  /** preserveFocus: 파일은 열되 커서는 검색 창에 둔다 (고정 상태에서 이어서 고를 수 있게) */
  async open(item: SearchItem, viewColumn?: vscode.ViewColumn, preserveFocus = false): Promise<void> {
    if (item.kind === 'actions' && item.command) {
      await vscode.commands.executeCommand(item.command, ...(item.args ?? []));
      return;
    }
    if (item.uri) {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      const editor = await vscode.window.showTextDocument(doc, { viewColumn, preserveFocus });
      let range = item.range;
      if (range && item.selectName && range.start.line < doc.lineCount) {
        const text = doc.lineAt(range.start.line).text;
        const m = new RegExp(`(?<![\\w$])${escapeRegExp(item.label)}(?![\\w$])`).exec(text);
        if (m) range = new vscode.Range(range.start.line, m.index, range.start.line, m.index + item.label.length);
      }
      if (range) {
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    }
  }

  // ───────────────────────── 라이브러리 판정 ─────────────────────────

  /** 프로젝트 밖(jar, JDK, ~/.m2)이거나 library 설정(vendor 등)에 해당하면 라이브러리 */
  private isLibrary(uri: vscode.Uri): boolean {
    if (!isInProject(uri)) {
      return true;
    }
    const globs = libraryGlobs();
    if (this.libraryMatcher?.key !== globs) {
      this.libraryMatcher = { key: globs, matcher: new GlobMatcher(globs) };
    }
    return this.libraryMatcher.matcher.matches(vscode.workspace.asRelativePath(uri, false));
  }

  /** exclude 설정(node_modules, target 등)에 해당하면 어떤 탭에서도 보이지 않는다 */
  private isExcluded(uri: vscode.Uri): boolean {
    if (!isInProject(uri)) {
      return false; // jar/JDK 등은 exclude 대상이 아니라 라이브러리 범위로 다룬다
    }
    const globs = excludeGlobs();
    if (this.excludeMatcher?.key !== globs) {
      this.excludeMatcher = { key: globs, matcher: new GlobMatcher(globs) };
    }
    return this.excludeMatcher.matcher.matches(vscode.workspace.asRelativePath(uri, false));
  }

  // ───────────────────────── 포함/제외 경로 ─────────────────────────

  private getPathMatcher() {
    const { include, exclude } = this.options.paths;
    const key = `${include}\u0000${exclude}`;
    if (this.pathMatcher?.key !== key) {
      const inc = pathListToGlobs(include);
      const exc = pathListToGlobs(exclude);
      this.pathMatcher = {
        key,
        include: inc.length ? new GlobMatcher(inc) : undefined,
        exclude: exc.length ? new GlobMatcher(exc) : undefined,
      };
    }
    return this.pathMatcher;
  }

  /** 화면의 포함/제외 입력값에 맞는지. 워크스페이스 기준 상대 경로로 비교 */
  private pathAccepts(uri: vscode.Uri): boolean {
    const m = this.getPathMatcher();
    if (!m.include && !m.exclude) {
      return true;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (m.include && !m.include.matches(rel)) {
      return false;
    }
    if (m.exclude && m.exclude.matches(rel)) {
      return false;
    }
    return true;
  }

  /** "현재 폴더" 버튼: 마지막으로 본 파일의 폴더를 워크스페이스 상대 경로로 */
  currentFolder(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri ?? this.recent.uris()[0];
    if (!uri || uri.scheme !== 'file' || !isInProject(uri)) {
      return undefined;
    }
    const rel = vscode.workspace.asRelativePath(vscode.Uri.file(path.dirname(uri.fsPath)), false);
    return rel === path.dirname(uri.fsPath) ? undefined : rel.replace(/\\/g, '/');
  }

  /** 최근 쓴 포함 경로 (화면 드롭다운용, 워크스페이스별 최대 10개) */
  recentIncludes(): string[] {
    return this.context.workspaceState.get<string[]>('devBoost.searchEverywhere.recentIncludes', []);
  }

  rememberInclude(value: string) {
    const v = value.trim();
    if (!v) {
      return;
    }
    const list = [v, ...this.recentIncludes().filter((x) => x !== v)].slice(0, 10);
    void this.context.workspaceState.update('devBoost.searchEverywhere.recentIncludes', list);
  }

  // ───────────────────────── 범위 ─────────────────────────

  private async getChanged(): Promise<{ set: Set<string>; list: vscode.Uri[] }> {
    const now = Date.now();
    if (!this.changedCache || now - this.changedCache.time > 2000) {
      const list = await gitChangedFiles();
      this.changedCache = { time: now, set: new Set(list.map((u) => u.toString())), list };
    }
    return this.changedCache;
  }

  private facts(uri: vscode.Uri, changed: Set<string>): FileFacts {
    return {
      relPath: vscode.workspace.asRelativePath(uri, false),
      inProject: isInProject(uri),
      isLibrary: this.isLibrary(uri),
      recentlyViewed: this.recent.has(uri),
      recentlyChanged: changed.has(uri.toString()),
    };
  }

  /** 현재 범위에 맞는 파일만 남긴다. 최근 본/변경 범위는 그 목록 순서를 쓴다 */
  private async applyScope(files: vscode.Uri[]): Promise<vscode.Uri[]> {
    const { scope } = this.options;
    if (scope === 'recentViewed') {
      const known = new Set(files.map((u) => u.toString()));
      return this.recent.uris().filter((u) => known.has(u.toString()));
    }
    const changed = await this.getChanged();
    if (scope === 'recentChanged') {
      return changed.list;
    }
    return files.filter((u) => scopeAccepts(scope, this.facts(u, changed.set)));
  }

  // ───────────────────────── 파일 ─────────────────────────

  /**
   * 워크스페이스 파일 목록 (처음 한 번 모으고 파일이 생기거나 지워질 때까지 재사용).
   * rg --files 로 개수 제한 없이 모은다 (.gitignore 반영, 숨김 파일 포함 — 빠른 열기(Ctrl+P)와 같은 기준).
   * rg 가 없으면 VS Code findFiles (최대 20,000개)
   */
  private async getFiles(): Promise<vscode.Uri[]> {
    if (this.fileCache) {
      return this.fileCache;
    }
    if (!this.fileCachePromise) {
      const globs = excludeGlobs();
      const rg = this.getRipgrep();
      const roots = this.fileRoots();
      const viaFindFiles = () => {
        const exclude = globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
        return Promise.resolve(vscode.workspace.findFiles('**/*', exclude, 20000));
      };
      const p: Promise<vscode.Uri[]> = (rg && roots.length
        ? // rg 는 여러 스레드로 훑어 순서가 매번 달라서, 같은 점수의 파일이 항상 같은 순서로 나오게 경로순으로 정렬
          listFiles(rg, roots, globs).then((paths) => paths.sort().map((f) => vscode.Uri.file(f)))
        : viaFindFiles()
      )
        .catch((e) => {
          this.log.appendLine(`[경고] rg 파일 목록 실패, findFiles 로 대체: ${e}`);
          return viaFindFiles();
        })
        .then((files) => {
          if (this.fileCachePromise === p) this.fileCache = files;
          return files;
        });
      this.fileCachePromise = p;
    }
    return this.fileCachePromise;
  }

  /**
   * 범위·포함/제외 경로를 적용한 파일 목록 (이름·소문자 이름 포함).
   * 파일마다 범위 판정(상대 경로·라이브러리 glob 등)이 들어가 수만 개면 수백 ms 라, 키를 칠 때마다 하지 않고
   * 파일 목록·범위·경로·설정이 그대로면 재사용한다. 최근 본/변경 범위는 목록이 자주 바뀌고 작아서 매번 계산
   */
  private scopedFiles: { files: vscode.Uri[]; key: string; globs: unknown; list: { uri: vscode.Uri; name: string; lc: string }[] } | undefined;
  private async getScopedFiles(): Promise<{ uri: vscode.Uri; name: string; lc: string }[]> {
    const files = await this.getFiles();
    const { scope, paths } = this.options;
    const key = `${scope}\u0000${paths.include}\u0000${paths.exclude}`;
    const globs = globSettings();
    const reuse = scope !== 'recentViewed' && scope !== 'recentChanged';
    const c = this.scopedFiles;
    if (reuse && c && c.files === files && c.key === key && c.globs === globs) return c.list;
    const list = (await this.applyScope(files))
      .filter((u) => this.pathAccepts(u))
      .map((uri) => {
        const name = path.basename(uri.fsPath);
        return { uri, name, lc: name.toLowerCase() };
      });
    if (reuse) this.scopedFiles = { files, key, globs, list };
    return list;
  }

  private async searchFiles(query: string, limit: number = this.max, count?: CountSink): Promise<SearchItem[]> {
    const files = await this.getScopedFiles();
    const scored: { score: number; uri: vscode.Uri; order: number }[] = [];
    const q = query.toLowerCase();

    files.forEach(({ uri, name, lc }, order) => {
      // 글자가 순서대로 들어 있는지 소문자로 먼저 걸러 점수 계산을 줄인다 (색인 검색과 같은 방식)
      if (q) {
        let ti = 0;
        for (let qi = 0; qi < q.length; qi++) {
          const f = lc.indexOf(q[qi], ti);
          if (f < 0) return;
          ti = f + 1;
        }
      }
      // 파일명 기준으로 점수 계산, 쿼리가 비어 있으면 전부 0점 (최근 본/변경 범위는 목록 순서 유지)
      const score = query ? fuzzyScore(query, name) : 0;
      if (score >= 0) {
        scored.push({ score, uri, order });
      }
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    count?.(scored.length);

    return scored.slice(0, limit).map(({ uri }) => ({
      kind: 'files' as const,
      label: path.basename(uri.fsPath),
      description: vscode.workspace.asRelativePath(path.dirname(uri.fsPath)),
      icon: 'file',
      uri,
    }));
  }

  // ─────────────────── 클래스 / 심볼 ───────────────────

  // ─────────────────── 클래스 색인 (rg) ───────────────────

  /**
   * 검색 창을 열 때 부른다: 클래스 색인(메서드·필드는 이어서)과 파일 목록을 백그라운드로 미리 만든다.
   * 사용자가 검색어를 치는 동안 대부분 끝나서 첫 검색도 바로 나온다. 이미 있으면 아무 일도 하지 않는다.
   * (VS Code 시작 때 만들지 않는 이유: 다른 확장이 프로젝트를 불러오는 동안 디스크·CPU 를 나눠 쓰게 됨)
   */
  /** 메서드·필드 색인이 끝날 때 (색인이 없거나 이미 끝났으면 바로) */
  whenIndexComplete(): Promise<void> {
    return this.classIndex ? this.classIndex.whenMembersDone() : Promise.resolve();
  }

  warmUp() {
    const idx = this.getClassIndex();
    const roots = this.fileRoots();
    if (idx && roots.length) {
      idx.ensure(roots, excludeGlobs()).catch(() => undefined);
    }
    void this.getFiles().catch(() => undefined);
    // mapper 색인은 클래스 색인이 끝난 뒤 (디스크를 동시에 훑지 않게)
    const mi = this.getMapperIndex();
    if (idx && mi && roots.length) {
      void idx.whenMembersDone().then(() => mi.ensure(this.fileRoots(), excludeGlobs()).catch(() => undefined));
    }
    const si = this.getSpringIndex();
    if (idx && si && roots.length) {
      void idx.whenMembersDone().then(() => si.ensure(this.fileRoots(), excludeGlobs()).catch(() => undefined));
    }
  }

  private getSpringIndex(): FileIndex<SpringEntry> | undefined {
    if (this.springIndex === undefined) {
      const rg = this.getRipgrep();
      this.springIndex = rg ? createSpringIndex(rg) : null;
      if (this.springIndex) this.springIndex.onLog = (m) => this.logLine(m);
    }
    return this.springIndex ?? undefined;
  }

  private getMapperIndex(): MapperIndex | undefined {
    if (this.mapperIndex === undefined) {
      const rg = this.getRipgrep();
      this.mapperIndex = rg ? new MapperIndex(rg) : null;
      if (this.mapperIndex) this.mapperIndex.onLog = (m) => this.logLine(m);
    }
    return this.mapperIndex ?? undefined;
  }

  private getClassIndex(): ClassIndex | undefined {
    if (this.classIndex === undefined) {
      const rg = this.getRipgrep();
      this.classIndex = rg ? new ClassIndex(rg) : null;
      if (this.classIndex) this.classIndex.onLog = (m) => this.logLine(m);
    }
    return this.classIndex ?? undefined;
  }

  /**
   * 색인·검색할 폴더. 설정 devBoost.searchEverywhere.indexFolders 가 있으면 그 폴더 아래만 (워크스페이스 폴더 기준 상대 경로 또는 절대 경로),
   * 없거나 하나도 없는 폴더면 워크스페이스 폴더 전체. 클래스·심볼·Mapper 색인, 파일 목록, 텍스트 검색이 모두 이것을 쓴다
   */
  private fileRoots(): string[] {
    const ws = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const wanted = config()
      .get<string[]>('indexFolders', [])
      .map((x) => x.trim())
      .filter(Boolean);
    if (!wanted.length) return ws;
    const key = JSON.stringify([ws, wanted]);
    if (this.rootsCache?.key === key) return this.rootsCache.roots;
    const found = new Set<string>();
    for (const w of wanted) {
      const cands = path.isAbsolute(w) ? [w] : ws.map((r) => path.join(r, w));
      for (const c of cands) {
        try {
          if (fs.statSync(c).isDirectory()) found.add(path.normalize(c));
        } catch {
          // 없는 폴더는 건너뜀
        }
      }
    }
    // 다른 폴더 안에 든 폴더는 빼서 같은 파일을 두 번 읽지 않게
    const list = [...found].sort();
    const roots = list.filter((r) => !list.some((o) => o !== r && r.startsWith(o.endsWith(path.sep) ? o : o + path.sep)));
    if (!roots.length) {
      this.logLine(`[경고] 설정 indexFolders 의 폴더를 하나도 찾지 못함 (${wanted.join(', ')}) → 워크스페이스 전체를 씁니다`);
    } else {
      this.logLine(`[색인] 색인·검색 폴더: ${roots.join(', ')}`);
    }
    this.rootsCache = { key, roots: roots.length ? roots : ws };
    return this.rootsCache.roots;
  }
  private rootsCache: { key: string; roots: string[] } | undefined;

  /** 하단에 보여 줄 색인 크기 (항목 수와 대략의 메모리). 항목당 크기는 실측 평균값 */
  indexSummary(): string | undefined {
    const ci = this.classIndex;
    if (!ci || !ci.ready) return undefined;
    const n = ci.entries().length;
    const m = (this.mapperIndex?.ready ? this.mapperIndex.entries().length : 0) + (this.springIndex?.ready ? this.springIndex.entries().length : 0);
    const f = this.fileCache?.length ?? 0;
    const bytes = n * 170 + m * 200 + f * 230;
    const mb = bytes / 1048576;
    return `색인 ${(n + m).toLocaleString('ko-KR')}개 · 약 ${mb < 0.1 ? '0.1' : mb.toFixed(1)}MB`;
  }

  /** 파일이 생기거나 저장되면 그 파일의 클래스만 다시 읽는다 */
  private indexFileChanged(uri: vscode.Uri) {
    if (uri.scheme !== 'file' || this.isExcluded(uri)) return;
    // 모았다가 처리. .gitignore·숨김 폴더는 rg 가 루트에서 걸러 준다
    this.classIndex?.queueUpdate(uri.fsPath);
    this.mapperIndex?.queueUpdate(uri.fsPath);
    this.springIndex?.queueUpdate(uri.fsPath);
  }

  /**
   * 프로젝트 클래스를 색인에서 찾는다. 범위·포함/제외 경로는 다른 탭과 같은 규칙.
   * rg 를 못 쓰면 undefined
   */
  /**
   * 색인에서 찾는다. which: 'classes' = 클래스 탭, 'members' = 메서드·필드(모두 탭), 'all' = 클래스+메서드·필드(심볼 탭).
   * 범위·포함/제외 경로는 다른 탭과 같은 규칙. rg 를 못 쓰면 undefined
   */
  private async searchIndexed(
    which: 'classes' | 'members' | 'all',
    query: string,
    limit: number,
    count?: CountSink,
    isStale: () => boolean = () => false
  ): Promise<SearchItem[] | undefined> {
    const idx = this.getClassIndex();
    if (!idx) {
      return undefined;
    }
    if (!query) {
      this.lastClassNote = undefined;
      return [];
    }
    const roots = this.fileRoots();
    if (roots.length === 0) {
      return [];
    }
    const wasReady = idx.ready;
    try {
      await idx.ensure(roots, excludeGlobs());
    } catch (e) {
      // 색인은 다음 검색 때 다시 만들어 본다
      this.log.appendLine(`[경고] 클래스 색인 실패: ${e}`);
      return undefined;
    }
    if (isStale()) {
      return []; // 색인을 기다리는 동안 더 새 검색이 시작됨
    }
    const all = which === 'classes' ? idx.classes() : which === 'members' ? idx.members() : idx.entries();
    if (which === 'classes') {
      this.lastClassNote = wasReady ? `색인 ${all.length}개` : `색인 만듦 ${all.length}개 ${idx.lastBuildMs}ms`;
    }

    // 이름 점수로 먼저 고르고 정렬한 뒤, 범위 필터는 위에서부터 필요한 만큼만 확인한다.
    // 메서드까지 수만~수십만 개라, 글자가 순서대로 들어 있는지 소문자 이름으로 먼저 걸러 점수 계산을 줄인다
    const q = query.toLowerCase();
    const cands: { e: ClassEntry; score: number }[] = [];
    for (const e of all) {
      const lc = this.lowerName(e.name);
      let ti = 0;
      let ok = true;
      for (let qi = 0; qi < q.length; qi++) {
        const f = lc.indexOf(q[qi], ti);
        if (f < 0) {
          ok = false;
          break;
        }
        ti = f + 1;
      }
      if (!ok) continue;
      const score = fuzzyScore(query, e.name);
      if (score >= 0) cands.push({ e, score });
    }
    cands.sort(
      (a, b) =>
        b.score - a.score ||
        a.e.name.length - b.e.name.length ||
        (a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0) ||
        (a.e.file < b.e.file ? -1 : a.e.file > b.e.file ? 1 : a.e.line - b.e.line)
    );
    const changed = (await this.getChanged()).set;
    if (isStale()) {
      return [];
    }
    const out: SearchItem[] = [];
    // 범위 판정은 파일 단위라 파일별로 한 번만 계산 (전체 개수를 세려고 모든 후보를 확인한다).
    // 최근 본/변경 범위가 아니면 결과가 파일 경로로만 정해지므로 다음 입력에서도 재사용한다
    const fileOk = this.classFileOkCache();
    let total = 0;
    for (const { e } of cands) {
      let ok = fileOk.get(e.file);
      if (ok === undefined) {
        const u = vscode.Uri.file(e.file);
        ok = !this.isExcluded(u) && this.pathAccepts(u) && scopeAccepts(this.options.scope, this.facts(u, changed));
        fileOk.set(e.file, ok);
      }
      if (!ok) continue;
      total++;
      if (out.length >= limit) continue;
      const uri = vscode.Uri.file(e.file);
      const isMember = e.kind === 'method' || e.kind === 'field' || e.kind === 'variable';
      out.push({
        kind: which === 'classes' ? 'classes' : 'symbols',
        label: e.name,
        // 클래스는 패키지, 메서드·필드는 소속 클래스
        description: (isMember ? e.container : e.pkg) || undefined,
        detail: `${vscode.workspace.asRelativePath(uri)}:${e.line + 1}`,
        icon:
          e.kind === 'method' ? 'symbol-method'
          : e.kind === 'field' ? 'symbol-field'
          : e.kind === 'variable' ? 'symbol-variable'
          : e.kind === 'interface' ? 'symbol-interface'
          : e.kind === 'enum' ? 'symbol-enum'
          : 'symbol-class',
        uri,
        range: new vscode.Range(e.line, 0, e.line, 0),
        selectName: true,
      });
    }
    count?.(total);
    if (cands.length && !total) {
      // 이름은 맞는데 모두 빠짐: 왜 빠졌는지 첫 번째 것으로 기록 (경로·범위 판정 문제를 찾기 위해)
      const u = vscode.Uri.file(cands[0].e.file);
      const f = this.facts(u, changed);
      this.logLine(
        `[색인] "${query}" 이름이 맞는 ${cands.length}개가 모두 범위에서 빠짐. 예: ${cands[0].e.file} → ` +
          `제외설정=${this.isExcluded(u)} 포함/제외경로=${!this.pathAccepts(u)} 프로젝트안=${f.inProject} 라이브러리=${f.isLibrary} 최근에연파일=${f.recentlyViewed} 상대경로(워크스페이스 폴더 기준)=${f.relPath} 범위=${this.options.scope}`
      );
    }
    return out;
  }

  /**
   * Mapper 탭: MyBatis mapper XML(파일과 SQL id)과 Java mapper 인터페이스.
   * mapper XML 은 폴더가 아니라 내용(`<mapper namespace>`)으로 고르고, Java 는 @Mapper 이거나 XML namespace 와 같은 이름의 클래스.
   * 검색어가 비어 있으면 mapper 파일 목록 (SQL id 제외)
   */
  private async searchMappers(query: string, limit: number, count?: CountSink, isStale: () => boolean = () => false): Promise<SearchItem[]> {
    const mi = this.getMapperIndex();
    const roots = this.fileRoots();
    if (!mi || !roots.length) {
      count?.(0);
      return [];
    }
    const ci = this.getClassIndex();
    try {
      await Promise.all([mi.ensure(roots, excludeGlobs()), ci?.ensure(roots, excludeGlobs())]);
    } catch (e) {
      this.log.appendLine(`[경고] mapper 검색 실패: ${e}`);
      return [];
    }
    if (isStale()) return [];

    type Cand = { kind: 'xml' | 'statement' | 'java' | 'method'; name: string; file: string; line: number; desc: string; statement?: string };
    const cands: Cand[] = [];
    for (const e of mi.entries()) {
      if (e.kind === 'statement' && !query) continue;
      const shortNs = e.namespace.slice(e.namespace.lastIndexOf('.') + 1);
      cands.push({
        kind: e.kind,
        name: e.name,
        file: e.file,
        line: e.line,
        desc: e.kind === 'statement' ? `${shortNs || path.basename(e.file, path.extname(e.file))}.xml · ${e.statement}` : e.namespace,
        statement: e.statement,
      });
    }
    if (ci) {
      // Java mapper: @Mapper, mapper XML namespace 와 같은 이름, 또는 이름이 …Mapper 인 인터페이스 (@MapperScan 으로 등록하는 경우)
      const ns = mi.namespaces();
      const mapperFiles = new Map<string, string>(); // 파일 → 인터페이스 이름
      for (const c of ci.classes()) {
        if (!c.file.toLowerCase().endsWith('.java')) continue;
        if (mi.isAnnotated(c.file) || ns.has(c.pkg ? `${c.pkg}.${c.name}` : c.name) || (c.kind === 'interface' && c.name.endsWith('Mapper'))) {
          cands.push({ kind: 'java', name: c.name, file: c.file, line: c.line, desc: c.pkg });
          mapperFiles.set(c.file, c.name);
        }
      }
      // 그 인터페이스의 메서드 (검색어가 있을 때만, SQL id 와 같은 이름이면 나란히 나옴)
      if (query && mapperFiles.size) {
        for (const m of ci.members()) {
          if (m.kind !== 'method') continue;
          const owner = mapperFiles.get(m.file);
          if (owner === undefined) continue;
          cands.push({ kind: 'method', name: m.name, file: m.file, line: m.line, desc: `${m.container || owner}.java` });
        }
      }
    }

    const order = { java: 0, xml: 1, method: 2, statement: 3 };
    const scored = cands
      .map((c) => ({ c, score: query ? fuzzyScore(query, c.kind === 'xml' ? c.name.replace(/\.xml$/i, '') : c.name) : 0 }))
      .filter((x) => x.score >= 0);
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.c.name.length - b.c.name.length ||
        (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0) ||
        order[a.c.kind] - order[b.c.kind] ||
        (a.c.file < b.c.file ? -1 : a.c.file > b.c.file ? 1 : a.c.line - b.c.line)
    );
    const changed = (await this.getChanged()).set;
    if (isStale()) return [];
    const fileOk = this.classFileOkCache();
    const out: SearchItem[] = [];
    let total = 0;
    for (const { c } of scored) {
      let ok = fileOk.get(c.file);
      if (ok === undefined) {
        const u = vscode.Uri.file(c.file);
        ok = !this.isExcluded(u) && this.pathAccepts(u) && scopeAccepts(this.options.scope, this.facts(u, changed));
        fileOk.set(c.file, ok);
      }
      if (!ok) continue;
      total++;
      if (out.length >= limit) continue;
      const uri = vscode.Uri.file(c.file);
      out.push({
        kind: 'mappers',
        label: c.name,
        description: c.desc || undefined,
        detail: `${vscode.workspace.asRelativePath(uri)}:${c.line + 1}`,
        icon: c.kind === 'java' ? 'symbol-interface' : c.kind === 'xml' ? 'file-code' : c.kind === 'method' ? 'symbol-method' : 'database',
        uri,
        range: new vscode.Range(c.line, 0, c.line, 0),
        selectName: c.kind !== 'xml',
      });
    }
    count?.(total);
    if (!mi.entries().length && !cands.length) {
      this.logLine('[Mapper] mapper XML·Java mapper 를 하나도 못 찾음 (<mapper namespace> 나 MyBatis DOCTYPE 이 있는 XML, …Mapper 인터페이스·@Mapper 가 없음)');
    }
    return out;
  }

  /**
   * Spring 탭: 빈 클래스(@Service 등), @Bean 메서드, URL 매핑(@GetMapping("/x") 적힌 그대로).
   * 어노테이션 다음의 클래스·메서드 이름은 클래스 색인에서 같은 파일의 다음 선언으로 맞춘다.
   * 검색어가 없으면 빈 클래스 목록
   */
  private async searchSpring(query: string, limit: number, count?: CountSink, isStale: () => boolean = () => false): Promise<SearchItem[]> {
    const si = this.getSpringIndex();
    const ci = this.getClassIndex();
    const roots = this.fileRoots();
    if (!si || !ci || !roots.length) {
      count?.(0);
      return [];
    }
    const started = !si.ready;
    try {
      await Promise.all([si.ensure(roots, excludeGlobs()), ci.ensure(roots, excludeGlobs())]);
    } catch (e) {
      this.log.appendLine(`[경고] Spring 검색 실패: ${e}`);
      return [];
    }
    if (started && si.ready) this.logLine(`[색인] Spring 어노테이션 ${si.entries().length}개 (${si.fileCount}개 파일) ${si.lastBuildMs}ms`);
    if (isStale()) return [];

    type Cand = { kind: SpringEntry['kind']; label: string; names: string[]; desc: string; file: string; line: number; selectName: boolean };
    const cands: Cand[] = [];
    for (const e of si.entries()) {
      if (!query && e.kind !== 'bean-class') continue;
      // 어노테이션 다음에 오는 첫 선언 (클래스 또는 메서드)
      const decls = ci.fileEntries(e.file);
      const next = decls.find((d) => d.line >= e.line && (e.kind === 'bean-class' ? d.kind === 'class' || d.kind === 'interface' : d.kind !== 'field' && d.kind !== 'variable'));
      if (e.kind === 'bean-class') {
        if (!next) continue;
        cands.push({ kind: e.kind, label: next.name, names: [next.name], desc: `@${e.ann}${next.pkg ? ' · ' + next.pkg : ''}`, file: e.file, line: next.line, selectName: true });
      } else if (e.kind === 'bean-method') {
        if (!next || next.kind !== 'method') continue;
        cands.push({ kind: e.kind, label: next.name, names: [next.name], desc: `@Bean · ${next.container ?? ''}`, file: e.file, line: next.line, selectName: true });
      } else {
        const owner = next ? (next.kind === 'method' ? `${next.container ?? ''}.${next.name}` : next.name) : '';
        cands.push({ kind: e.kind, label: e.text, names: [e.text, ...(next ? [next.name] : [])], desc: owner, file: e.file, line: e.line, selectName: false });
      }
    }
    const order = { 'bean-class': 0, 'bean-method': 1, mapping: 2 };
    const scored = cands
      .map((c) => ({ c, score: query ? Math.max(...c.names.map((n) => fuzzyScore(query, n))) : 0 }))
      .filter((x) => x.score >= 0);
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        order[a.c.kind] - order[b.c.kind] ||
        (a.c.label < b.c.label ? -1 : a.c.label > b.c.label ? 1 : 0) ||
        (a.c.file < b.c.file ? -1 : a.c.file > b.c.file ? 1 : a.c.line - b.c.line)
    );
    const changed = (await this.getChanged()).set;
    if (isStale()) return [];
    const fileOk = this.classFileOkCache();
    const out: SearchItem[] = [];
    let total = 0;
    for (const { c } of scored) {
      let ok = fileOk.get(c.file);
      if (ok === undefined) {
        const u = vscode.Uri.file(c.file);
        ok = !this.isExcluded(u) && this.pathAccepts(u) && scopeAccepts(this.options.scope, this.facts(u, changed));
        fileOk.set(c.file, ok);
      }
      if (!ok) continue;
      total++;
      if (out.length >= limit) continue;
      const uri = vscode.Uri.file(c.file);
      out.push({
        kind: 'spring',
        label: c.label,
        description: c.desc || undefined,
        detail: `${vscode.workspace.asRelativePath(uri)}:${c.line + 1}`,
        icon: c.kind === 'bean-class' ? 'symbol-class' : c.kind === 'bean-method' ? 'symbol-method' : 'link',
        uri,
        range: new vscode.Range(c.line, 0, c.line, 0),
        selectName: c.selectName,
      });
    }
    count?.(total);
    return out;
  }

  /** 이름 → 소문자 (같은 이름이 많아서 캐시) */
  private lowerCache = new Map<string, string>();
  private lowerName(name: string): string {
    let lc = this.lowerCache.get(name);
    if (lc === undefined) {
      lc = name.toLowerCase();
      if (this.lowerCache.size > 500000) this.lowerCache.clear();
      this.lowerCache.set(name, lc);
    }
    return lc;
  }

  /** 클래스 결과의 파일별 범위 판정 캐시. 범위·포함/제외 경로·설정이 바뀌면 새로 */
  private classOkCache: { key: string; globs: unknown; map: Map<string, boolean> } | undefined;
  private classFileOkCache(): Map<string, boolean> {
    const { scope, paths } = this.options;
    if (scope === 'recentViewed' || scope === 'recentChanged') {
      return new Map(); // 최근 목록에 따라 바뀌므로 매번 새로
    }
    const key = `${scope}\u0000${paths.include}\u0000${paths.exclude}\u0000${this.fileRoots().join('|')}`;
    const globs = globSettings();
    if (this.classOkCache?.key !== key || this.classOkCache.globs !== globs) {
      this.classOkCache = { key, globs, map: new Map() };
    }
    return this.classOkCache.map;
  }

  // ───────────────────────── 액션 ─────────────────────────

  /**
   * IntelliJ의 액션 = 명령 + 설정 바로가기. VS Code에서는 명령 팔레트·설정 검색이 이 역할을 하므로
   * 목록을 직접 만들지 않고, 검색어를 채운 상태로 그 화면을 열어준다.
   */
  private searchActions(query: string): SearchItem[] {
    const q = query.trim();
    return [
      {
        kind: 'actions',
        label: q ? `명령 팔레트에서 "${q}" 찾기` : '명령 팔레트 열기',
        description: '명령 팔레트',
        icon: 'terminal',
        command: 'workbench.action.quickOpen',
        args: [`>${q}`],
      },
      {
        kind: 'actions',
        label: q ? `설정에서 "${q}" 찾기` : '설정 열기',
        description: '설정',
        icon: 'gear',
        command: 'workbench.action.openSettings',
        args: [q],
      },
      {
        kind: 'actions',
        label: q ? `단축키 설정에서 "${q}" 찾기` : '단축키 설정 열기',
        description: '단축키',
        icon: 'keyboard',
        command: 'workbench.action.openGlobalKeybindings',
        args: [q],
      },
    ];
  }

  // ───────────────────────── 텍스트 ─────────────────────────

  private async searchText(
    query: string,
    limit: number,
    isStale: () => boolean = () => false,
    count?: CountSink,
    /** 먼저 찾은 결과(정렬은 그때까지 찾은 것끼리)를 한 번 미리 받는다. 끝나면 전체를 다시 정렬한 결과를 돌려준다 */
    onEarly?: (items: SearchItem[]) => void
  ): Promise<SearchItem[]> {
    if (query.length < 2) {
      return [];
    }
    const rg = this.getRipgrep();
    if (rg) {
      try {
        const r = await this.searchTextRipgrep(rg, query, limit, isStale, count, onEarly);
        this.lastTextEngine = 'rg';
        return r;
      } catch (e) {
        console.warn('[DevBoost] ripgrep 실패, 기존 방식으로 검색합니다:', e);
        this.log.appendLine(`[경고] ripgrep 실패, 파일 직접 읽기로 대체: ${e}`);
      }
    }
    this.lastTextEngine = 'scan';
    return this.searchTextScan(query, limit, isStale, count);
  }

  private getRipgrep(): string | undefined {
    if (this.rgPath === undefined) {
      // 1) 설정에 직접 지정한 경로 2) VS Code 내장 3) 시스템 PATH
      const custom = (config().get<string>('ripgrepPath') ?? '').trim();
      let found: string | undefined;
      let from = '';
      if (custom) {
        if (fs.existsSync(custom)) {
          found = custom;
          from = '설정 ripgrepPath';
        } else {
          this.logLine(`[경고] 설정 ripgrepPath 의 파일이 없음: ${custom} → VS Code 내장 rg 를 찾습니다`);
        }
      }
      if (!found && (found = findRipgrep(vscode.env.appRoot))) from = 'VS Code 내장';
      if (!found && (found = findRipgrepOnPath())) from = '시스템 PATH';
      this.rgPath = found ?? null;
      if (found) {
        this.logLine(`[ripgrep] ${from}: ${found}`);
      } else {
        this.logLine(
          `[경고] ripgrep(rg) 을 찾지 못함 (VS Code 설치 폴더: ${vscode.env.appRoot}). ` +
            '클래스·메서드·Mapper 색인이 꺼지고 텍스트 검색이 느려집니다. 설정 devBoost.searchEverywhere.ripgrepPath 에 rg 경로를 넣으면 그것을 씁니다'
        );
      }
    }
    return this.rgPath ?? undefined;
  }

  /** VS Code 내장 ripgrep으로 검색. .gitignore도 자동 반영된다 */
  private async searchTextRipgrep(
    rgPath: string,
    query: string,
    limit: number,
    isStale: () => boolean,
    count?: CountSink,
    onEarly?: (items: SearchItem[]) => void
  ): Promise<SearchItem[]> {
    const roots = this.fileRoots();
    if (roots.length === 0) {
      return [];
    }
    const { scope, text, paths } = this.options;
    const exclude = [...excludeGlobs(), ...pathListToGlobs(paths.exclude)];
    // rg의 -g 양(+) 조건은 서로 OR로 묶이므로, 파일 타입만 rg에 넘기고
    // 나머지 양 조건(테스트 범위, 포함 경로 glob)은 결과에서 거른다 (AND)
    const includeGlobs = fileMaskToGlobs(text.fileMask);
    const postFilters: GlobMatcher[] = [];
    let searchRoots = roots;
    if (scope === 'project' || scope === 'production' || scope === 'test') {
      exclude.push(...libraryGlobs());
    }
    if (scope === 'production') {
      exclude.push(...TEST_GLOBS);
    } else if (scope === 'test') {
      if (includeGlobs.length) {
        postFilters.push(new GlobMatcher(TEST_GLOBS));
      } else {
        includeGlobs.push(...TEST_GLOBS);
      }
    } else if (scope === 'recentViewed' || scope === 'recentChanged') {
      // 파일 목록을 rg에 직접 넘긴다 (없으면 결과 없음)
      searchRoots = (await this.applyScope(await this.getFiles())).map((u) => u.fsPath);
      if (searchRoots.length === 0) {
        return [];
      }
    }

    // 포함 경로: 실제 있는 폴더/파일이면 rg를 그 자리에서만 돌린다 → 다른 곳은 열어 보지도 않아 빠름
    const includeEntries = splitPathList(paths.include);
    if (includeEntries.length) {
      const direct: string[] = [];
      let allDirect = true;
      for (const e of includeEntries) {
        const n = normalizePathEntry(e);
        const hits = n.glob || !n.path ? [] : roots.map((r) => path.join(r, n.path)).filter((p) => fs.existsSync(p));
        if (hits.length) {
          direct.push(...hits);
        } else {
          allDirect = false;
        }
      }
      if (allDirect && searchRoots === roots) {
        searchRoots = direct;
      } else {
        postFilters.push(new GlobMatcher(pathListToGlobs(paths.include)));
      }
    }

    // 우선순위 정렬을 위해 넉넉히(TEXT_COLLECT_MAX) 모은 뒤 정렬해서 자른다.
    // 먼저 찾은 몇 개만 받으면 폴더 순서상 뒤에 있는 src 의 매치가 정렬 대상에도 못 들어간다
    const openDocs = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    // 제외 경로는 결과에서도 한 번 더 거른다: rg 는 "src/**" 같은 경로 glob 을 실행 폴더 기준으로 맞춰서
    // "./src" 처럼 워크스페이스 바로 아래를 가리키는 제외가 rg 에서는 적용되지 않는다
    const excludeGlobsForPost = pathListToGlobs(paths.exclude);
    const excludePost = excludeGlobsForPost.length ? new GlobMatcher(excludeGlobsForPost) : undefined;
    // 경로 필터·우선순위는 파일 단위라 파일마다 한 번만 계산한다 (매치는 최대 TEXT_COLLECT_MAX 개)
    const perFile = new Map<string, { uri: vscode.Uri; ok: boolean; prio: number }>();
    const fileInfo = (file: string) => {
      let f = perFile.get(file);
      if (!f) {
        const uri = vscode.Uri.file(file);
        const rel = postFilters.length || excludePost ? vscode.workspace.asRelativePath(uri, false) : '';
        const ok = postFilters.every((pf) => pf.matches(rel)) && !excludePost?.matches(rel);
        f = { uri, ok, prio: ok ? this.textPriority(uri, openDocs) : 0 };
        perFile.set(file, f);
      }
      return f;
    };
    const toItems = (matches: RgMatch[], final: boolean) => {
      const withUri = matches
        .map((m) => ({ m, f: fileInfo(m.file) }))
        .filter(({ f }) => f.ok)
        .map(({ m, f }) => ({ m, uri: f.uri, prio: f.prio }));
      // 우선순위 → 경로 → 줄. rg 는 여러 스레드로 훑어 찾은 순서가 매번 달라서, 같은 우선순위끼리는 경로·줄 순으로 고정
      withUri.sort(
        (a, b) =>
          a.prio - b.prio || (a.m.file < b.m.file ? -1 : a.m.file > b.m.file ? 1 : a.m.line - b.m.line || a.m.column - b.m.column)
      );
      // 한 파일에서 최대 20줄(--max-count)만 가져오므로, 그 상한에 걸린 파일이 있으면 실제 개수는 더 많다
      const perFileCount = new Map<string, number>();
      let fileCapped = false;
      for (const { m } of withUri) {
        const n = (perFileCount.get(m.file) ?? 0) + 1;
        perFileCount.set(m.file, n);
        if (n >= RG_MAX_PER_FILE) fileCapped = true;
      }
      if (final) count?.(withUri.length, matches.length >= collect || fileCapped);
      return withUri.slice(0, limit).map(({ m, uri }) => toTextItem(m, uri, query));
    };
    const collect = Math.max(TEXT_COLLECT_MAX, limit);
    const matches = await runRipgrep(rgPath, {
      query,
      roots: searchRoots,
      excludeGlobs: exclude,
      includeGlobs,
      caseSensitive: text.caseSensitive,
      wholeWord: text.wholeWord,
      regex: text.regex,
      limit: collect,
      isStale,
      // 먼저 찾은 결과를 바로 보여 준다 (그때까지 찾은 것끼리 정렬). 끝나면 전체를 다시 정렬
      onEarly: onEarly ? (early) => onEarly(toItems(early, false)) : undefined,
    });

    return toItems(matches, true);
  }

  /** 텍스트 결과 순서: 0=열린 문서, 1=src 아래 소스, 2=기타, 3=라이브러리(vendor 등) */
  private textPriority(uri: vscode.Uri, openDocs: Set<string>): number {
    if (openDocs.has(uri.toString())) {
      return 0;
    }
    if (this.isLibrary(uri)) {
      return 3;
    }
    return /[\\/]src[\\/]/.test(uri.fsPath) ? 1 : 2;
  }

  /** ripgrep을 못 쓸 때의 예비 방식: 파일을 직접 읽어서 찾는다 (느림) */
  private async searchTextScan(query: string, limit: number, isStale: () => boolean, count?: CountSink): Promise<SearchItem[]> {
    const re = buildTextRegExp(query, this.options.text);
    if (!re) {
      return [];
    }
    const maskGlobs = fileMaskToGlobs(this.options.text.fileMask);
    const mask = maskGlobs.length ? new GlobMatcher(maskGlobs) : undefined;
    const results: SearchItem[] = [];
    const decoder = new TextDecoder('utf-8');

    const openDocs = new Map<string, vscode.TextDocument>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme === 'file') {
        openDocs.set(d.uri.toString(), d);
      }
    }
    const openKeys = new Set(openDocs.keys());
    let scoped = (await this.applyScope(await this.getFiles())).filter((u) => this.pathAccepts(u));
    if (mask) {
      scoped = scoped.filter((u) => mask.matches(vscode.workspace.asRelativePath(u, false)));
    }
    const files = [...scoped].sort(
      (a, b) => this.textPriority(a, openKeys) - this.textPriority(b, openKeys)
    );

    for (const uri of files) {
      if (results.length >= limit || isStale()) {
        break;
      }
      try {
        let content: string;
        const open = openDocs.get(uri.toString());
        if (open) {
          content = open.getText();
        } else {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_TEXT_FILE_SIZE) {
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.subarray(0, 8000).includes(0)) {
            continue; // 바이너리
          }
          content = decoder.decode(bytes);
        }
        re.lastIndex = 0;
        if (!re.test(content)) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          re.lastIndex = 0;
          const m = re.exec(lines[i]);
          if (m) {
            results.push(
              toTextItem(
                { file: uri.fsPath, line: i, column: m.index, length: m[0].length || query.length, text: lines[i] },
                uri,
                query
              )
            );
          }
        }
      } catch {
        // 읽을 수 없는 파일은 무시
      }
    }
    count?.(results.length, results.length >= limit);
    return results;
  }
}

function toTextItem(m: RgMatch, uri: vscode.Uri, query: string): SearchItem {
  return {
    kind: 'text',
    label: m.text.trim().slice(0, 200),
    description: `${path.basename(uri.fsPath)}:${m.line + 1}`,
    detail: vscode.workspace.asRelativePath(uri),
    icon: 'whole-word',
    uri,
    range: new vscode.Range(m.line, m.column, m.line, m.column + (m.length || query.length)),
  };
}

/**
 * 간단한 fuzzy 점수. 쿼리 문자가 순서대로 들어 있으면 매치.
 * 연속 매치, 단어 시작(대문자/구분자 뒤), 앞쪽 위치에 가산점.
 * 매치 실패는 -1.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found < 0) {
      return -1;
    }
    if (found === prevMatch + 1) {
      score += 5; // 연속 매치
    }
    const prevChar = found > 0 ? target[found - 1] : '';
    if (found === 0 || /[\\/._\-\s]/.test(prevChar) || (/[A-Z]/.test(target[found]) && /[a-z]/.test(prevChar))) {
      score += 8; // 단어 경계
    }
    score += Math.max(0, 3 - found / 10); // 앞쪽일수록 가산
    prevMatch = found;
    ti = found + 1;
  }
  if (t === q) {
    score += 30;
  } else if (t.startsWith(q)) {
    score += 15;
  }
  return score - target.length * 0.05; // 짧은 이름 우대
}

/** 설정에서 기본 범위를 읽는다 (예전 includeNonProject 설정도 인정) */
function loadDefaultOptions(): SearchOptions {
  const c = config();
  const s = c.get<string>('defaultScope');
  const scope = isScopeId(s) ? s : c.get<boolean>('includeNonProject', false) ? 'projectAndLibs' : 'production';
  return { ...DEFAULT_OPTIONS, scope, text: { ...DEFAULT_OPTIONS.text }, paths: { ...DEFAULT_OPTIONS.paths } };
}

/** 파일 스킴이면서 열려 있는 워크스페이스 폴더 안에 있을 때만 프로젝트 항목으로 본다 */
function isInProject(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

