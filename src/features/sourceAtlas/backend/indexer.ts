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

/**
 * 파서 결과의 문자열을 색인에 넣기 좋게 바꾼다 (객체는 그대로 두고 문자열만 교체).
 * 1) 정규식·slice 로 잘라 낸 문자열은 V8 안에서 원본 파일 문자열 전체를 붙잡고 있어서(sliced string),
 *    그대로 캐시하면 클래스 이름 하나 때문에 파일 전체가 메모리에 남는다 → 처음 보는 문자열은 새로 복사한다.
 * 2) 'String', 'Long', 'list' 같은 같은 값의 문자열이 수만 번 나오므로 하나만 두고 공유한다 (pool).
 */
function detach<T>(value: T, pool: Map<string, string>): T {
  const intern = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let hit = pool.get(v);
      if (hit === undefined) {
        hit = copyString(v);
        pool.set(hit, hit);
      }
      return hit;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = intern(v[i]);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = intern(o[k]);
    }
    return v;
  };
  return intern(value) as T;
}
/**
 * 원본과 연결이 끊긴 새 문자열 (Buffer 를 거치면 V8 이 새로 만든다).
 * 12자 이하는 V8 이 원래 복사해서 만들므로 그대로 쓴다. 내용이 달라지는 경우(짝 없는 서로게이트)는 원본을 쓴다.
 */
function copyString(s: string): string {
  if (s.length < 13) return s;
  const c = Buffer.from(s, 'utf8').toString('utf8');
  return c === s ? c : s;
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
  const pool = new Map<string, string>(); // 색인을 만드는 동안만 쓰고 버린다
  const mappers: MapperXml[] = [];
  let javaFiles = 0, xmlFiles = 0;
  walk(root, (abs) => {
    try {
      if (fs.statSync(abs).size > MAX_BYTES) return;
      const text = fs.readFileSync(abs, 'utf8');
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (abs.endsWith('.java')) {
        javaFiles++;
        classes.push(...detach(parseJava(text, rel), pool));
      } else if (/<(mapper|sqlMap)\b/.test(text)) {
        const mx = detach(parseMapperXml(text, rel), pool);
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
