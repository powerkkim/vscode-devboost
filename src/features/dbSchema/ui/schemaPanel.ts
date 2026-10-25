import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { OracleBridge } from '../../../core/oracleBridge';
import { buildDefaultSql, buildMainSql, normalizePrefixes } from '../schema/collectSql';
import { ImportPart, importText } from '../schema/importer';
import { mergeImport } from '../schema/merge';
import { buildTableDoc, localDate, tableDocFileNames } from '../schema/tableDoc';
import { SchemaFile } from '../schema/types';
import { SchemaStore } from '../schemaStore';

/**
 * DB 스키마 화면 (Webview). 위: 수집(① 범위 → ② 본 쿼리 → ③ 기본값 → ④ 저장), 아래: 가져온 데이터 + 테이블 정의서 추출.
 *
 * 화면 → 확장: ready | settings{prefixes,label} | send{which,run} | copySql{which} | importClipboard | importFile
 *              | clearStaged | save | select{file} | detail{table} | exportDoc{tables} | openPath{path,external}
 * 확장 → 화면: state{…} | detail{table,columns,…} | notice{text,kind}
 */
const UI_KEY = 'devBoost.dbSchema.ui';

interface UiSettings {
  prefixes: string[];
  label: string;
  /** 마지막으로 본 저장 파일 */
  file?: string;
  exportDir?: string;
}

export class SchemaPanel {
  private static current: SchemaPanel | undefined;

  private main: ImportPart | undefined;
  private defaults: ImportPart | undefined;
  private codes: ImportPart | undefined;
  private schema: SchemaFile | undefined;
  private lastExport: { index: string; detail: string; dir: string; tables: number } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, deps: SchemaDeps) {
    if (SchemaPanel.current) {
      SchemaPanel.current.panel.reveal();
      void SchemaPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel('devBoostDbSchema', 'DB 스키마', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'dbSchema')],
    });
    SchemaPanel.current = new SchemaPanel(context, deps, panel);
  }

  static closeAll() {
    SchemaPanel.current?.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: SchemaDeps,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.iconPath = new vscode.ThemeIcon('database');
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m).catch((e) => this.notice(`오류: ${(e as Error).message}`, 'warn'))),
      deps.oracle.onDidChange(() => void this.refresh())
    );
  }

  private get ui(): UiSettings {
    const s = this.context.workspaceState.get<UiSettings>(UI_KEY);
    return { prefixes: s?.prefixes ?? ['TB_'], label: s?.label ?? '개발', file: s?.file, exportDir: s?.exportDir };
  }

  private setUi(patch: Partial<UiSettings>) {
    void this.context.workspaceState.update(UI_KEY, { ...this.ui, ...patch });
  }

  private async onMessage(m: Msg) {
    switch (m.type) {
      case 'ready':
        return this.refresh();
      case 'settings':
        this.setUi({ prefixes: normalizePrefixes(m.prefixes ?? []), label: (m.label ?? '').trim() });
        return this.refresh();
      case 'send': {
        const sql = this.sql(m.which);
        const msg = await this.deps.oracle.send(sql, { action: m.run ? 'statement' : 'none', insert: 'append' });
        this.notice(m.run ? `${msg} 결과 그리드 전체를 헤더와 함께 복사한 뒤 [클립보드에서 가져오기]를 누르세요.` : msg);
        return;
      }
      case 'copySql':
        await vscode.env.clipboard.writeText(this.sql(m.which));
        this.notice('쿼리를 복사했습니다. 다른 DB 도구에서 실행한 뒤 결과를 복사해 오세요.');
        return;
      case 'importClipboard':
        return this.importFrom(await vscode.env.clipboard.readText(), '클립보드');
      case 'importFile': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          filters: { '수집 결과': ['csv', 'tsv', 'txt', 'json'] },
          title: '수집 결과 파일 (CSV / JSON)',
        });
        for (const f of picked ?? []) {
          await this.importFrom(Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8'), f.path.split('/').pop() ?? '파일');
        }
        return;
      }
      case 'clearStaged':
        this.main = this.defaults = this.codes = undefined;
        return this.refresh();
      case 'save':
        return this.save();
      case 'select':
        this.setUi({ file: m.file });
        this.schema = m.file ? await this.deps.store.read(m.file) : undefined;
        return this.refresh();
      case 'detail':
        return this.sendDetail(m.table ?? '');
      case 'exportDoc':
        return this.exportDoc(m.tables ?? []);
      case 'openPath':
        if (m.path) {
          const uri = vscode.Uri.file(m.path);
          if (m.external) await vscode.env.openExternal(uri);
          else await vscode.commands.executeCommand('revealFileInOS', uri);
        }
        return;
    }
  }

  private sql(which: string | undefined): string {
    const ps = this.ui.prefixes;
    return which === 'default' ? buildDefaultSql(ps) : buildMainSql(ps);
  }

  private async importFrom(text: string, from: string) {
    const part = importText(text);
    const errors = part.problems.filter((p) => p.level === 'error');
    if (errors.length && part.kind !== 'main') {
      this.notice(`${from}: ${errors[0].message}`, 'warn');
      return this.refresh();
    }
    if (part.kind === 'defaults') this.defaults = part;
    else if (part.kind === 'codes') this.codes = part;
    else this.main = part; // main / columns / json
    if (part.kind === 'main' && part.summary) {
      const now = normalizePrefixes(this.ui.prefixes).join(',');
      const got = part.summary.prefixes.join(',');
      if (now !== got) {
        part.problems.push({ level: 'warn', message: `결과의 접두어(${got || '전체'})가 화면의 접두어(${now || '전체'})와 다릅니다. 결과 기준으로 저장합니다.` });
      }
    }
    return this.refresh();
  }

  private async existingFor(): Promise<SchemaFile | undefined> {
    const owner = this.main?.summary?.schema ?? this.main?.json?.source.schema ?? this.schema?.source.schema;
    if (!owner) return this.schema;
    const label = this.ui.label || undefined;
    const files = await this.deps.store.list();
    const f = files.find((x) => x.schema === owner && (x.label ?? '') === (label ?? ''));
    return f ? this.deps.store.read(f.file) : undefined;
  }

  private async save() {
    if (!this.main && !this.defaults && !this.codes) {
      this.notice('가져온 결과가 없습니다.', 'warn');
      return;
    }
    if (this.main?.problems.some((p) => p.level === 'error')) {
      this.notice('본 쿼리 결과에 오류가 있어 저장하지 않습니다. 다시 복사해 가져오세요.', 'warn');
      return;
    }
    const existing = await this.existingFor();
    if (!this.main && !existing) {
      this.notice('본 쿼리 결과를 먼저 가져오세요 (기본값·공통코드는 기존 스키마에 합쳐집니다).', 'warn');
      return;
    }
    let fallbackSchema = existing?.source.schema;
    if (this.main && !this.main.summary && !this.main.json && !fallbackSchema) {
      fallbackSchema = (await vscode.window.showInputBox({ prompt: '스키마 이름 (결과에 스키마 정보가 없습니다)', value: 'APP' }))?.trim().toUpperCase();
      if (!fallbackSchema) return;
    }
    const r = mergeImport({
      existing,
      main: this.main,
      defaults: this.defaults,
      codes: this.codes,
      label: this.ui.label || undefined,
      fallbackSchema,
    });
    if (r.notes.some((n) => n.level === 'error')) {
      this.notice(r.notes.find((n) => n.level === 'error')!.message, 'warn');
      return;
    }
    const file = await this.deps.store.write(r.schema);
    this.schema = r.schema;
    this.setUi({ file });
    this.main = this.defaults = this.codes = undefined;
    const kept = r.keptTables ? ` (다른 테이블 ${r.keptTables}개 유지)` : '';
    const warn = r.notes.length ? ` — ${r.notes.map((n) => n.message).join(' ')}` : '';
    this.notice(`${file} 저장: 테이블 ${r.replacedTables}개 반영${kept}${warn}`, r.notes.length ? 'warn' : 'info');
    return this.refresh();
  }

  private async exportDoc(tables: string[]) {
    if (!this.schema) return;
    if (tables.length === 0) {
      this.notice('정의서로 만들 테이블을 고르세요.', 'warn');
      return;
    }
    const root = this.deps.store.root();
    const defaultDir = this.ui.exportDir ? vscode.Uri.file(this.ui.exportDir) : root;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: defaultDir,
      openLabel: '이 폴더에 저장',
      title: '테이블 정의서 CSV 저장 폴더',
    });
    const dir = picked?.[0];
    if (!dir) return;
    const today = localDate();
    const doc = buildTableDoc(this.schema, { tables, today });
    const names = tableDocFileNames(this.schema, today);
    const indexUri = vscode.Uri.joinPath(dir, names.index);
    const detailUri = vscode.Uri.joinPath(dir, names.detail);
    await vscode.workspace.fs.writeFile(indexUri, Buffer.from(doc.index, 'utf8'));
    await vscode.workspace.fs.writeFile(detailUri, Buffer.from(doc.detail, 'utf8'));
    this.setUi({ exportDir: dir.fsPath });
    this.lastExport = { index: indexUri.fsPath, detail: detailUri.fsPath, dir: dir.fsPath, tables: doc.tableCount };
    this.notice(`테이블 ${doc.tableCount}개 · 컬럼 ${doc.columnCount}개 정의서를 저장했습니다.`);
    const open = await vscode.window.showInformationMessage(`테이블 정의서 ${doc.tableCount}개를 저장했습니다: ${names.detail}`, '정의서 열기', '목차 열기', '폴더 열기');
    if (open === '정의서 열기') await vscode.env.openExternal(detailUri);
    else if (open === '목차 열기') await vscode.env.openExternal(indexUri);
    else if (open === '폴더 열기') await vscode.commands.executeCommand('revealFileInOS', detailUri);
    return this.refresh();
  }

  private sendDetail(table: string) {
    const s = this.schema;
    if (!s) return;
    const cons = s.constraints.filter((c) => c.table === table);
    const pk = cons.find((c) => c.kind === 'primary');
    const columns = s.columns
      .filter((c) => c.table === table)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        name: c.name, comment: c.comment ?? '', type: c.typeText, nullable: c.nullable, default: c.default ?? '',
        pk: pk ? pk.columns.indexOf(c.name) + 1 : 0,
        fk: cons.filter((k) => k.kind === 'foreign' && k.columns.includes(c.name)).map((k) => k.refTable ?? k.name).join(', '),
      }));
    const indexes = s.indexes
      .filter((x) => x.table === table)
      .map((x) => ({ name: x.name, unique: x.unique, columns: x.columns.map((c) => c.name + (c.desc ? ' DESC' : '')).join(', ') }));
    void this.panel.webview.postMessage({ type: 'detail', table, columns, indexes });
  }

  private async refresh() {
    const ui = this.ui;
    const files = await this.deps.store.list();
    if (!this.schema && files.length) {
      const f = files.find((x) => x.file === ui.file) ?? files[0];
      this.schema = await this.deps.store.read(f.file);
      if (this.schema) this.setUi({ file: f.file });
    }
    const s = this.schema;
    const pkOf = new Map<string, string>();
    const colCount = new Map<string, number>();
    if (s) {
      for (const c of s.constraints) if (c.kind === 'primary') pkOf.set(c.table, c.columns.join(', '));
      for (const c of s.columns) colCount.set(c.table, (colCount.get(c.table) ?? 0) + 1);
    }
    const stage = (p: ImportPart | undefined) =>
      p && {
        kind: p.kind,
        summary: p.summary,
        received: p.received,
        tables: p.tables.length,
        columns: p.columns.length,
        constraints: p.constraints.length,
        indexes: p.indexes.length,
        defaults: p.defaults.length,
        codes: p.codes.length,
        problems: p.problems,
      };
    void this.panel.webview.postMessage({
      type: 'state',
      ui,
      hasWorkspace: !!this.deps.store.root(),
      oracle: { installed: this.deps.oracle.installed, target: this.deps.oracle.targetName ?? null },
      staged: { main: stage(this.main), defaults: stage(this.defaults), codes: stage(this.codes) },
      files,
      current: s && {
        file: files.find((f) => f.schema === s.source.schema && (f.label ?? '') === (s.source.label ?? ''))?.file ?? ui.file,
        source: s.source,
        codes: s.codes?.length ?? 0,
        defaults: s.columns.filter((c) => c.default !== undefined).length,
        tables: s.tables.map((t) => ({ name: t.name, kind: t.kind, comment: t.comment ?? '', columns: colCount.get(t.name) ?? 0, pk: pkOf.get(t.name) ?? '' })),
      },
      lastExport: this.lastExport,
    });
  }

  private notice(text: string, kind: 'info' | 'warn' = 'info') {
    void this.panel.webview.postMessage({ type: 'notice', text, kind });
  }

  private html(): string {
    const wv = this.panel.webview;
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dbSchema');
    const js = wv.asWebviewUri(vscode.Uri.joinPath(base, 'schema.js'));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(base, 'schema.css'));
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wv.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>DB 스키마</title></head>
<body><div id="app"><div class="empty">불러오는 중…</div></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private dispose() {
    SchemaPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

export interface SchemaDeps {
  store: SchemaStore;
  oracle: OracleBridge;
}

interface Msg {
  type: string;
  prefixes?: string[];
  label?: string;
  which?: string;
  run?: boolean;
  file?: string;
  table?: string;
  tables?: string[];
  path?: string;
  external?: boolean;
}
