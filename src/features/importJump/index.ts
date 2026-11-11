import * as fs from 'fs';
import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import {
  Aliases,
  Files,
  Hit,
  ImportStatement,
  Resolver,
  Target,
  applyAlias,
  dirname,
  findExport,
  hitAt,
  joinPath,
  parseImports,
  parseTsconfigAliases,
  parseViteAliases,
  resolveFile,
} from './resolve';

/**
 * import 따라가기: `import { UserType } from '@/types/user'` 처럼 경로 별칭으로 가져온 이름을
 * Ctrl+클릭하면 같은 파일의 import 줄이 아니라 실제 선언으로 간다. 마우스를 올리면 선언 내용을 보여 준다.
 *
 * 프로젝트의 tsconfig 에 별칭(paths)이 없어 편집기가 경로를 풀지 못할 때를 위한 것 — 편집기가 이미
 * 다른 파일의 선언을 찾아 주면 아무것도 보태지 않는다. 설정 파일은 건드리지 않고, 별칭은 vite.config ·
 * tsconfig · 개인 설정(devBoost.importJump.aliases)에서 읽는다.
 * 미리 만들어 두는 색인은 없다: 이름을 누르거나 올렸을 때 그 파일의 import 와 대상 파일 하나만 읽는다.
 */

const LANGS = ['vue', 'typescript', 'typescriptreact', 'javascript', 'javascriptreact'];
const CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
const TSCONFIGS = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];
/** 별칭을 다시 읽기까지의 시간 (설정 파일을 고치면 이 뒤에 반영) */
const ALIAS_TTL_MS = 3000;
/** 미리보기에 보일 최대 줄 수 */
const HOVER_LINES = 30;

function cfg() {
  return vscode.workspace.getConfiguration('devBoost.importJump');
}

const slash = (p: string) => p.replace(/\\/g, '/');

/** 디스크 파일 (열려 있는 문서는 저장 전 내용으로). 읽은 글은 수정 시각이 같으면 다시 쓰지 않는다 */
class DiskFiles implements Files {
  private cache = new Map<string, { mtime: number; text: string }>();

  read(p: string): string | undefined {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && slash(d.uri.fsPath) === p);
    if (open) return open.getText();
    try {
      const mtime = fs.statSync(p).mtimeMs;
      const hit = this.cache.get(p);
      if (hit && hit.mtime === mtime) return hit.text;
      const text = fs.readFileSync(p, 'utf8');
      this.cache.set(p, { mtime, text });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
      return text;
    } catch {
      return undefined;
    }
  }

  exists(p: string): boolean {
    return fs.existsSync(p);
  }

  isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }
}

function positionAt(text: string, offset: number): vscode.Position {
  let line = 0;
  let last = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i + 1;
  }
  return new vscode.Position(line, offset - last);
}

export const importJump: Feature = {
  id: 'importJump',
  name: 'import 따라가기',
  start() {
    const files = new DiskFiles();
    const importCache = new Map<string, { version: number; imports: ImportStatement[] }>();
    const aliasCache = new Map<string, { at: number; aliases: Aliases }>();
    /** 편집기의 원래 결과를 물어보는 중인 자리 (그 물음이 다시 여기로 들어오므로 표시해 둔다) */
    const asking = new Set<string>();

    /** 파일이 속한 프로젝트 폴더: 위로 올라가며 vite.config 나 package.json 이 있는 첫 폴더 */
    const projectRoot = (file: string): string => {
      const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
      const stop = ws ? slash(ws.uri.fsPath) : undefined;
      let dir = dirname(file);
      for (let i = 0; i < 30; i++) {
        if ([...CONFIGS, 'package.json'].some((f) => fs.existsSync(dir + '/' + f))) return dir;
        const up = dirname(dir);
        if (dir === stop || up === dir || up === '.' || up === '') break;
        dir = up;
      }
      return stop ?? dirname(file);
    };

    /** 별칭: 개인 설정 > vite.config > tsconfig paths > 관례(@·~ → src) */
    const aliasesOf = (root: string): Aliases => {
      const hit = aliasCache.get(root);
      if (hit && Date.now() - hit.at < ALIAS_TTL_MS) return hit.aliases;
      const aliases: Aliases = {};
      if (files.isDirectory(root + '/src')) {
        aliases['@'] = 'src';
        aliases['~'] = 'src';
      }
      for (const f of TSCONFIGS) {
        const text = files.read(root + '/' + f);
        if (text !== undefined) Object.assign(aliases, parseTsconfigAliases(text));
      }
      for (const f of CONFIGS) {
        const text = files.read(root + '/' + f);
        if (text !== undefined) Object.assign(aliases, parseViteAliases(text));
      }
      const mine = cfg().get<Record<string, string>>('aliases', {});
      for (const [k, v] of Object.entries(mine ?? {})) {
        if (typeof v === 'string' && k) aliases[k.replace(/\/\*?$/, '')] = slash(v).replace(/\/\*?$/, '');
      }
      aliasCache.set(root, { at: Date.now(), aliases });
      return aliases;
    };

    const resolverFor = (root: string, aliases: Aliases): Resolver => ({
      module: (spec, from) => {
        const base = /^\.{1,2}(\/|$)/.test(spec) ? joinPath(dirname(from), spec) : applyAlias(spec, aliases, root);
        return base === undefined ? undefined : resolveFile(base, files);
      },
    });

    /** 문서의 그 자리가 별칭 import 로 가져온 이름(또는 그 경로)이면 실제 선언 */
    const locate = (doc: vscode.TextDocument, pos: vscode.Position): { hit: Hit; target: Target } | undefined => {
      if (doc.uri.scheme !== 'file') return undefined;
      const key = doc.uri.toString();
      let entry = importCache.get(key);
      if (!entry || entry.version !== doc.version) {
        entry = { version: doc.version, imports: parseImports(doc.getText()) };
        importCache.set(key, entry);
        if (importCache.size > 50) importCache.delete(importCache.keys().next().value as string);
      }
      if (!entry.imports.length) return undefined;
      const hit = hitAt(doc.getText(), doc.offsetAt(pos), entry.imports);
      if (!hit) return undefined;
      const spec = hit.statement.module;
      if (/^\.{1,2}(\/|$)/.test(spec)) return undefined; // 상대 경로는 편집기가 푼다
      const file = slash(doc.uri.fsPath);
      const root = projectRoot(file);
      const aliases = aliasesOf(root);
      const base = applyAlias(spec, aliases, root);
      if (base === undefined) return undefined; // 별칭이 아님 (패키지)
      const targetFile = resolveFile(base, files);
      if (!targetFile) return undefined;
      const target = hit.binding
        ? findExport(targetFile, hit.binding.imported, files, resolverFor(root, aliases))
        : { file: targetFile, start: 0, end: 0, declStart: 0, declEnd: 0 };
      return target ? { hit, target } : undefined;
    };

    /** 편집기가 이미 다른 파일의 선언을 찾아 주는가 (별칭이 제대로 설정된 프로젝트) — 그러면 끼어들지 않는다 */
    const editorResolves = async (doc: vscode.TextDocument, pos: vscode.Position): Promise<boolean> => {
      const key = `${doc.uri.toString()}#${doc.offsetAt(pos)}`;
      if (asking.has(key)) return false;
      asking.add(key);
      try {
        const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
        return (found ?? []).some((l) => ('targetUri' in l ? l.targetUri : l.uri).toString() !== doc.uri.toString());
      } catch {
        return false;
      } finally {
        asking.delete(key);
      }
    };

    const linkOf = (doc: vscode.TextDocument, hit: Hit, t: Target): vscode.LocationLink => {
      const text = files.read(t.file) ?? '';
      return {
        originSelectionRange: new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end)),
        targetUri: vscode.Uri.file(t.file),
        targetRange: new vscode.Range(positionAt(text, t.declStart), positionAt(text, Math.max(t.declEnd, t.end))),
        targetSelectionRange: new vscode.Range(positionAt(text, t.start), positionAt(text, t.end)),
      };
    };

    const definition: vscode.DefinitionProvider = {
      async provideDefinition(doc, pos, token) {
        const key = `${doc.uri.toString()}#${doc.offsetAt(pos)}`;
        if (asking.has(key)) return undefined; // 원래 결과를 묻는 중: 우리 것은 빼고 답하게
        const found = locate(doc, pos);
        if (!found) return undefined;
        if (await editorResolves(doc, pos)) return undefined;
        if (token.isCancellationRequested) return undefined;
        return [linkOf(doc, found.hit, found.target)];
      },
    };

    const hover: vscode.HoverProvider = {
      async provideHover(doc, pos, token) {
        if (!cfg().get<boolean>('hover', true)) return undefined;
        const found = locate(doc, pos);
        if (!found) return undefined;
        if (await editorResolves(doc, pos)) return undefined;
        if (token.isCancellationRequested) return undefined;
        const t = found.target;
        const text = files.read(t.file) ?? '';
        const md = new vscode.MarkdownString();
        if (t.declEnd > t.declStart) {
          const lines = text.slice(t.declStart, t.declEnd).replace(/\r/g, '').split('\n');
          const shown = lines.slice(0, HOVER_LINES).join('\n') + (lines.length > HOVER_LINES ? `\n// … (${lines.length - HOVER_LINES}줄 더)` : '');
          md.appendCodeblock(shown, /\.(?:js|jsx|mjs)$/.test(t.file) ? 'javascript' : 'typescript');
        }
        const rel = slash(vscode.workspace.asRelativePath(vscode.Uri.file(t.file)));
        md.appendMarkdown(`${rel}${t.end > t.start ? `:${positionAt(text, t.start).line + 1}` : ''}`);
        return new vscode.Hover(md, new vscode.Range(doc.positionAt(found.hit.start), doc.positionAt(found.hit.end)));
      },
    };

    /** 단축키: 커서 자리의 실제 선언으로 바로 간다. 우리가 풀 것이 아니면 편집기의 "정의로 이동" 그대로 */
    const go = async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const found = LANGS.includes(ed.document.languageId) ? locate(ed.document, ed.selection.active) : undefined;
      if (!found) {
        await vscode.commands.executeCommand('editor.action.revealDefinition');
        return;
      }
      const link = linkOf(ed.document, found.hit, found.target);
      const target = await vscode.window.showTextDocument(link.targetUri, { selection: link.targetSelectionRange });
      target.revealRange(link.targetSelectionRange ?? link.targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    };

    const selector = LANGS.map((language) => ({ language, scheme: 'file' }));
    return [
      vscode.languages.registerDefinitionProvider(selector, definition),
      vscode.languages.registerHoverProvider(selector, hover),
      vscode.commands.registerCommand('devBoost.importJump.go', go),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('devBoost.importJump') && aliasCache.clear()),
      vscode.workspace.onDidCloseTextDocument((d) => importCache.delete(d.uri.toString())),
    ];
  },
};
