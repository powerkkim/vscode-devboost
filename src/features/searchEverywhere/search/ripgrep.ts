import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ripgrep(rg) 실행 모듈. vscode 모듈에 의존하지 않아서 단독 테스트가 가능하다.
 * VS Code 기본 검색(Ctrl+Shift+F)도 rg를 쓰며, VS Code 설치 폴더 안에 rg가 들어 있다.
 */

export interface RgOptions {
  /** 검색어 */
  query: string;
  /** 검색할 루트 폴더들 (워크스페이스 폴더) */
  roots: string[];
  /** 제외할 glob (rg -g '!<glob>') */
  excludeGlobs?: string[];
  /** 포함할 glob만 (파일 타입 필터용, 예: '*.java') */
  includeGlobs?: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** 수집할 최대 매치 수 (넘으면 rg 프로세스를 종료) */
  limit: number;
  /** true를 돌려주면 즉시 중단 (더 새 검색이 시작됨) */
  isStale?: () => boolean;
}

export interface RgMatch {
  /** 절대 경로 */
  file: string;
  /** 0부터 시작하는 줄 번호 */
  line: number;
  /** 0부터 시작하는 문자(UTF-16) 위치 */
  column: number;
  /** 매치 길이 (문자 단위) */
  length: number;
  /** 줄 내용 (줄바꿈 제거) */
  text: string;
}

/**
 * VS Code 설치 폴더(appRoot)에서 rg 실행 파일을 찾는다. 못 찾으면 undefined.
 * VS Code 버전에 따라 위치가 다르다:
 *  - 예전: node_modules(.asar.unpacked)/@vscode/ripgrep/bin/rg(.exe)
 *  - 2026년 버전: node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/<OS>-<CPU>/rg(.exe)
 * 정해진 경로에 없으면 @vscode 아래 이름에 ripgrep 이 들어간 패키지의 bin 을 훑는다 (위치가 또 바뀌어도 찾게)
 */
export function findRipgrep(appRoot: string): string | undefined {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const plat = `${process.platform}-${process.arch}`;
  const bases = ['node_modules.asar.unpacked', 'node_modules'];
  const candidates: string[][] = [];
  for (const b of bases) {
    candidates.push(
      [b, '@vscode', 'ripgrep', 'bin', exe],
      [b, '@vscode', 'ripgrep-universal', 'bin', plat, exe],
      [b, '@vscode', 'ripgrep-universal', 'bin', exe],
      [b, 'vscode-ripgrep', 'bin', exe]
    );
  }
  for (const parts of candidates) {
    const p = path.join(appRoot, ...parts);
    if (isFile(p)) return p;
  }
  // 정해진 경로에 없으면: @vscode/*ripgrep*/bin 아래 (현재 OS·CPU 폴더 우선)
  for (const b of bases) {
    const scope = path.join(appRoot, b, '@vscode');
    for (const pkg of readDir(scope).filter((n) => n.includes('ripgrep'))) {
      const bin = path.join(scope, pkg, 'bin');
      const subs = readDir(bin).sort((x, y) => Number(y === plat) - Number(x === plat));
      for (const sub of subs) {
        const p = path.join(bin, sub, exe);
        if (isFile(p)) return p;
      }
    }
  }
  return undefined;
}

/** 시스템 PATH 에서 rg 를 찾는다 (VS Code 안에서 못 찾았을 때) */
export function findRipgrepOnPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir.replace(/^"|"$/g, ''), exe);
    if (isFile(p)) return p;
  }
  return undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 한 파일에서 가져오는 최대 매치 수 */
export const RG_MAX_PER_FILE = 20;

/** rg 명령 인자 구성 (테스트에서 확인할 수 있도록 분리) */
export function buildArgs(o: RgOptions): string[] {
  const args = [
    '--json',
    '--no-config', // 사용자 ~/.ripgreprc 영향 제거
    '--max-filesize',
    '1M',
    '--max-columns',
    '400',
    '--max-count',
    String(RG_MAX_PER_FILE), // 한 파일에서 너무 많이 나오지 않게
  ];
  args.push(o.caseSensitive ? '--case-sensitive' : '--ignore-case');
  if (!o.regex) {
    args.push('--fixed-strings');
  }
  if (o.wholeWord) {
    args.push('--word-regexp');
  }
  // 파일 패턴은 대소문자 무시(--iglob): "*mapper*.xml"이 OrderMapper.xml에도 맞도록. Windows 파일명과도 일치
  for (const g of o.includeGlobs ?? []) {
    args.push('--iglob', g);
  }
  for (const g of o.excludeGlobs ?? []) {
    args.push('--iglob', `!${g}`);
  }
  args.push('-e', o.query, '--');
  args.push(...o.roots);
  return args;
}

/** rg --json 한 줄을 파싱. match 이벤트가 아니면 [] */
export function parseJsonLine(line: string): RgMatch[] {
  if (!line.startsWith('{')) {
    return [];
  }
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (msg.type !== 'match') {
    return [];
  }
  const d = msg.data;
  const file: string | undefined = d.path?.text;
  const raw: string | undefined = d.lines?.text;
  if (!file || raw === undefined) {
    return [];
  }
  const text = raw.replace(/\r?\n$/, '');
  const first = d.submatches?.[0];
  // rg는 바이트 오프셋을 주므로 UTF-8 → 문자 위치로 변환 (한글 등)
  const buf = Buffer.from(raw, 'utf8');
  const column = first ? buf.subarray(0, first.start).toString('utf8').length : 0;
  const length = first ? buf.subarray(first.start, first.end).toString('utf8').length : 0;
  return [{ file, line: d.line_number - 1, column, length, text }];
}

/** 새 검색이 시작됐는지 확인하는 간격 */
const STALE_CHECK_MS = 25;

/** rg 실행. limit 개 모이거나 isStale()이면 프로세스를 끊고 그때까지 결과를 돌려준다 */
export function runRipgrep(rgPath: string, o: RgOptions): Promise<RgMatch[]> {
  return new Promise((resolve, reject) => {
    const results: RgMatch[] = [];
    const child = spawn(rgPath, buildArgs(o), { stdio: ['ignore', 'pipe', 'pipe'], cwd: rgCwd(o.roots) });
    let buffer = '';
    let done = false;
    let stderr = '';
    // 새 검색이 시작됐는지 주기적으로 확인한다. 결과가 안 나오는 검색어(드문 단어)는 출력이 없어서
    // 출력 때만 확인하면 쓸모없어진 rg 가 끝까지 돌며 다음 검색과 디스크·CPU 를 나눠 쓴다.
    const staleTimer = o.isStale ? setInterval(() => o.isStale!() && finish(), STALE_CHECK_MS) : undefined;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      if (staleTimer) clearInterval(staleTimer);
      if (!child.killed) {
        child.kill();
      }
      resolve(results);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) {
        return;
      }
      if (o.isStale?.()) {
        finish();
        return;
      }
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        results.push(...parseJsonLine(line));
        if (results.length >= o.limit) {
          results.length = o.limit;
          finish();
          return;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (e) => {
      if (!done) {
        done = true;
        if (staleTimer) clearInterval(staleTimer);
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (done) {
        return;
      }
      if (buffer) {
        results.push(...parseJsonLine(buffer));
      }
      // rg 종료 코드: 0=매치 있음, 1=매치 없음, 2=오류(일부 파일 읽기 실패 포함)
      if (code === 2 && results.length === 0 && stderr.includes('regex')) {
        done = true;
        if (staleTimer) clearInterval(staleTimer);
        reject(new Error(stderr.trim()));
        return;
      }
      finish();
    });
  });
}

/** rg --files 인자 (테스트에서 확인할 수 있도록 분리) */
/**
 * rg 를 실행할 폴더. rg 는 --iglob 을 "실행 폴더 기준 상대 경로"에 맞추고, 실행 폴더 밖의 경로는 절대 경로 전체에 맞춘다.
 * 그래서 실행 폴더가 엉뚱한 곳이면 프로젝트의 상위 폴더 이름(예: C:\work\bin\demo 의 bin)이 제외 규칙에 걸려
 * 프로젝트 전체가 빠진다. 검색 루트들의 공통 상위 폴더에서 실행한다 (드라이브가 다르면 undefined)
 */
export function rgCwd(roots: string[]): string | undefined {
  if (!roots.length) return undefined;
  const win = process.platform === 'win32';
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  let base = path.resolve(roots[0]);
  for (const r of roots.slice(1)) {
    const abs = path.resolve(r);
    while (true) {
      const rel = path.relative(norm(base), norm(abs));
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) break;
      const parent = path.dirname(base);
      if (parent === base) return undefined;
      base = parent;
    }
  }
  // 루트로 파일을 직접 넘긴 경우(열린 파일만 검색 등)는 그 파일의 폴더에서
  try {
    if (!fs.statSync(base).isDirectory()) base = path.dirname(base);
  } catch {
    return undefined;
  }
  return base;
}

export function buildListArgs(roots: string[], excludeGlobs: string[]): string[] {
  // --hidden: .env, .github 같은 숨김 파일도 (빠른 열기와 같게). .git 폴더 안은 뺀다
  const args = ['--files', '--no-config', '--hidden', '--iglob', '!**/.git/**'];
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  args.push('--', ...roots);
  return args;
}

/** 파일 목록 상한. 홈 폴더·드라이브 전체를 열었을 때 수백만 개를 메모리에 올리지 않도록 */
export const LIST_FILES_MAX = 200000;

/** 워크스페이스 파일 목록 (.gitignore 반영, 최대 LIST_FILES_MAX 개). 절대 경로 */
export function listFiles(rgPath: string, roots: string[], excludeGlobs: string[], max = LIST_FILES_MAX): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, buildListArgs(roots, excludeGlobs), { stdio: ['ignore', 'pipe', 'pipe'], cwd: rgCwd(roots) });
    const files: string[] = [];
    let rest = '';
    let stderr = '';
    let done = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      if (done) return;
      const lines = (rest + c).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) if (l) files.push(l.replace(/\r$/, ''));
      if (files.length >= max) {
        done = true;
        files.length = max;
        child.kill();
        resolve(files);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (rest) files.push(rest.replace(/\r$/, ''));
      // 종료 코드 2 는 일부 폴더 읽기 실패 — 받은 목록이 있으면 쓰고, 하나도 없으면 실패로 (→ findFiles 로 대체)
      if (code === 2 && files.length === 0) reject(new Error(stderr.trim() || 'rg --files 실패'));
      else resolve(files);
    });
  });
}

/**
 * VS Code 스타일 glob 설정값을 rg용 glob 목록으로 바꾼다.
 * "**\/{node_modules,.git}/**" 같은 중괄호 패턴은 rg도 그대로 이해한다.
 * 쉼표로 여러 개를 적은 경우만 나눈다 (중괄호 안의 쉼표는 유지).
 */
export function splitGlobs(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
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
