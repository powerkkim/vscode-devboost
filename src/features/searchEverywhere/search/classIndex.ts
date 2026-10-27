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
  'export|default|declare|case|implicit|lazy|override';

/**
 * rg 정규식 (Rust 문법). 한 줄에 package 또는 클래스 선언 하나.
 *  $1 = 패키지, $2 = 종류(class·interface·…), $3 = 이름
 * 줄 맨 앞(공백 뒤)에서 시작하는 선언만 본다 → 주석(`* class Foo`)·문자열 안의 단어는 대부분 걸러진다.
 * `enum class`(Kotlin), `@interface`(어노테이션 정의)도 포함.
 */
export const CLASS_DECL_PATTERN =
  `^\\s*package\\s+([\\w.]+)` +
  `|^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*(?:(?:${MODS})\\s+)*(?:enum\\s+(class)|(class|interface|enum|record|@interface|object|trait))\\s+([A-Za-z_$][\\w$]*)`;

/** rg 출력 한 줄의 치환 결과 → 탭으로 구분: 패키지 \t enum-class \t 종류 \t 이름 */
const REPLACE = '$1\t$2\t$3\t$4';

export function buildClassArgs(roots: string[], excludeGlobs: string[]): string[] {
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
  for (const g of CLASS_FILE_GLOBS) args.push('--iglob', g);
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
      pkgOf.set(file, pkg);
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
function runRg(rgPath: string, args: string[], isStale?: () => boolean): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
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

export class ClassIndex {
  private byFile = new Map<string, ClassEntry[]>();
  private all: ClassEntry[] | undefined;
  private building: Promise<void> | undefined;
  private key = '';
  /** 전체 색인을 마쳤는지 */
  ready = false;
  /** 마지막 전체 색인에 걸린 시간 (속도 기록용) */
  lastBuildMs = 0;

  constructor(private readonly rgPath: string) {}

  /**
   * 색인이 준비될 때까지 기다린다. 루트·제외 설정이 바뀌었으면 새로 만든다.
   * 만드는 중에 다시 불려도 rg 는 한 번만 돈다.
   */
  ensure(roots: string[], excludeGlobs: string[]): Promise<void> {
    const key = JSON.stringify([roots, excludeGlobs]);
    if (key !== this.key) {
      this.key = key;
      this.ready = false;
      const started = Date.now();
      const p: Promise<void> = runRg(this.rgPath, buildClassArgs(roots, excludeGlobs)).then((out) => {
        if (this.building !== p) return; // 그사이 설정이 또 바뀜
        this.byFile = parseClassOutput(out ?? '');
        this.all = undefined;
        this.ready = true;
        this.lastBuildMs = Date.now() - started;
      });
      this.building = p;
      p.catch(() => {
        if (this.building === p) this.key = ''; // 실패하면 다음에 다시 시도
      });
    }
    return this.building!;
  }

  /** 파일 하나를 다시 읽어 그 파일의 클래스만 바꾼다 (저장·생성 시) */
  async updateFile(file: string, excludeGlobs: string[]): Promise<void> {
    file = path.normalize(file);
    if (!this.ready) return; // 전체 색인 전이면 어차피 그때 반영된다
    if (!CLASS_FILE_GLOBS.some((g) => file.toLowerCase().endsWith(g.slice(1)))) return;
    const out = await runRg(this.rgPath, buildClassArgs([file], excludeGlobs));
    const entries = parseClassOutput(out ?? '').get(file) ?? [];
    if (entries.length) this.byFile.set(file, entries);
    else this.byFile.delete(file);
    this.all = undefined;
  }

  removeFile(file: string) {
    file = path.normalize(file);
    if (this.byFile.delete(file)) this.all = undefined;
    // 폴더가 지워진 경우: 그 아래 파일들
    const prefix = file.endsWith(path.sep) ? file : file + path.sep;
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

  entries(): ClassEntry[] {
    if (!this.all) {
      this.all = [];
      for (const list of this.byFile.values()) this.all.push(...list);
    }
    return this.all;
  }
}
