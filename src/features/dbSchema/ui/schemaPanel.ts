import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { OracleBridge } from '../../../core/oracleBridge';
import { buildCollectSql, normalizePrefixes } from '../schema/collectSql';
import { ImportPart, importText } from '../schema/importer';
import { mergeImport } from '../schema/merge';
import { buildTableDoc, buildTableDocXlsx, localDate, tableDocXlsxName } from '../schema/tableDoc';
import { SchemaFile } from '../schema/types';
import { decodeText } from '../schema/csv';
import { SchemaStore } from '../schemaStore';

/**
 * DB 스키마 화면 (Webview). 위: 수집(① 범위 → ② 수집 쿼리 → ③ 저장), 아래: 가져온 데이터 + 테이블 정의서 추출.
 *
 * 화면 → 확장: ready | settings{prefixes,label} | send{run} | copySql | importClipboard | importFile
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
  private codes: ImportPart | undefined;
  private schema: SchemaFile | undefined;
  /** 보고 있는 스키마가 바뀔 때마다 1씩 (화면이 열어 둔 상세·선택을 새로 맞추는 기준) */
  private rev = 0;
  private lastExport: { files: { label: string; path: string }[]; tables: number } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, deps: SchemaDeps) {
    deps.store.pinRoot();
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
        this.applyInputs(m);
        const sql = this.sql();
        await this.deps.oracle.run(
          sql,
          { action: m.run ? 'statement' : 'none', insert: 'append' },
          (text, kind, since) => this.notice(text, kind, since),
          '결과 그리드 전체를 헤더와 함께 복사한 뒤 [클립보드에서 가져오기]를 누르세요.'
        );
        return;
      }
      case 'copySql':
        this.applyInputs(m);
        await vscode.env.clipboard.writeText(this.sql());
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
          const { text, encoding } = decodeText(await vscode.workspace.fs.readFile(f));
          const name = f.path.split('/').pop() ?? '파일';
          if (encoding === 'cp949') this.notice(`${name}: UTF-8 이 아니라 한국어 Windows 인코딩(CP949)으로 읽었습니다.`);
          await this.importFrom(text, name);
        }
        return;
      }
      case 'clearStaged':
        this.main = this.codes = undefined;
        return this.refresh();
      case 'save':
        return this.save();
      case 'select':
        this.setUi({ file: m.file });
        this.schema = m.file ? await this.deps.store.read(m.file) : undefined;
        this.rev++;
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

  /** 버튼과 함께 온 입력값을 바로 반영 (입력칸의 저장 지연 400ms 안에 버튼을 눌러도 화면의 접두어로 만들도록) */
  private applyInputs(m: Msg) {
    if (m.prefixes) this.setUi({ prefixes: normalizePrefixes(m.prefixes), label: (m.label ?? this.ui.label).trim() });
  }

  private sql(): string {
    return buildCollectSql(this.ui.prefixes);
  }

  private async importFrom(text: string, from: string) {
    const part = importText(text);
    const errors = part.problems.filter((p) => p.level === 'error');
    if (errors.length && part.kind !== 'collect') {
      this.notice(`${from}: ${errors[0].message}`, 'warn');
      return this.refresh();
    }
    if (part.kind === 'codes') this.codes = part;
    else this.main = part; // collect / columns / json
    if (part.kind === 'collect' && part.summary) {
      // 결과(LISTAGG)는 정렬되어 오므로 양쪽 다 정렬해서 비교
      const now = normalizePrefixes(this.ui.prefixes).sort().join(',');
      const got = normalizePrefixes(part.summary.prefixes).sort().join(',');
      if (now !== got) {
        part.problems.push({ level: 'warn', message: `결과의 접두어(${got || '전체'})가 화면의 접두어(${now || '전체'})와 다릅니다. 결과 기준으로 저장합니다.` });
      }
    }
    return this.refresh();
  }

  private async findSaved(owner: string, label: string | undefined): Promise<SchemaFile | undefined> {
    const files = await this.deps.store.list();
    const f = files.find((x) => x.schema === owner && (x.label ?? '') === (label ?? ''));
    return f ? this.deps.store.read(f.file) : undefined;
  }

  private async save() {
    if (!this.main && !this.codes) {
      this.notice('가져온 결과가 없습니다.', 'warn');
      return;
    }
    if (this.main?.problems.some((p) => p.level === 'error')) {
      this.notice('수집 결과에 오류가 있어 저장하지 않습니다. 다시 복사해 가져오세요.', 'warn');
      return;
    }
    // 어느 파일에 합칠지: 결과에 적힌 스키마 + 화면의 환경. 공통코드만 가져왔으면 지금 보고 있는 파일
    const uiLabel = this.ui.label || undefined;
    let existing: SchemaFile | undefined;
    let label: string | undefined;
    let fallbackSchema: string | undefined;
    if (this.main?.json) {
      const src = this.main.json.source;
      existing = await this.findSaved(src.schema, src.label);
    } else if (this.main?.summary?.schema) {
      label = uiLabel;
      existing = await this.findSaved(this.main.summary.schema, label);
    } else if (this.main) {
      // REC 없는 컬럼 명세: 스키마 이름을 물어본다 (지금 보고 있는 파일을 말없이 덮지 않게)
      fallbackSchema = (
        await vscode.window.showInputBox({
          prompt: '이 결과의 스키마 이름 (결과에 스키마 정보가 없습니다)',
          value: this.schema?.source.schema ?? 'APP',
        })
      )
        ?.trim()
        .toUpperCase();
      if (!fallbackSchema) return;
      label = uiLabel;
      existing = await this.findSaved(fallbackSchema, label);
    } else {
      existing = this.schema;
      if (!existing) {
        this.notice('스키마 수집 결과를 먼저 가져오세요 (공통코드는 저장된 스키마에 합쳐집니다).', 'warn');
        return;
      }
    }
    const r = mergeImport({ existing, main: this.main, codes: this.codes, label, fallbackSchema });
    if (r.notes.some((n) => n.level === 'error')) {
      this.notice(r.notes.find((n) => n.level === 'error')!.message, 'warn');
      return;
    }
    if (r.fullReplace && r.existingTables > 0) {
      const ok = await vscode.window.showWarningMessage(
        `저장된 ${r.schema.source.schema}${r.schema.source.label ? ' · ' + r.schema.source.label : ''} 스키마를 통째로 바꿉니다.`,
        { modal: true, detail: `기존 테이블 ${r.existingTables}개 → 이번 결과 테이블 ${r.schema.tables.length}개.\n접두어 없이(전체로) 받은 결과라 기존 내용은 남지 않습니다.` },
        '바꾸기'
      );
      if (ok !== '바꾸기') return;
    }
    const file = await this.deps.store.write(r.schema);
    this.schema = r.schema;
    this.rev++;
    this.setUi({ file });
    this.main = this.codes = undefined;
    const kept = r.keptTables ? ` (다른 테이블 ${r.keptTables}개 유지)` : '';
    const warn = r.notes.length ? ` — ${r.notes.map((n) => n.message).join(' ')}` : '';
    this.notice(`${file} 저장: 테이블 ${r.replacedTables}개 반영${kept}${warn}`, r.notes.length ? 'warn' : 'info');
    return this.refresh();
  }

  /**
   * 정의서 저장: 파일 저장 창(이름 입력)으로 받는다.
   *  - .xlsx (기본): 목차 시트 + 테이블마다 시트
   *  - .csv: 고른 이름으로 정의서, 같은 폴더에 "<이름>_목차.csv"
   */
  private async exportDoc(tables: string[]) {
    if (!this.schema) return;
    if (tables.length === 0) {
      this.notice('정의서로 만들 테이블을 고르세요.', 'warn');
      return;
    }
    const today = localDate();
    const dir = this.ui.exportDir ? vscode.Uri.file(this.ui.exportDir) : this.deps.store.root();
    const fileName = tableDocXlsxName(this.schema, today);
    const target = await vscode.window.showSaveDialog({
      defaultUri: dir ? vscode.Uri.joinPath(dir, fileName) : undefined,
      filters: { 'Excel 통합 문서': ['xlsx'], CSV: ['csv'] },
      saveLabel: '정의서 저장',
      title: '테이블 정의서 저장',
    });
    if (!target) return;
    const parent = vscode.Uri.joinPath(target, '..');
    let files: { label: string; uri: vscode.Uri }[];
    let tableCount: number;
    let columnCount: number;
    if (/\.csv$/i.test(target.path)) {
      const doc = buildTableDoc(this.schema, { tables, today });
      const indexUri = target.with({ path: target.path.replace(/\.csv$/i, '_목차.csv') });
      await vscode.workspace.fs.writeFile(target, Buffer.from(doc.detail, 'utf8'));
      await vscode.workspace.fs.writeFile(indexUri, Buffer.from(doc.index, 'utf8'));
      files = [{ label: '정의서', uri: target }, { label: '목차', uri: indexUri }];
      ({ tableCount, columnCount } = doc);
    } else {
      const uri = /\.xlsx$/i.test(target.path) ? target : target.with({ path: `${target.path}.xlsx` });
      const doc = buildTableDocXlsx(this.schema, { tables, today });
      try {
        await vscode.workspace.fs.writeFile(uri, doc.data);
      } catch (e) {
        // Excel 에서 같은 파일을 열어 두면 덮어쓸 수 없다
        this.notice(`저장하지 못했습니다 (Excel 에서 열려 있으면 닫고 다시 하세요): ${(e as Error).message}`, 'warn');
        return;
      }
      files = [{ label: '정의서', uri }];
      ({ tableCount, columnCount } = doc);
    }
    this.setUi({ exportDir: parent.fsPath });
    this.lastExport = { files: files.map((f) => ({ label: f.label, path: f.uri.fsPath })), tables: tableCount };
    this.notice(`테이블 ${tableCount}개 · 컬럼 ${columnCount}개 정의서를 저장했습니다.`);
    await this.refresh();
    const open = await vscode.window.showInformationMessage(`테이블 정의서를 저장했습니다: ${files[0].uri.path.split('/').pop()}`, '열기', '폴더 열기');
    if (open === '열기') await vscode.env.openExternal(files[0].uri);
    else if (open === '폴더 열기') await vscode.commands.executeCommand('revealFileInOS', files[0].uri);
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
    try {
      await this.render();
    } catch (e) {
      this.notice(`화면을 그리지 못했습니다: ${(e as Error).message}`, 'warn');
    }
  }

  private async render() {
    const ui = this.ui;
    const files = await this.deps.store.list();
    if (!this.schema && files.length) {
      const f = files.find((x) => x.file === ui.file) ?? files[0];
      this.schema = await this.deps.store.read(f.file);
      this.rev++;
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
        rows: p.rows,
        tables: p.tables.length,
        columns: p.columns.length,
        constraints: p.constraints.length,
        indexes: p.indexes.length,
        defaults: p.columns.filter((c) => c.default !== undefined).length,
        codes: p.codes.length,
        problems: p.problems,
      };
    void this.panel.webview.postMessage({
      type: 'state',
      ui,
      hasWorkspace: !!this.deps.store.root(),
      oracle: { installed: this.deps.oracle.installed, target: this.deps.oracle.targetName ?? null },
      staged: { main: stage(this.main), codes: stage(this.codes) },
      files,
      current: s && {
        rev: this.rev,
        file: files.find((f) => f.schema === s.source.schema && (f.label ?? '') === (s.source.label ?? ''))?.file ?? ui.file,
        source: s.source,
        codes: s.codes?.length ?? 0,
        defaults: s.columns.filter((c) => c.default !== undefined).length,
        tables: s.tables.map((t) => ({ name: t.name, kind: t.kind, comment: t.comment ?? '', columns: colCount.get(t.name) ?? 0, pk: pkOf.get(t.name) ?? '' })),
      },
      lastExport: this.lastExport,
    });
  }

  private notice(text: string, kind: 'info' | 'warn' | 'busy' = 'info', since?: number) {
    // 실행이 끝나 알릴 때 화면이 이미 닫혔을 수 있다
    try {
      void this.panel.webview.postMessage({ type: 'notice', text, kind, since });
    } catch {
      /* 닫힌 화면 */
    }
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
  run?: boolean;
  file?: string;
  table?: string;
  tables?: string[];
  path?: string;
  external?: boolean;
}
