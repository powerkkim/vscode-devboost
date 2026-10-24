import * as vscode from 'vscode';
import * as path from 'path';

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
  /** 액션 탭 전용: 실행할 커맨드 ID */
  command?: string;
}

const CLASS_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

const MAX_TEXT_FILE_SIZE = 1024 * 1024; // 1MB 넘는 파일은 텍스트 검색에서 제외

export class SearchService implements vscode.Disposable {
  /** IntelliJ "비 프로젝트 항목 포함" 체크박스와 동일. false면 워크스페이스 밖(.m2, JDK 등) 심볼 제외 */
  includeNonProject = vscode.workspace
    .getConfiguration('devBoost.searchEverywhere')
    .get<boolean>('includeNonProject', false);

  private fileCache: vscode.Uri[] | undefined;
  private fileCachePromise: Promise<vscode.Uri[]> | undefined;
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
    return vscode.workspace.getConfiguration('devBoost.searchEverywhere').get<number>('maxResults', 50);
  }

  /** isStale(): 더 새로운 검색이 시작됐으면 true → 긴 작업(텍스트 스캔)을 중간에 멈춘다 */
  async search(tab: TabId, query: string, isStale: () => boolean = () => false): Promise<SearchItem[]> {
    switch (tab) {
      case 'classes':
        return this.searchSymbols(query, true);
      case 'files':
        return this.searchFiles(query);
      case 'symbols':
        return this.searchSymbols(query, false);
      case 'actions':
        return this.searchActions(query);
      case 'text':
        return this.searchText(query, this.max, isStale);
      case 'all': {
        // 종류별로 병렬 검색 후 순서대로 이어붙인다 (IntelliJ처럼 텍스트 매치도 포함)
        const per = Math.max(5, Math.floor(this.max / 3));
        const [classes, files, symbols, actions, text] = await Promise.all([
          this.searchSymbols(query, true),
          this.searchFiles(query),
          this.searchSymbols(query, false),
          this.searchActions(query),
          query.length >= 3 ? this.searchText(query, per, isStale) : Promise.resolve([]),
        ]);
        const classKeys = new Set(classes.map(symbolKey));
        const onlySymbols = symbols.filter((s) => !classKeys.has(symbolKey(s)));
        return [
          ...classes.slice(0, per),
          ...files.slice(0, per),
          ...onlySymbols.slice(0, per),
          ...text.slice(0, per),
          ...actions.slice(0, per),
        ];
      }
    }
  }

  /** 선택된 항목 열기/실행 */
  async open(item: SearchItem): Promise<void> {
    if (item.kind === 'actions' && item.command) {
      await vscode.commands.executeCommand(item.command);
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

  // ───────────────────────── 파일 ─────────────────────────

  private async getFiles(): Promise<vscode.Uri[]> {
    if (this.fileCache) {
      return this.fileCache;
    }
    if (!this.fileCachePromise) {
      const exclude = vscode.workspace
        .getConfiguration('devBoost.searchEverywhere')
        .get<string>('excludeGlob');
      this.fileCachePromise = Promise.resolve(
        vscode.workspace.findFiles('**/*', exclude, 20000)
      ).then((files) => {
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

  private async searchSymbols(query: string, classesOnly: boolean): Promise<SearchItem[]> {
    // 빈 쿼리는 workspace symbol provider가 아무것도 돌려주지 않는 경우가 많다
    if (!query) {
      return [];
    }
    const symbols =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      )) ?? [];

    const seen = new Set<string>();
    return symbols
      .filter((s) => !classesOnly || CLASS_KINDS.has(s.kind))
      // 워크스페이스 폴더에 속하지 않는 위치(jdt:// jar 내부, JDK src.zip, ~/.m2 등)는 기본 제외
      .filter((s) => this.includeNonProject || isInProject(s.location.uri))
      // 같은 라이브러리 클래스가 jar 경로 / 소스 jar 경로로 두 번 오는 것 제거
      .filter((s) => {
        const key = isInProject(s.location.uri)
          ? `${s.location.uri.toString()}#${s.name}#${s.location.range.start.line}`
          : `lib#${s.kind}#${s.containerName}#${s.name}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, this.max)
      .map((s) => ({
        kind: (classesOnly ? 'classes' : 'symbols') as ResultKind,
        label: s.name,
        description: s.containerName || undefined,
        detail: `${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`,
        icon: symbolIcon(s.kind),
        uri: s.location.uri,
        range: s.location.range,
      }));
  }

  // ───────────────────────── 액션 ─────────────────────────

  private async searchActions(query: string): Promise<SearchItem[]> {
    const commands = await vscode.commands.getCommands(true);
    const scored: { score: number; id: string }[] = [];

    for (const id of commands) {
      if (id.startsWith('_')) {
        continue; // 내부 전용 커맨드는 숨김
      }
      const score = query ? fuzzyScore(query, id) : 0;
      if (score >= 0) {
        scored.push({ score, id });
      }
    }
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, this.max).map(({ id }) => ({
      kind: 'actions' as const,
      label: id,
      icon: 'zap',
      command: id,
    }));
  }

  // ───────────────────────── 텍스트 ─────────────────────────

  private async searchText(
    query: string,
    limit: number,
    isStale: () => boolean = () => false
  ): Promise<SearchItem[]> {
    if (query.length < 2) {
      return [];
    }
    const needle = query.toLowerCase();
    const results: SearchItem[] = [];
    const decoder = new TextDecoder('utf-8');

    // 열려 있는 문서(저장 안 된 내용 포함)를 먼저, 그다음 소스 파일, 나머지 순으로 스캔
    const openDocs = new Map<string, vscode.TextDocument>();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme === 'file') {
        openDocs.set(d.uri.toString(), d);
      }
    }
    const files = [...(await this.getFiles())].sort(
      (a, b) => filePriority(a, openDocs) - filePriority(b, openDocs)
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
          // NUL 바이트가 있으면 바이너리로 보고 건너뜀
          if (bytes.subarray(0, 8000).includes(0)) {
            continue;
          }
          content = decoder.decode(bytes);
        }
        // 빠른 사전 체크: 파일 전체에 없으면 줄 단위 분해 생략
        if (!content.toLowerCase().includes(needle)) {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          const col = lines[i].toLowerCase().indexOf(needle);
          if (col >= 0) {
            results.push({
              kind: 'text',
              label: lines[i].trim().slice(0, 200),
              description: `${path.basename(uri.fsPath)}:${i + 1}`,
              detail: vscode.workspace.asRelativePath(uri),
              icon: 'whole-word',
              uri,
              range: new vscode.Range(i, col, i, col + query.length),
            });
          }
        }
      } catch {
        // 읽을 수 없는 파일은 무시
      }
    }
    return results;
  }
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

const SOURCE_EXT = new Set([
  '.java', '.kt', '.xml', '.yml', '.yaml', '.properties', '.sql',
  '.ts', '.js', '.vue', '.tsx', '.jsx', '.html', '.css', '.scss', '.json', '.md', '.gradle',
]);

/** 텍스트 검색 스캔 순서: 0=열린 문서, 1=src 아래 소스, 2=기타 소스, 3=나머지 */
function filePriority(uri: vscode.Uri, openDocs: Map<string, unknown>): number {
  if (openDocs.has(uri.toString())) {
    return 0;
  }
  const ext = path.extname(uri.fsPath).toLowerCase();
  if (!SOURCE_EXT.has(ext)) {
    return 3;
  }
  // 정적 리소스 vendor 폴더(AdminLTE 등)는 뒤로
  if (/[\\/](vendor|static[\\/]vendor|lib)[\\/]/i.test(uri.fsPath)) {
    return 2;
  }
  return /[\\/]src[\\/]/.test(uri.fsPath) ? 1 : 2;
}

function symbolKey(item: SearchItem): string {
  return `${item.uri?.toString()}#${item.label}#${item.range?.start.line}`;
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
