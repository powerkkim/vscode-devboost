import * as vscode from 'vscode';
import * as fs from 'fs';
import { MapperDoc, parseMapper } from './mapper/mapperDoc';
import { FragmentResolver } from './mapper/render';

const EXCLUDE = '{**/node_modules/**,**/target/**,**/build/**,**/bin/**,**/out/**,**/dist/**,**/.git/**,**/.svn/**}';

interface Entry {
  file: string;
  mtime: number;
  doc?: MapperDoc;
}

/**
 * 워크스페이스의 mapper XML 색인: namespace → 파일.
 * 다른 mapper 의 <sql> 조각(<include refid="ns.id">)을 찾을 때 쓴다.
 * 처음 필요할 때 한 번 훑고, 이후에는 XML 이 바뀐 것만 다시 읽는다.
 */
export class MapperIndex implements vscode.Disposable {
  private byNs = new Map<string, Entry>();
  private byFile = new Map<string, string>();
  private building: Promise<void> | undefined;
  private built = false;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly changed = new vscode.EventEmitter<void>();
  /** 색인이 처음 만들어졌거나 mapper 가 바뀌었을 때 */
  readonly onDidChange = this.changed.event;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.xml');
    const refresh = (uri: vscode.Uri) => {
      if (!this.built) return;
      this.indexFile(uri.fsPath);
      this.changed.fire();
    };
    this.watcher.onDidChange(refresh);
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete((uri) => {
      const ns = this.byFile.get(uri.fsPath);
      if (ns) {
        this.byNs.delete(ns);
        this.byFile.delete(uri.fsPath);
      }
    });
  }

  get ready(): boolean {
    return this.built;
  }

  ensureBuilt(): Promise<void> {
    if (!this.building) {
      this.building = (async () => {
        const files = await vscode.workspace.findFiles('**/*.xml', EXCLUDE, 20000);
        for (const f of files) this.indexFile(f.fsPath);
        this.built = true;
        this.changed.fire();
      })();
    }
    return this.building;
  }

  private indexFile(file: string) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf8', 0, n);
      const m = /<(?:mapper|sqlMap)\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/.exec(head);
      const old = this.byFile.get(file);
      if (old && old !== m?.[1]) this.byNs.delete(old);
      if (!m) {
        this.byFile.delete(file);
        return;
      }
      this.byNs.set(m[1], { file, mtime: -1 });
      this.byFile.set(file, m[1]);
    } catch {
      /* 읽을 수 없는 파일은 무시 */
    }
  }

  /** namespace 의 문서. 열려 있는(저장 안 된) 편집기 내용을 우선한다 */
  docFor(namespace: string): MapperDoc | undefined {
    const e = this.byNs.get(namespace);
    if (!e) return undefined;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === e.file);
    if (open && open.isDirty) return parseMapper(open.getText(), e.file) ?? undefined;
    try {
      const mtime = fs.statSync(e.file).mtimeMs;
      if (!e.doc || e.mtime !== mtime) {
        e.doc = parseMapper(fs.readFileSync(e.file, 'utf8'), e.file) ?? undefined;
        e.mtime = mtime;
      }
      return e.doc;
    } catch {
      return undefined;
    }
  }

  resolver(): FragmentResolver {
    return (ns, id) => {
      const doc = this.docFor(ns);
      const el = doc?.fragments.get(id);
      return doc && el ? { el, doc } : undefined;
    };
  }

  /** namespace + id 로 statement 위치 찾기 (연관 쿼리로 이동할 때) */
  locate(namespace: string, id: string): { file: string; line: number } | undefined {
    const doc = this.docFor(namespace);
    const st = doc?.statements.find((s) => s.id === id);
    return doc && st ? { file: doc.file, line: st.line } : undefined;
  }

  dispose() {
    this.watcher.dispose();
    this.changed.dispose();
  }
}
