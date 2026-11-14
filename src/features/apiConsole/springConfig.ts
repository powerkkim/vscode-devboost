import * as fs from 'fs';
import * as path from 'path';

/** application.yml / application.properties 에서 읽은 서버 포트와 context-path */
export interface SpringServer {
  port?: number;
  contextPath?: string;
}

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', 'test', '.gradle', '.idea']);

function valueOf(raw: string): string {
  // ${SERVER_PORT:8080} → 8080
  const v = raw.replace(/['"]/g, '').trim();
  const m = v.match(/^\$\{[^:}]+:([^}]*)\}$/);
  return m ? m[1] : v;
}

function read(text: string, isYaml: boolean): SpringServer {
  const out: SpringServer = {};
  if (isYaml) {
    const server = text.match(/^server:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m)?.[1] ?? '';
    const port = server.match(/^[ \t]+port:[ \t]*(\S+)/m)?.[1];
    const ctx = server.match(/^[ \t]+servlet:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+context-path:[ \t]*(\S+)/m)?.[1];
    if (port && /^\d+$/.test(valueOf(port))) out.port = Number(valueOf(port));
    if (ctx) out.contextPath = valueOf(ctx);
  } else {
    const port = text.match(/^\s*server\.port\s*[=:]\s*(\S+)/m)?.[1];
    const ctx = text.match(/^\s*server\.servlet\.context-path\s*[=:]\s*(\S+)/m)?.[1];
    if (port && /^\d+$/.test(valueOf(port))) out.port = Number(valueOf(port));
    if (ctx) out.contextPath = valueOf(ctx);
  }
  if (out.contextPath && (out.contextPath === '/' || !out.contextPath.startsWith('/'))) delete out.contextPath;
  return out;
}

/**
 * 프로젝트의 resources/application*.yml · properties 를 찾아 읽는다.
 * 기본 파일(application.yml)이 먼저, 그다음 local · dev 프로필, 나머지 순서.
 */
export function findSpringServer(workspaceRoot: string): SpringServer {
  const files: string[] = [];
  const stack = [workspaceRoot];
  let count = 0;
  while (stack.length && count < 4000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      count++;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(abs);
      } else if (/^application(-[\w.]+)?\.(ya?ml|properties)$/.test(e.name) && abs.includes(`${path.sep}resources${path.sep}`)) files.push(abs);
    }
  }
  const rank = (f: string) => {
    const profile = path.basename(f).match(/^application(?:-([\w.]+))?\./)?.[1];
    return !profile ? 0 : profile === 'local' ? 1 : profile === 'dev' ? 2 : 3;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  const out: SpringServer = {};
  for (const f of files) {
    if (out.port !== undefined && out.contextPath !== undefined) break;
    try {
      const got = read(fs.readFileSync(f, 'utf8'), !f.endsWith('.properties'));
      out.port ??= got.port;
      out.contextPath ??= got.contextPath;
    } catch {
      // 읽을 수 없는 파일은 건너뛴다
    }
  }
  return out;
}

export const readSpringServer = read;
