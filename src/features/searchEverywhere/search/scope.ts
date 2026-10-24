/**
 * 검색 범위(IntelliJ 오른쪽 드롭다운)와 텍스트 옵션 정의. vscode 모듈 의존 없음 → 단독 테스트 가능.
 */

export type ScopeId =
  | 'project' // 프로젝트 파일 (라이브러리·vendor 제외)
  | 'projectAndLibs' // 프로젝트 및 라이브러리 (.m2, JDK, vendor 포함)
  | 'production' // 프로젝트 프로덕션 파일 (테스트 제외)
  | 'test' // 프로젝트 테스트 파일
  | 'recentViewed' // 최근에 본 파일
  | 'recentChanged'; // 최근 변경된 파일 (Git 작업 트리 기준)

export const SCOPES: { id: ScopeId; label: string }[] = [
  { id: 'project', label: '프로젝트 파일' },
  { id: 'projectAndLibs', label: '프로젝트 및 라이브러리' },
  { id: 'production', label: '프로젝트 프로덕션 파일' },
  { id: 'test', label: '프로젝트 테스트 파일' },
  { id: 'recentViewed', label: '최근에 본 파일' },
  { id: 'recentChanged', label: '최근 변경된 파일' },
];

export interface TextOptions {
  /** 파일 타입 마스크. 예: "*.java", "*.java, *.xml". 비어 있으면 전체 */
  fileMask: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** 포함/제외 경로 (Ctrl+Shift+F의 files to include / files to exclude 와 같은 형식, 쉼표로 여러 개) */
export interface PathFilter {
  include: string;
  exclude: string;
}

export interface SearchOptions {
  scope: ScopeId;
  text: TextOptions;
  paths: PathFilter;
}

export const DEFAULT_OPTIONS: SearchOptions = {
  scope: 'project',
  text: { fileMask: '', caseSensitive: false, wholeWord: false, regex: false },
  paths: { include: '', exclude: '' },
};

const GLOB_CHARS = /[*?{}[\]]/;

/** "a, b/{x,y}, c" → ["a", "b/{x,y}", "c"] (중괄호 안의 쉼표는 나누지 않음) */
export function splitPathList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value ?? '') {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 경로 항목 정규화: 역슬래시→슬래시, 앞의 ./ 또는 / 제거, 끝의 / 제거 */
export function normalizePathEntry(entry: string): { path: string; rooted: boolean; glob: boolean } {
  let p = entry.trim().replace(/\\/g, '/');
  let rooted = false;
  if (p.startsWith('./')) {
    p = p.slice(2);
    rooted = true;
  } else if (p.startsWith('/')) {
    p = p.slice(1);
    rooted = true;
  }
  p = p.replace(/\/+$/, '');
  return { path: p, rooted, glob: GLOB_CHARS.test(p) };
}

/**
 * 경로 항목 하나 → glob 목록. Ctrl+Shift+F와 같은 규칙:
 *  - "src/main/java/com/demo"  → 어느 깊이든 그 폴더(또는 파일)와 그 아래 전부
 *  - "./src"                   → 워크스페이스 바로 아래 src 만
 *  - "*Test.java", "dto/**"    → 앞에 **\/ 를 붙여 어느 깊이든
 */
export function pathEntryToGlobs(entry: string): string[] {
  const { path, rooted, glob } = normalizePathEntry(entry);
  if (!path) return [];
  if (glob) {
    return [rooted || path.startsWith('**') ? path : `**/${path}`];
  }
  const base = rooted ? path : `**/${path}`;
  return [base, `${base}/**`];
}

export function pathListToGlobs(value: string): string[] {
  return splitPathList(value).flatMap(pathEntryToGlobs);
}

export function hasPathFilter(p: PathFilter | undefined): boolean {
  return !!p && (p.include.trim() !== '' || p.exclude.trim() !== '');
}

export function isScopeId(v: unknown): v is ScopeId {
  return typeof v === 'string' && SCOPES.some((s) => s.id === v);
}

/** 테스트 파일 판정: Maven/Gradle(src/test), JS(__tests__, *.spec.*, *.test.*), *Test.java / *Tests.java */
export function isTestPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  if (/(^|\/)src\/(test|integrationTest|testFixtures)\//.test(p)) return true;
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(p)) return true;
  if (/\.(spec|test)\.[^/]+$/.test(p)) return true;
  if (/(Test|Tests|IT|Spec)\.(java|kt|groovy|scala)$/.test(p)) return true;
  return false;
}

/** "*.java, *.xml" → ["**\/*.java", "**\/*.xml"] (rg -g 와 GlobMatcher 공용) */
export function fileMaskToGlobs(mask: string): string[] {
  return mask
    .split(/[,;\s]+/)
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => {
      if (m.includes('/') || m.includes('\\')) return m; // 경로가 포함되면 그대로
      if (!m.includes('*') && !m.includes('.')) return `**/*.${m}`; // "java" → **/*.java
      if (!m.includes('*')) return `**/${m}`; // "pom.xml" → **/pom.xml
      return `**/${m}`; // "*.java" → **/*.java
    });
}

/** 범위 판단에 필요한 파일 정보 (uri 대신 순수 값으로 받아 테스트 가능하게) */
export interface FileFacts {
  relPath: string;
  inProject: boolean;
  isLibrary: boolean;
  recentlyViewed: boolean;
  recentlyChanged: boolean;
}

export function scopeAccepts(scope: ScopeId, f: FileFacts): boolean {
  switch (scope) {
    case 'projectAndLibs':
      return true;
    case 'project':
      return f.inProject && !f.isLibrary;
    case 'production':
      return f.inProject && !f.isLibrary && !isTestPath(f.relPath);
    case 'test':
      return f.inProject && !f.isLibrary && isTestPath(f.relPath);
    case 'recentViewed':
      return f.recentlyViewed;
    case 'recentChanged':
      return f.recentlyChanged;
  }
}

/** 테스트 경로를 rg에서 제외/포함하기 위한 glob 목록 */
export const TEST_GLOBS = [
  '**/src/test/**',
  '**/src/integrationTest/**',
  '**/src/testFixtures/**',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/spec/**',
  '**/*.spec.*',
  '**/*.test.*',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*IT.java',
  '**/*Test.kt',
  '**/*Spec.groovy',
];

/** 정규식이 아닌 검색어를 정규식으로 쓸 때 이스케이프 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 예비(파일 직접 읽기) 검색에서 쓸 정규식. 잘못된 정규식이면 null */
export function buildTextRegExp(query: string, o: TextOptions): RegExp | null {
  let src = o.regex ? query : escapeRegExp(query);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, o.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}
