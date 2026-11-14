import * as path from 'path';
import * as vscode from 'vscode';
import { JavaClass, parseJava } from '../sourceAtlas/backend/javaParser';
import { Endpoint, ResolveClass, readEndpoints, toRequest, warningOf } from './controller';
import { ApiRequest } from './model';
import { SpringServer, findSpringServer } from './springConfig';

/**
 * Controller ↔ API 콘솔을 잇는 편집기 쪽 일: 매핑 메서드 위의 CodeLens, 커서가 있는 메서드 찾기,
 * 다른 파일의 DTO 찾아 읽기. 열려 있는 Java 파일만 읽는다 (색인 없음).
 */

const EXCLUDE = '**/{node_modules,target,build,out,dist,.gradle,.git}/**';

/** 문서 하나의 매핑 메서드들 (내용이 같으면 다시 읽지 않는다. 닫았다 다시 연 문서는 버전이 같아도 내용이 다를 수 있다) */
const cache = new Map<string, { version: number; text: string; endpoints: Endpoint[] }>();
export function endpointsOf(doc: vscode.TextDocument): Endpoint[] {
  const key = doc.uri.toString();
  const hit = cache.get(key);
  const text = doc.getText();
  if (hit && hit.version === doc.version && hit.text === text) return hit.endpoints;
  let endpoints: Endpoint[] = [];
  try {
    endpoints = readEndpoints(text, doc.uri.fsPath);
  } catch {
    // 읽지 못한 파일은 매핑이 없는 것으로
  }
  cache.set(key, { version: doc.version, text, endpoints });
  if (cache.size > 30) cache.delete(cache.keys().next().value as string);
  return endpoints;
}

/** 이 줄(0부터)이 들어 있는 매핑 메서드 */
export function endpointAt(doc: vscode.TextDocument, line: number): Endpoint | undefined {
  const n = line + 1;
  return endpointsOf(doc).find((e) => (e.method.startLine ?? e.method.line) <= n && n <= (e.method.endLine ?? e.method.line));
}

export class EndpointLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh() {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('devBoost.apiConsole').get<boolean>('codeLens', true)) return [];
    const endpoints = endpointsOf(doc);
    const out: vscode.CodeLens[] = [];
    const perClass = new Map<JavaClass, number>();
    for (const e of endpoints) {
      perClass.set(e.cls, (perClass.get(e.cls) ?? 0) + 1);
      const line = Math.max(0, (e.method.startLine ?? e.method.line) - 1);
      out.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: `$(rocket) API 콘솔  ${e.http} ${e.path || '/'}`,
          tooltip: 'DevBoost API 콘솔에서 이 요청을 엽니다 (처음이면 모음에 넣습니다)',
          command: 'devBoost.apiConsole.openEndpoint',
          arguments: [doc.uri, e.origin],
        })
      );
    }
    for (const [cls, n] of perClass) {
      if (n < 2) continue;
      const line = Math.max(0, cls.line - 1);
      out.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: `$(rocket) API 콘솔에 모두 넣기 (${n})`,
          tooltip: '이 Controller 의 요청을 모두 DevBoost API 콘솔 모음에 넣습니다 (이미 있는 것은 그대로 둡니다)',
          command: 'devBoost.apiConsole.addController',
          arguments: [doc.uri, cls.fqcn],
        })
      );
    }
    return out;
  }
}

/** DTO 를 찾아 읽는다: 같은 파일 → import 한 것 → 같은 패키지 → 이름이 같은 파일 */
function makeResolver(): ResolveClass {
  const parsed = new Map<string, Promise<JavaClass[]>>();
  const classesOf = (file: string): Promise<JavaClass[]> => {
    let p = parsed.get(file);
    if (!p) {
      p = (async () => {
        try {
          const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
          const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8');
          return text.length > 1_000_000 ? [] : parseJava(text, file, { detail: true });
        } catch {
          return [];
        }
      })();
      parsed.set(file, p);
    }
    return p;
  };
  const found = new Map<string, Promise<vscode.Uri[]>>();
  const filesNamed = (name: string) => {
    let p = found.get(name);
    if (!p) {
      p = Promise.resolve(vscode.workspace.findFiles(`**/${name}.java`, EXCLUDE, 20)).catch(() => []);
      found.set(name, p);
    }
    return p;
  };
  return async (name, from) => {
    const parts = name.split('.').filter((x) => /^[A-Z]/.test(x));
    const last = parts[parts.length - 1];
    if (!last) return undefined;
    const pick = (list: JavaClass[]) => list.find((c) => c.name === last && (parts.length < 2 || c.outer === parts[parts.length - 2])) ?? list.find((c) => c.name === last);
    const own = pick(await classesOf(from.file));
    if (own) return own;
    // 파일 이름은 가장 바깥 타입의 이름. import com.x.AuthDto.RefreshRequest 처럼 안에 든 타입을 바로 가져왔으면 그 바깥 타입(AuthDto)
    let top = parts[0];
    let files = await filesNamed(top);
    if (!files.length && parts.length === 1) {
      const outer = from.imports
        .filter((i) => i.endsWith('.' + last))
        .map((i) => i.split('.').slice(0, -1).filter((x) => /^[A-Z]/.test(x))[0])
        .find(Boolean);
      if (outer) {
        top = outer;
        files = await filesNamed(top);
      }
    }
    if (!files.length) return undefined;
    const imported = from.imports.find((i) => i.endsWith('.' + top) || i.includes('.' + top + '.'));
    const importedTop = imported ? imported.slice(0, imported.indexOf('.' + top) + top.length + 1) : undefined;
    const wanted = (importedTop ?? `${from.pkg}.${top}`).replace(/\./g, path.sep) + '.java';
    const sorted = files.slice().sort((a, b) => Number(b.fsPath.endsWith(wanted)) - Number(a.fsPath.endsWith(wanted)));
    for (const f of sorted.slice(0, 3)) {
      const hit = pick(await classesOf(f.fsPath));
      if (hit) return hit;
    }
    return undefined;
  };
}

/** 프로젝트의 서버 포트 · context-path (잠깐 기억해 둔다) */
const servers = new Map<string, { at: number; server: SpringServer }>();
export function springServerOf(uri: vscode.Uri): SpringServer {
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  if (!root) return {};
  const hit = servers.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.server;
  let server: SpringServer = {};
  try {
    server = findSpringServer(root);
  } catch {
    // 못 읽으면 기본값으로
  }
  servers.set(root, { at: Date.now(), server });
  return server;
}

export interface EndpointRequests {
  /** 넣을 폴더 이름 (Controller 이름) */
  folder: string;
  requests: ApiRequest[];
  /** 환경에 baseUrl 이 없을 때 넣을 값 */
  baseUrl: string;
  /** 읽지 못한 것이 있으면 한 줄 (요청 하나를 열었을 때만) */
  warning: string;
}

/** 매핑 메서드들을 요청으로 */
export async function endpointsToRequests(uri: vscode.Uri, endpoints: Endpoint[]): Promise<EndpointRequests> {
  const server = springServerOf(uri);
  const resolve = makeResolver();
  const requests: ApiRequest[] = [];
  for (const e of endpoints) requests.push(await toRequest(e, { contextPath: server.contextPath, resolve }));
  return { folder: endpoints[0]?.cls.name ?? 'Controller', requests, baseUrl: `http://localhost:${server.port ?? 8080}`, warning: requests.length === 1 ? warningOf(requests[0]) : '' };
}
