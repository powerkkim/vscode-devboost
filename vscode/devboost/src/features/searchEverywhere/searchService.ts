import * as vscode from 'vscode';
import * as path from 'path';
import { findRipgrep, runRipgrep, splitGlobs, RgMatch } from './ripgrep';
import { GlobMatcher } from './glob';

export type TabId = 'all' | 'classes' | 'files' | 'symbols' | 'actions' | 'text';
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
  /** 액션 탭 전용: 실행할 커맨드 ID와 인자 */
  command?: string;
  args?: unknown[];
}

const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB 넘는 파일은 텍스트 검색에서 제외
const SYMBOL_CACHE_MS = 5000; // 같은 검색어의 심볼 결과는 5초간 재사용 (탭 전환 시 재요청 방지)

function config() {
  return vscode.workspace.getConfiguration('devBoost.searchEverywhere');
}

export class SearchService implements vscode.Disposable {
  /** IntelliJ "비 프로젝트 항목 포함" 체크박스와 동일. false면 프로젝트 밖(.m2, JDK)과 라이브러리 경로(vendor 등) 제외 */
  includeNonProject = config().get<boolean>('includeNonProject', false);

  private fileCache: vscode.Uri[] | undefined;
  private fileCachePromise: Promise<vscode.Uri[]> | undefined;
  private symbolCache: { key: string; time: number; promise: Promise<vscode.SymbolInformation[]> } | undefined;
  private libraryMatcher: { key: string; matcher: GlobMatcher } | undefined;
  /** undefined = 아직 안 찾음, null = 없음(기존 방식으로 대체) */
  private rgPath: string | null | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(_context: vscode.ExtensionContext) {
    // 파일이 생기거나 지워지면 캐시를 버린다 (다음 검색 때 다시 수집)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const invalidate = () => {
      this.fileCache = undefined;
      this.fileCachePromise = undefined;
    };
    watcher.onDidCreate(invalidate);
    watcher.onDidDelete(invalidate);
    this.disposables.push(watcher);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  private get max(): number {
    return config().get<number>('maxResults', 50);
  }

  /** isStale(): 더 새로운 검색이 시작됐으면 true → 긴 작업(텍스트 검색)을 중간에 멈춘다 */
  async search(tab: TabId, query: string, isStale: () => boolean = () => false): Promise<SearchItem[]> {
    switch (tab) {
      case 'classes':
        return toSymbolItems((await this.querySymbols(query)).filter(isClass), 'classes').slice(0, this.max);
      case 'symbols':
        // IntelliJ 심볼 탭처럼 클래스도 포함
        return toSymbolItems(await this.querySymbols(query), 'symbols').slice(0, this.max);
      case 'files':
        return this.searchFiles(query);
      case 'actions':
        return this.searchActions(query);
      case 'text':
        return this.searchText(query, this.max, isStale);
      case 'all': {
        // 심볼은 한 번만 요청해서 클래스/나머지로 나눈다. 액션은 '모두'에서 제외 (잡음)
        const per = Math.max(5, Math.floor(this.max / 3));
        const [symbols, files, text] = await Promise.all([
          this.querySymbols(query),
          this.searchFiles(query),
          query.length >= 3 ? this.searchText(query, per, isStale) : Promise.resolve([]),
        ]);
        const classes = toSymbolItems(symbols.filter(isClass), 'classes');
        const others = toSymbolItems(
          symbols.filter((s) => !isClass(s)),
          'symbols'
        );
        return [...classes.slice(0, per), ...files.slice(0, per), ...others.slice(0, per), ...text.slice(0, per)];
      }
    }
  }

  /** 선택된 항목 열기/실행 */
  async open(item: SearchItem): Promise<void> {
    if (item.kind === 'actions' && item.command) {
      await vscode.commands.executeCommand(item.command, ...(item.args ?? []));
      return;
    }
    if (item.uri) {
      const doc = await vscode.workspace.openTextDocument(item.uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (item.range) {
        editor.selection = new vscode.Selection(item.range.start, item.range.end);
        editor.revealRange(item.range, vscode.TextEditorRevealType.InCenter);
      }
    }
  }

  // ───────────────────────── 라이브러리 판정 ─────────────────────────

  /** 프로젝트 밖(jar, JDK, ~/.m2)이거나 libraryGlobs(vendor 등)에 해당하면 라이브러리 */
  private isLibrary(uri: vscode.Uri): boolean {
    if (!isInProject(uri)) {
      return true;
    }
    const globs = config().get<string[]>('libraryGlobs', []);
    const key = JSON.stringify(globs);
    if (this.libraryMatcher?.key !== key) {
      this.libraryMatcher = { key, matcher: new GlobMatcher(globs) };
    }
    return this.libraryMatcher.matcher.matches(vscode.workspace.asRelativePath(uri, false));
  }

  // ───────────────────────── 파일 ─────────────────────────

  private async getFiles(): Promise<vscode.Uri[]> {
    if (this.fileCache) {
      return this.fileCache;
    }
    if (!this.fileCachePromise) {
      const exclude = config().get<string>('excludeGlob');
      this.fileCachePromise = Promise.resolve(vscode.workspace.findFiles('**/*', exclude, 20000)).then((files) => {
        this.fileCache = files;
        return files;
      });
    }
    return this.fileCachePromise;
  }

  private async searchFiles(query: string): Promise<SearchItem[]> {
    const files = await this.getFiles();
    const scored: { score: number; uri: vscode.Uri }[] = [];

    for (const uri of files) {
      const name = path.basename(uri.fsPath);
      // 파일명 기준으로 점수 계산, 쿼리가 비어 있으면 전부 0점
      const score = query ? fuzzyScore(query, name) : 0;
      if (score >= 0) {
        scored.push({ score, uri });
      }
    }
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, this.max).map(({ uri }) => ({
      kind: 'files' as const,
      label: path.basename(uri.fsPath),
      description: vscode.workspace.asRelativePath(path.dirname(uri.fsPath)),
      icon: 'file',
      uri,
    }));
  }

  // ─────────────────── 클래스 / 심볼 ───────────────────

  /**
   * 언어 서버에 심볼을 한 번만 요청하고 (5초 캐시), 범위 필터·중복 제거·정렬까지 끝낸 목록을 돌려준다.
   * 클래스 탭, 심볼 탭, 모두 탭이 이 결과를 같이 쓴다.
   */
  private querySymbols(query: string): Promise<vscode.SymbolInformation[]> {
    // 빈 쿼리는 workspace symbol provider가 아무것도 돌려주지 않는 경우가 많다
    if (!query) {
      return Promise.resolve([]);
    }
    const key = `${query}\u0000${this.includeNonProject}\u0000${JSON.stringify(config().get('libraryGlobs'))}`;
    const now = Date.now();
    if (this.symbolCache && this.symbolCache.key === key && now - this.symbolCache.time < SYMBOL_CACHE_MS) {
      return this.symbolCache.promise;
    }
    const promise = this.fetchSymbols(query);
    this.symbolCache = { key, time: now, promise };
    promise.catch(() => (this.symbolCache = undefined));
    return promise;
  }

  private async fetchSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const raw =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query)) ??
      [];

    const seen = new Set<string>();
    const scored: { s: vscode.SymbolInformation; score: number }[] = [];
    for (const s of raw) {
      const lib = this.isLibrary(s.location.uri);
      // 프로젝트 밖(jdt:// jar, JDK src.zip, ~/.m2)과 vendor 경로는 기본 제외
      if (lib && !this.includeNonProject) {
        continue;
      }
      // 같은 라이브러리 클래스가 jar 경로 / 소스 jar 경로로 두 번 오는 것 제거
      const dedupeKey = isInProject(s.location.uri)
        ? `${s.location.uri.toString()}#${s.name}#${s.location.range.start.line}`
        : `lib#${s.kind}#${s.containerName}#${s.name}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      // 언어 서버마다 매칭 규칙이 달라 우리 점수가 -1이어도 버리지 않고 뒤로만 보낸다
      const score = Math.max(fuzzyScore(query, s.name), -20) + (lib ? -40 : 0);
      scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.s);
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

  private async searchText(query: string, limit: number, isStale: () => boolean = () => false): Promise<SearchItem[]> {
    if (query.length < 2) {
      return [];
    }
    const rg = this.getRipgrep();
    if (rg) {
      try {
        return await this.searchTextRipgrep(rg, query, limit, isStale);
      } catch (e) {
        console.warn('[DevBoost] ripgrep 실패, 기존 방식으로 검색합니다:', e);
      }
    }
    return this.searchTextScan(query, limit, isStale);
  }

  private getRipgrep(): string | undefined {
    if (this.rgPath === undefined) {
      this.rgPath = findRipgrep(vscode.env.appRoot) ?? null;
      if (!this.rgPath) {
        console.warn('[DevBoost] VS Code 내장 ripgrep을 찾지 못했습니다. 느린 방식으로 텍스트 검색합니다.');
      }
    }
    return this.rgPath ?? undefined;
  }

  /** VS Code 내장 ripgrep으로 검색. .gitignore도 자동 반영된다 */
  private async searchTextRipgrep(
    rgPath: string,
    query: string,
    limit: number,
    isStale: () => boolean
  ): Promise<SearchItem[]> {
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => f.uri.fsPath);
    if (roots.length === 0) {
      return [];
    }
    // 우선순위 정렬을 위해 limit보다 넉넉히 모은 뒤 자른다
    const matches = await runRipgrep(rgPath, {
      query,
      roots,
      excludeGlobs: splitGlobs(config().get<string>('excludeGlob')),
      limit: Math.min(limit * 3, 300),
      isStale,
    });

    const openDocs = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    const withUri = matches.map((m) => ({ m, uri: vscode.Uri.file(m.file) }));
    withUri.sort((a, b) => this.textPriority(a.uri, openDocs) - this.textPriority(b.uri, openDocs));
    return withUri.slice(0, limit).map(({ m, uri }) => toTextItem(m, uri, query));
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
  private async searchTextScan(query: string, limit: number, isStale: () => boolean): Promise<SearchItem[]> {
    const needle = query.toLowerCase();
    const results: SearchItem[] = [];
    const decoder = new TextDecoder('utf-8');

    const openDocs = new Map<string, vscode.TextDocument>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme === 'file') {
        openDocs.set(d.uri.toString(), d);
      }
    }
    const openKeys = new Set(openDocs.keys());
    const files = [...(await this.getFiles())].sort(
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
        if (!content.toLowerCase().includes(needle)) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          const col = lines[i].toLowerCase().indexOf(needle);
          if (col >= 0) {
            results.push(
              toTextItem({ file: uri.fsPath, line: i, column: col, length: query.length, text: lines[i] }, uri, query)
            );
          }
        }
      } catch {
        // 읽을 수 없는 파일은 무시
      }
    }
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

function toSymbolItems(symbols: vscode.SymbolInformation[], kind: 'classes' | 'symbols'): SearchItem[] {
  return symbols.map((s) => ({
    kind,
    label: s.name,
    description: s.containerName || undefined,
    detail: `${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`,
    icon: symbolIcon(s.kind),
    uri: s.location.uri,
    range: s.location.range,
  }));
}

function isClass(s: vscode.SymbolInformation): boolean {
  return CLASS_KINDS.has(s.kind);
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

/** 파일 스킴이면서 열려 있는 워크스페이스 폴더 안에 있을 때만 프로젝트 항목으로 본다 */
function isInProject(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

function symbolIcon(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.Class:
      return 'symbol-class';
    case vscode.SymbolKind.Interface:
      return 'symbol-interface';
    case vscode.SymbolKind.Enum:
      return 'symbol-enum';
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Constructor:
      return 'symbol-method';
    case vscode.SymbolKind.Field:
    case vscode.SymbolKind.Property:
      return 'symbol-field';
    case vscode.SymbolKind.Variable:
    case vscode.SymbolKind.Constant:
      return 'symbol-variable';
    default:
      return 'symbol-misc';
  }
}
