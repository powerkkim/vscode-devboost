import * as fs from 'fs';
import * as path from 'path';
import { parseJava, JavaClass } from './javaParser';
import { parseMapperXml, MapperXml, SqlStatement } from './mybatisParser';

export interface BackendIndex {
  classes: JavaClass[];
  bySimple: Map<string, JavaClass[]>;
  byFqcn: Map<string, JavaClass>;
  /** 인터페이스 단순 이름 → 그것을 구현한 클래스들 */
  implementors: Map<string, JavaClass[]>;
  statements: Map<string, SqlStatement>; // "namespace.id"
  mapperNamespaces: Set<string>;
  stats: { javaFiles: number; xmlFiles: number; controllers: number; statements: number };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', 'dist', '.gradle', '.idea', '.vscode', 'bin', '.next', 'test', 'tests']);
const MAX_FILES = 20000;
const MAX_BYTES = 1_000_000;

function walk(root: string, visit: (abs: string) => void) {
  let count = 0;
  const stack = [root];
  while (stack.length && count < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        // src/test 만 건너뛰고, 'test' 라는 이름의 다른 위치는 허용하기 위해 부모를 확인
        if (SKIP_DIRS.has(e.name) && !(e.name === 'test' || e.name === 'tests') ) continue;
        if ((e.name === 'test' || e.name === 'tests') && path.basename(dir) === 'src') continue;
        stack.push(path.join(dir, e.name));
      } else if (e.name.endsWith('.java') || e.name.endsWith('.xml')) {
        count++;
        visit(path.join(dir, e.name));
      }
    }
  }
}

const cache = new Map<string, BackendIndex>();
export function clearBackendCache() {
  cache.clear();
}

export function buildBackendIndex(workspaceRoot: string, useCache = true): BackendIndex {
  const root = path.resolve(workspaceRoot);
  const hit = useCache ? cache.get(root) : undefined;
  if (hit) return hit;

  const classes: JavaClass[] = [];
  const mappers: MapperXml[] = [];
  let javaFiles = 0, xmlFiles = 0;
  walk(root, (abs) => {
    try {
      if (fs.statSync(abs).size > MAX_BYTES) return;
      const text = fs.readFileSync(abs, 'utf8');
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (abs.endsWith('.java')) {
        javaFiles++;
        classes.push(...parseJava(text, rel));
      } else if (/<(mapper|sqlMap)\b/.test(text)) {
        const mx = parseMapperXml(text, rel);
        if (mx) {
          xmlFiles++;
          mappers.push(mx);
        }
      }
    } catch {
      /* 읽기/파싱 실패 파일은 건너뜀 */
    }
  });

  const bySimple = new Map<string, JavaClass[]>();
  const byFqcn = new Map<string, JavaClass>();
  const implementors = new Map<string, JavaClass[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const c of classes) {
    push(bySimple, c.name, c);
    byFqcn.set(c.fqcn, c);
    for (const i of [...c.implements, ...(c.kind === 'interface' ? [] : c.extends)]) push(implementors, i, c);
  }
  const statements = new Map<string, SqlStatement>();
  const mapperNamespaces = new Set<string>();
  for (const mx of mappers) {
    mapperNamespaces.add(mx.namespace);
    mx.statements.forEach((s) => statements.set(`${s.namespace}.${s.id}`, s));
  }
  const index: BackendIndex = {
    classes, bySimple, byFqcn, implementors, statements, mapperNamespaces,
    stats: {
      javaFiles, xmlFiles, statements: statements.size,
      controllers: classes.filter((c) => c.annotations.some((a) => a.name === 'RestController' || a.name === 'Controller')).length,
    },
  };
  cache.set(root, index);
  return index;
}
