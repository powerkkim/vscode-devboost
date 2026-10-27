import { spawn } from 'child_process';
import * as path from 'path';

/**
 * 프로젝트 클래스 색인. 언어 서버 없이 rg 로 클래스 선언 줄만 모아 메모리에 둔다.
 * (vscode 모듈에 의존하지 않아서 단독 테스트가 가능하다)
 *
 * - 처음 한 번 워크스페이스 전체를 rg 로 훑고, 이후에는 바뀐 파일만 다시 읽는다
 * - 클래스 탭은 입력할 때마다 이 목록에서 이름만 맞춰 보므로 언어 서버 준비 여부와 상관없이 바로 나온다
 * - jar 안의 라이브러리 클래스나 메서드·필드는 여기 없다 → 그때는 언어 서버를 쓴다
 */

export type ClassKind = 'class' | 'interface' | 'enum';

export interface ClassEntry {
  name: string;
  kind: ClassKind;
  /** 절대 경로 */
  file: string;
  /** 0부터 시작하는 줄 번호 */
  line: number;
  /** 패키지 (Java·Kotlin). 없으면 '' */
  pkg: string;
}

/** 색인할 파일 */
export const CLASS_FILE_GLOBS = ['*.java', '*.kt', '*.groovy', '*.scala', '*.ts', '*.tsx', '*.mts', '*.js', '*.jsx', '*.mjs'];

/** 선언 앞에 올 수 있는 수식어 (Java·Kotlin·Scala·TS) */
const MODS =
  'public|protected|private|internal|abstract|final|static|sealed|non-sealed|data|open|inner|annotation|value|strictfp|' +
  'export|default|declare|const|case|implicit|lazy|override|fun|expect|actual|inline';

/**
 * rg 정규식 (Rust 문법). 한 줄에 package 또는 클래스 선언 하나.
 *  $1 = 패키지, $2 = Kotlin `enum class` 의 class, $3 = 종류(class·interface·…), $4 = 이름
 * 줄 맨 앞(공백 뒤)에서 시작하는 선언만 본다 → 주석(`* class Foo`)·문자열 안의 단어는 대부분 걸러진다.
 * `enum class`(Kotlin), `@interface`(어노테이션 정의)도 포함.
 */
export const CLASS_DECL_PATTERN =
  `^\\s*package\\s+([\\w.]+)` +
  `|^\\s*(?:@[\\w.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?\\s+)*(?:(?:${MODS})\\s+)*(?:enum\\s+(class)|(class|interface|enum|record|@interface|object|trait))\\s+([A-Za-z_$][\\w$]*)`;

/** rg 출력 한 줄의 치환 결과 → 탭으로 구분: 패키지 \t enum-class \t 종류 \t 이름 */
const REPLACE = '$1\t$2\t$3\t$4';

/**
 * onlyGlobs: 주면 확장자 목록 대신 이 경로들만 읽는다 (저장·생성된 파일 갱신용).
 * 파일을 rg 에 직접 넘기면 .gitignore·숨김 폴더 규칙이 적용되지 않으므로, 루트에서 경로 glob 으로 좁힌다.
 */
export function buildClassArgs(roots: string[], excludeGlobs: string[], onlyGlobs?: string[]): string[] {
  const args = [
    '--no-config',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--null', // 파일 경로 뒤에 \0 (Windows 경로의 ':' 와 구분)
    '--only-matching',
    '--max-filesize',
    '1M',
    '--max-columns',
    '0',
    '-r',
    REPLACE,
  ];
  for (const g of onlyGlobs ?? CLASS_FILE_GLOBS) args.push('--iglob', g);
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  args.push('-e', CLASS_DECL_PATTERN, '--', ...roots);
  return args;
}

function kindOf(word: string): ClassKind {
  if (word === 'interface' || word === '@interface' || word === 'trait') return 'interface';
  if (word === 'enum') return 'enum';
  return 'class'; // class, record, object
}

/**
 * rg 출력을 파일별 클래스 목록으로. rg 는 한 파일의 결과를 이어서 내보내므로
 * 같은 파일 안에서 앞에 나온 package 줄을 그 뒤 선언들의 패키지로 쓴다.
 */
export function parseClassOutput(out: string): Map<string, ClassEntry[]> {
  const byFile = new Map<string, ClassEntry[]>();
  const pkgOf = new Map<string, string>();
  for (const raw of out.split('\n')) {
    const z = raw.indexOf('\0');
    if (z < 0) continue;
    // 키는 path.normalize: 감시자(fsPath)가 주는 경로와 구분자를 맞춘다 (Windows 에서 rg 가 '/' 를 섞어 낼 수 있음)
    const file = path.normalize(raw.slice(0, z));
    const rest = raw.slice(z + 1).replace(/\r$/, '');
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const line = Number(rest.slice(0, colon)) - 1;
    const [pkg, enumClass, word, name] = rest.slice(colon + 1).split('\t');
    if (pkg) {
      if (pkg !== 'object') pkgOf.set(file, pkg); // Scala `package object util` 은 패키지 선언이 아님
      continue;
    }
    if (!name) continue;
    const list = byFile.get(file) ?? [];
    list.push({ name, kind: enumClass ? 'enum' : kindOf(word), file, line, pkg: pkgOf.get(file) ?? '' });
    byFile.set(file, list);
  }
  return byFile;
}

/** rg 를 돌려 출력 전체를 받는다. isStale() 이 true 가 되면 끊고 undefined */
function runRg(rgPath: string, args: string[], isStale?: () => boolean, cwd?: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'], cwd });
    const chunks: string[] = [];
    let done = false;
    const timer = isStale
      ? setInterval(() => {
          if (isStale() && !done) {
            done = true;
            clearInterval(timer);
            child.kill();
            resolve(undefined);
          }
        }, 50)
      : undefined;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => chunks.push(c));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      reject(e);
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      if (timer) clearInterval(timer);
      resolve(chunks.join('')); // 0=찾음, 1=없음, 2=일부 파일 읽기 실패 → 모두 받은 만큼 쓴다
    });
  });
}

/** glob 특수문자를 글자 그대로 맞도록 감싼다 */
function escapeGlob(p: string): string {
  return p.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}

const hasClassExt = (f: string) => CLASS_FILE_GLOBS.some((g) => f.toLowerCase().endsWith(g.slice(1)));

export class ClassIndex {
  private byFile = new Map<string, ClassEntry[]>();
  private all: ClassEntry[] | undefined;
  private building: Promise<void> | undefined;
  private key = '';
  private roots: string[] = [];
  private excludes: string[] = [];
  /** 전체 색인 번호. 갱신 중에 전체 색인이 새로 시작되면 그 갱신 결과는 버린다 */
  private buildId = 0;
  /** 저장·생성으로 다시 읽을 경로 (파일 또는 폴더). BATCH_MS 동안 모아 rg 한 번으로 처리 */
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  /** 전체 색인을 마쳤는지 */
  ready = false;
  /** 마지막 전체 색인에 걸린 시간 (속도 기록용) */
  lastBuildMs = 0;

  static BATCH_MS = 300;
  /** 한 번에 바뀐 경로가 이보다 많으면 (git checkout 등) 전체를 다시 만든다 */
  static MAX_BATCH = 200;

  constructor(private readonly rgPath: string) {}

  /**
   * 색인이 준비될 때까지 기다린다. 루트·제외 설정이 바뀌었으면 새로 만든다.
   * 만드는 중에 다시 불려도 rg 는 한 번만 돈다.
   */
  ensure(roots: string[], excludeGlobs: string[]): Promise<void> {
    const key = JSON.stringify([roots, excludeGlobs]);
    if (key !== this.key) {
      this.key = key;
      this.roots = roots;
      this.excludes = excludeGlobs;
      this.ready = false;
      const id = ++this.buildId;
      const started = Date.now();
      const p: Promise<void> = runRg(this.rgPath, buildClassArgs(roots, excludeGlobs)).then((out) => {
        if (this.buildId !== id) return; // 그사이 설정이 또 바뀜
        this.byFile = parseClassOutput(out ?? '');
        this.all = undefined;
        this.ready = true;
        this.lastBuildMs = Date.now() - started;
        if (this.pending.size) this.schedule(); // 만드는 동안 바뀐 파일
      });
      this.building = p;
      p.catch(() => {
        if (this.buildId === id) this.key = ''; // 실패하면 다음에 다시 시도
      });
    }
    return this.building!;
  }

  /**
   * 파일·폴더가 저장·생성되면 다시 읽도록 예약한다. 폴더(이름 변경·이동)면 그 아래 전체.
   * 짧은 시간에 몰린 변경은 모아서 rg 한 번으로 처리한다.
   */
  queueUpdate(p: string) {
    this.pending.add(path.normalize(p));
    this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ClassIndex.BATCH_MS);
  }

  /** 예약된 갱신을 처리한다 (테스트에서 직접 부를 수 있음). 처리가 겹치지 않게 차례로 */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => undefined);
    if (!this.ready || !this.pending.size) return; // 전체 색인이 끝나면 다시 예약된다
    const p = this.flushPending();
    this.flushing = p;
    try {
      await p;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushPending(): Promise<void> {
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length > ClassIndex.MAX_BATCH) {
      this.key = '';
      await this.ensure(this.roots, this.excludes).catch(() => undefined);
      return;
    }
    // rg 는 경로 glob 을 실행 폴더(cwd) 기준으로 맞추므로 루트별로 cwd 를 루트로 두고 돌린다
    const globsByRoot = new Map<string, string[]>();
    const files: string[] = [];
    const dirs: string[] = [];
    for (const p of paths) {
      const root = this.roots.find((r) => {
        const rel = path.relative(r, p);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!root) continue;
      const rel = escapeGlob(path.relative(root, p).split(path.sep).join('/'));
      const globs = globsByRoot.get(root) ?? [];
      if (hasClassExt(p)) {
        files.push(p);
        globs.push(`/${rel}`);
      } else if (!path.extname(p)) {
        // 확장자가 없으면 폴더로 본다 (이름 변경·이동·복사)
        dirs.push(p);
        for (const g of CLASS_FILE_GLOBS) globs.push(`/${rel}/**/${g}`);
      } else {
        continue;
      }
      globsByRoot.set(root, globs);
    }
    if (!globsByRoot.size) return;
    const id = this.buildId;
    let out = '';
    for (const [root, globs] of globsByRoot) {
      out += (await runRg(this.rgPath, buildClassArgs([root], this.excludes, globs), undefined, root)) ?? '';
      out += '\n';
    }
    if (this.buildId !== id || !this.ready) return; // 그사이 전체 색인이 다시 시작됨
    const found = parseClassOutput(out);
    for (const f of files) this.byFile.delete(f);
    for (const d of dirs) this.dropUnder(d);
    for (const [f, list] of found) this.byFile.set(f, list);
    this.all = undefined;
  }

  removeFile(file: string) {
    file = path.normalize(file);
    if (this.byFile.delete(file)) this.all = undefined;
    // 폴더가 지워진 경우: 그 아래 파일들
    this.dropUnder(file);
  }

  private dropUnder(dir: string) {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const f of [...this.byFile.keys()]) {
      if (f.startsWith(prefix)) {
        this.byFile.delete(f);
        this.all = undefined;
      }
    }
  }

  /** 다음 검색 때 전체를 다시 만든다 (설정 변경 등) */
  reset() {
    this.key = '';
    this.ready = false;
  }

  /** 이 파일의 이 이름 클래스가 색인에 있는가 */
  has(file: string, name: string): boolean {
    return (this.byFile.get(path.normalize(file)) ?? []).some((e) => e.name === name);
  }

  entries(): ClassEntry[] {
    if (!this.all) {
      this.all = [];
      for (const list of this.byFile.values()) this.all.push(...list);
    }
    return this.all;
  }
}
