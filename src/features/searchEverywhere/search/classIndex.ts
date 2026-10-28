import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { rgCwd } from './ripgrep';

/**
 * 프로젝트 심볼 색인. 언어 서버 없이 rg 로 선언 줄만 모아 메모리에 둔다.
 * (vscode 모듈에 의존하지 않아서 단독 테스트가 가능하다)
 *
 * - 클래스·인터페이스·enum (Java·Kotlin·Groovy·Scala·TS·JS)
 * - 메서드·필드 (Java), fun (Kotlin) — Java 언어 서버는 기본 설정에서 워크스페이스 심볼로 타입만 주므로 직접 모은다
 * - 처음 한 번 워크스페이스 전체를 rg 로 훑고, 이후에는 바뀐 파일만 다시 읽는다
 * - jar 안의 라이브러리 클래스는 없다 (소스가 프로젝트에 없음)
 */

export type ClassKind = 'class' | 'interface' | 'enum';
export type MemberKind = 'method' | 'field';

export interface ClassEntry {
  name: string;
  kind: ClassKind | MemberKind;
  /** 메서드·필드가 들어 있는 클래스 (그 줄보다 앞에 나온 마지막 클래스 선언) */
  container?: string;
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

/** 어노테이션 하나 (인자 안의 괄호 한 단계까지) */
const ANN1 = `@[\\w.]+(?:\\((?:[^()]|\\([^()]*\\))*\\))?\\s+`;
const ANN = `(?:${ANN1})*`;
/** 수식어와 어노테이션이 섞여도 됨: `public @Nullable String foo(`, `private @Autowired Foo foo;` */
const MODS_ANN = (mods: string) => `(?:(?:${mods})\\s+|${ANN1})*`;
/** Java 타입: 이름 + 제네릭(세 단계까지) + 배열·가변 인자 */
const JTYPE = `([\\w.$]+(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?(?:\\[\\])*(?:\\.\\.\\.)?)`;

/**
 * 메서드·필드 정규식 (Java, Kotlin fun). 클래스 선언 정규식 뒤에 이어 붙인다.
 *  $5 = Kotlin fun 이름, $6·$7 = Java 메서드 반환 타입·이름, $8·$9 = Java 필드 타입·이름
 * - 메서드: [어노테이션][수식어][<T>] 타입 이름( — 이름은 소문자로 시작 (생성자 제외)
 *   `return foo(`, `else if (` 처럼 문장이 걸리는 경우는 타입 자리 단어로 걸러낸다 (parseClassOutput)
 * - 필드: public·protected·private·static 중 하나가 있어야 함 (메서드 안 지역 변수와 구분). 수식어 없는 필드는 놓친다
 * Spring Boot 소스 기준: Java 파서가 찾은 메서드·필드의 99.5% 를 찾음, 무작위 표본에서 잘못 잡힌 줄 없음
 */
export const MEMBER_DECL_PATTERN =
  `|^\\s*${ANN}(?:(?:public|protected|private|internal|open|override|abstract|final|suspend|inline|operator|infix|tailrec|external|actual|expect)\\s+)*fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?([A-Za-z_]\\w*)\\s*\\(` +
  `|^\\s*${MODS_ANN('public|protected|private|static|final|abstract|synchronized|native|default|strictfp')}(?:<(?:[^<>]|<[^<>]*>)*>\\s+)?${MODS_ANN('final')}${JTYPE}\\s+([a-z_$][\\w$]*)\\s*\\(` +
  `|^\\s*${MODS_ANN('final|transient|volatile')}(?:public|protected|private|static)\\s+${MODS_ANN('public|protected|private|static|final|transient|volatile')}${JTYPE}\\s+([A-Za-z_$][\\w$]*)\\s*(?:=|;)`;

/** 메서드 정규식의 "타입" 자리에 오면 선언이 아니라 문장인 단어 */
const NOT_A_TYPE = new Set(['return', 'else', 'new', 'throw', 'case', 'yield', 'await', 'assert', 'do', 'try', 'if', 'for', 'while', 'switch', 'catch', 'synchronized', 'this', 'super', 'package', 'import', 'goto', 'instanceof']);

/** rg 출력 한 줄의 치환 결과 → 탭으로 구분: 패키지, enum-class, 종류, 클래스 이름, Kotlin fun, 메서드 타입·이름, 필드 타입·이름 */
const REPLACE = '$1\t$2\t$3\t$4\t$5\t$6\t$7\t$8\t$9';

/**
 * onlyGlobs: 주면 확장자 목록 대신 이 경로들만 읽는다 (저장·생성된 파일 갱신용).
 * 파일을 rg 에 직접 넘기면 .gitignore·숨김 폴더 규칙이 적용되지 않으므로, 루트에서 경로 glob 으로 좁힌다.
 */
/** 메서드·필드를 모으는 파일 (두 번째 단계) */
export const MEMBER_FILE_GLOBS = ['*.java', '*.kt'];

/**
 * mode: 'classes' = 클래스 선언만 (모든 대상 확장자, 빠름) / 'all' = 클래스 + 메서드·필드
 * (기본 대상은 Java·Kotlin. onlyGlobs 를 주면 그 경로들)
 */
export function buildClassArgs(roots: string[], excludeGlobs: string[], onlyGlobs?: string[], mode: 'classes' | 'all' = 'all'): string[] {
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
  for (const g of onlyGlobs ?? (mode === 'classes' ? CLASS_FILE_GLOBS : MEMBER_FILE_GLOBS)) args.push('--iglob', g);
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  args.push('-e', mode === 'classes' ? CLASS_DECL_PATTERN : CLASS_DECL_PATTERN + MEMBER_DECL_PATTERN, '--', ...roots);
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
/**
 * 문자열을 원본(rg 출력 전체)과 떼어 내고 같은 값은 하나로 공유한다.
 * split·slice 로 잘라 낸 문자열은 V8 안에서 원본 문자열 전체를 붙잡고 있어서, 그대로 두면 rg 출력(수십 MB)이 메모리에 남는다.
 */
function makeInterner() {
  const pool = new Map<string, string>();
  return (v: string): string => {
    let hit = pool.get(v);
    if (hit === undefined) {
      hit = v.length < 13 ? v : Buffer.from(v, 'utf8').toString('utf8'); // 12자 이하는 V8 이 원래 복사해서 만듦
      if (hit !== v) hit = v; // 내용이 달라지는 경우(짝 없는 서로게이트)는 원본
      pool.set(hit, hit);
    }
    return hit;
  };
}

export function parseClassOutput(out: string): Map<string, ClassEntry[]> {
  const byFile = new Map<string, ClassEntry[]>();
  const intern = makeInterner();
  const pkgOf = new Map<string, string>();
  const classOf = new Map<string, string>(); // 파일별 마지막으로 나온 클래스 (메서드·필드의 소속)
  let lastRaw = '';
  let file = '';
  for (const raw of out.split('\n')) {
    const z = raw.indexOf('\0');
    if (z < 0) continue;
    // 키는 path.normalize: 감시자(fsPath)가 주는 경로와 구분자를 맞춘다 (Windows 에서 rg 가 '/' 를 섞어 낼 수 있음).
    // 한 파일의 줄은 이어서 나오므로 경로 문자열은 파일마다 하나만 만든다 (메서드가 수십만 개일 때 메모리)
    const rawFile = raw.slice(0, z);
    if (rawFile !== lastRaw) {
      lastRaw = rawFile;
      file = intern(path.normalize(rawFile));
    }
    const rest = raw.slice(z + 1).replace(/\r$/, '');
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const line = Number(rest.slice(0, colon)) - 1;
    const [pkg, enumClass, word, name, kfun, mtype, mname, , fname] = rest.slice(colon + 1).split('\t');
    if (pkg) {
      if (pkg !== 'object') pkgOf.set(file, intern(pkg)); // Scala `package object util` 은 패키지 선언이 아님
      continue;
    }
    let entry: ClassEntry | undefined;
    if (name) {
      const n = intern(name);
      classOf.set(file, n);
      entry = { name: n, kind: enumClass ? 'enum' : kindOf(word), file, line, pkg: pkgOf.get(file) ?? '' };
    } else {
      const ext = path.extname(file).toLowerCase();
      // 메서드·필드는 Java(·Kotlin fun) 만. 다른 언어의 메서드는 색인하지 않는다
      const member: [string, MemberKind] | undefined =
        kfun && ext === '.kt' ? [kfun, 'method']
        : mname && ext === '.java' && !NOT_A_TYPE.has(mtype) ? [mname, 'method']
        : fname && ext === '.java' ? [fname, 'field']
        : undefined;
      if (member) {
        entry = { name: intern(member[0]), kind: member[1], container: classOf.get(file), file, line, pkg: pkgOf.get(file) ?? '' };
      }
    }
    if (!entry) continue;
    const list = byFile.get(file) ?? [];
    list.push(entry);
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
  private classList: ClassEntry[] | undefined;
  private memberList: ClassEntry[] | undefined;
  private building: Promise<void> | undefined;
  /** 메서드·필드(두 번째 단계)를 다 모았는지 */
  membersReady = false;
  /** 두 번째 단계가 도는 동안 따로 갱신된 파일 (두 번째 단계 결과로 덮어쓰지 않게) */
  private touchedDuringMembers = new Set<string>();
  /** 지운 파일·폴더 → 지운 시각. 그 전에 시작한 rg 결과가 지운 파일을 되살리지 않게 */
  private deleted = new Map<string, number>();
  /** 메서드·필드 단계가 끝나면(성공·실패 모두) 풀리는 Promise */
  private membersDone: Promise<void> = Promise.resolve();
  private resolveMembers: (() => void) | undefined;
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
  /** 메서드·필드 단계에 걸린 시간 */
  lastMembersMs = 0;
  /** 기록용 (출력 패널) */
  onLog: ((msg: string) => void) | undefined;

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
      this.membersReady = false;
      this.resolveMembers?.();
      this.membersDone = new Promise<void>((r) => (this.resolveMembers = r));
      const id = ++this.buildId;
      const started = Date.now();
      // 1단계: 클래스 선언만 (빠름) → 클래스 검색은 이것으로 바로 시작
      const p: Promise<void> = runRg(this.rgPath, buildClassArgs(roots, excludeGlobs, undefined, 'classes'), undefined, rgCwd(roots)).then((out) => {
        if (this.buildId !== id) return; // 그사이 설정이 또 바뀜
        this.byFile = parseClassOutput(out ?? '');
        for (const f of [...this.byFile.keys()]) if (this.deletedSince(f, started)) this.byFile.delete(f);
        this.all = undefined;
        this.ready = true;
        this.lastBuildMs = Date.now() - started;
        this.onLog?.(`[색인] 클래스 ${this.byFile.size}개 파일 ${this.lastBuildMs}ms → 메서드·필드 이어서`);
        if (this.pending.size) this.schedule(); // 만드는 동안 바뀐 파일
        this.buildMembers(id);
      });
      this.building = p;
      p.catch(() => {
        if (this.buildId === id) {
          this.key = ''; // 실패하면 다음에 다시 시도
          this.resolveMembers?.();
        }
      });
    }
    return this.building!;
  }

  /** 메서드·필드 단계가 끝날 때 (이미 끝났으면 바로) */
  whenMembersDone(): Promise<void> {
    return this.membersDone;
  }

  /** f(또는 그 위 폴더)가 time 이후에 지워졌는가 */
  private deletedSince(f: string, time: number): boolean {
    if (!this.deleted.size) return false;
    for (let p = f; ; ) {
      const t = this.deleted.get(p);
      if (t !== undefined && t >= time) return true;
      const parent = path.dirname(p);
      if (parent === p) return false;
      p = parent;
    }
  }

  /** 2단계: Java·Kotlin 메서드·필드. 끝나면 그 파일들의 항목을 (클래스 포함) 통째로 바꾼다 */
  private buildMembers(id: number) {
    this.touchedDuringMembers.clear();
    const started = Date.now();
    runRg(this.rgPath, buildClassArgs(this.roots, this.excludes, undefined, 'all'), undefined, rgCwd(this.roots))
      .then((out) => {
        if (this.buildId !== id) return;
        for (const [f, list] of parseClassOutput(out ?? '')) {
          if (!this.touchedDuringMembers.has(f) && !this.deletedSince(f, started)) this.byFile.set(f, list);
        }
        this.all = undefined;
        this.membersReady = true;
        this.lastMembersMs = Date.now() - started;
        this.onLog?.(`[색인] 메서드·필드 포함 ${this.entries().length}개 ${this.lastMembersMs}ms`);
      })
      .catch((e) => this.onLog?.(`[경고] 메서드·필드 색인 실패 (클래스만으로 계속): ${e}`)) // 실패하면 클래스만으로 계속 (다음 전체 색인 때 다시)
      .finally(() => {
        if (this.buildId === id) this.resolveMembers?.();
      });
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
    const started = Date.now();
    if (paths.length > ClassIndex.MAX_BATCH) {
      this.onLog?.(`[색인] 바뀐 경로 ${paths.length}개 → 전체 다시 만듦`);
      this.key = '';
      await this.ensure(this.roots, this.excludes).catch(() => undefined);
      return;
    }
    // rg 는 경로 glob 을 실행 폴더(cwd) 기준으로 맞추므로 루트별로 cwd 를 루트로 두고 돌린다
    const globsByRoot = new Map<string, string[]>();
    const files: string[] = [];
    const dirs: string[] = [];
    // 이미 색인에 있는 파일(저장)은 .gitignore·제외 판정이 끝난 파일이므로 rg 에 직접 넘긴다 (트리를 훑지 않음)
    const known: string[] = [];
    for (const p of paths) {
      if (this.byFile.has(p)) {
        known.push(p);
        continue;
      }
      // 폴더인지는 실제로 확인 (이름에 점이 있는 폴더 v1.2, 확장자 없는 파일 Dockerfile 구분)
      const st = await fs.promises.stat(p).catch(() => undefined);
      if (!st) continue; // 그사이 지워짐 (삭제 이벤트가 따로 처리)
      const isDir = st.isDirectory();
      if (!isDir && !hasClassExt(p)) continue;
      const root = this.roots.find((r) => {
        const rel = path.relative(r, p);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!root) continue;
      const rel = escapeGlob(path.relative(root, p).split(path.sep).join('/'));
      const globs = globsByRoot.get(root) ?? [];
      if (isDir) {
        // 폴더 생성·이름 변경·이동·복사: 그 아래 전체
        dirs.push(p);
        for (const g of CLASS_FILE_GLOBS) globs.push(`/${rel}/**/${g}`);
      } else {
        files.push(p);
        globs.push(`/${rel}`);
      }
      globsByRoot.set(root, globs);
    }
    if (!globsByRoot.size && !known.length) return;
    const id = this.buildId;
    let out = '';
    if (known.length) {
      // 경로를 직접 넘기면 glob 필터가 적용되지 않으므로 onlyGlobs 없이 (확장자는 이미 맞는 파일들)
      const args = buildClassArgs(known, [], ['*'], 'all');
      out += ((await runRg(this.rgPath, args)) ?? '') + '\n';
    }
    for (const [root, globs] of globsByRoot) {
      out += (await runRg(this.rgPath, buildClassArgs([root], this.excludes, globs, 'all'), undefined, root)) ?? '';
      out += '\n';
    }
    if (this.buildId !== id || !this.ready) return; // 그사이 전체 색인이 다시 시작됨
    const found = parseClassOutput(out);
    for (const f of [...files, ...known]) {
      this.byFile.delete(f);
      this.touchedDuringMembers.add(f);
    }
    for (const d of dirs) this.dropUnder(d);
    for (const [f, list] of found) {
      if (this.deletedSince(f, started)) continue; // rg 가 읽은 뒤에 지워진 파일
      this.byFile.set(f, list);
      this.touchedDuringMembers.add(f);
    }
    this.all = undefined;
    this.onLog?.(`[색인] 갱신 ${paths.map((p) => path.basename(p)).join(', ')} ${Date.now() - started}ms`);
  }

  removeFile(file: string) {
    file = path.normalize(file);
    const now = Date.now();
    this.deleted.set(file, now);
    // 오래된 기록은 정리 (진행 중인 rg 보다 오래된 것만 의미 있음)
    if (this.deleted.size > 1000) for (const [k, t] of this.deleted) if (now - t > 10 * 60 * 1000) this.deleted.delete(k);
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

  /** 이 파일의 이 이름 심볼(클래스·메서드·필드)이 색인에 있는가 */
  hasSymbol(file: string, name: string): boolean {
    return (this.byFile.get(path.normalize(file)) ?? []).some((e) => e.name === name);
  }

  /** 클래스·메서드·필드 전부 */
  entries(): ClassEntry[] {
    if (!this.all) {
      this.all = [];
      this.classList = [];
      this.memberList = [];
      for (const list of this.byFile.values()) {
        for (const e of list) {
          this.all.push(e);
          if (e.kind === 'method' || e.kind === 'field') this.memberList.push(e);
          else this.classList.push(e);
        }
      }
    }
    return this.all;
  }

  /** 메서드·필드만 */
  members(): ClassEntry[] {
    this.entries();
    return this.memberList!;
  }

  /** 클래스·인터페이스·enum 만 */
  classes(): ClassEntry[] {
    this.entries();
    return this.classList!;
  }
}
