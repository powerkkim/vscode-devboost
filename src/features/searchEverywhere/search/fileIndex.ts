import { spawn } from 'child_process';
import * as path from 'path';
import { rgCwd } from './ripgrep';

/**
 * rg 한 번으로 만드는 파일별 색인의 공통 틀 (Mapper·Spring 탭이 같이 쓴다. vscode 모듈에 의존하지 않음).
 *
 * - ensure(): 처음 한 번 루트 전체를 rg 로 훑는다. 루트·제외 설정이 바뀌면 다시
 * - queueUpdate(): 저장·생성된 파일을 모았다가(BATCH_MS) 그 파일들만 rg 로 다시 읽어 그 파일 몫을 통째로 바꾼다
 * - removeFile(): 지운 파일·폴더 몫을 뺀다
 * 클래스 색인(ClassIndex)과 같은 규칙이다. 색인 폴더(설정 indexFolders) 밖의 파일은 받지 않는다.
 */
export interface FileIndexSpec<E> {
  /** 기록용 이름 (예: "mapper XML") */
  name: string;
  /** 이 색인이 읽는 파일인지 (확장자) */
  accepts(file: string): boolean;
  /** rg 인자. paths = 루트들 또는 다시 읽을 파일들, excludeGlobs = 제외 (파일을 직접 줄 때는 []) */
  args(paths: string[], excludeGlobs: string[]): string[];
  /** rg 출력 → 파일별 항목. 결과에 없는 파일은 "항목 없음" */
  parse(out: string): Map<string, E[]>;
}

export function runRgText(rgPath: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'], cwd });
    const chunks: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(chunks.join(''))); // 0=찾음, 1=없음, 2=일부 읽기 실패 → 받은 만큼 쓴다
  });
}

export class FileIndex<E> {
  private byFile = new Map<string, E[]>();
  private key = '';
  private roots: string[] = [];
  private building: Promise<void> | undefined;
  private buildId = 0;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private all: E[] | undefined;
  ready = false;
  lastBuildMs = 0;
  /** 기록용 (출력 패널) */
  onLog: ((msg: string) => void) | undefined;
  /** 항목이 바뀔 때 (묶어 쓰는 쪽 캐시를 비우려고) */
  onChange: (() => void) | undefined;

  static BATCH_MS = 300;

  constructor(
    private readonly rgPath: string,
    private readonly spec: FileIndexSpec<E>
  ) {}

  /** 색인이 준비될 때까지 기다린다. 루트·제외 설정이 바뀌었으면 새로 만든다 */
  ensure(roots: string[], excludeGlobs: string[]): Promise<void> {
    const key = JSON.stringify([roots, excludeGlobs]);
    if (key !== this.key) {
      this.key = key;
      this.roots = roots.map((r) => path.normalize(r));
      this.ready = false;
      const id = ++this.buildId;
      const started = Date.now();
      const p = runRgText(this.rgPath, this.spec.args(roots, excludeGlobs), rgCwd(roots)).then((out) => {
        if (this.buildId !== id) return;
        this.byFile = this.spec.parse(out);
        this.changed();
        this.ready = true;
        this.lastBuildMs = Date.now() - started;
        if (this.pending.size) this.schedule();
      });
      this.building = p;
      p.catch((e) => {
        if (this.buildId === id) this.key = ''; // 실패하면 다음에 다시
        this.onLog?.(`[경고] ${this.spec.name} 색인 실패: ${e}`);
      });
    }
    return this.building!;
  }

  /** 저장·생성된 파일만 다시 읽도록 예약 (모아서 처리) */
  queueUpdate(file: string) {
    if (!this.spec.accepts(file)) return;
    const f = path.normalize(file);
    if (!this.roots.some((r) => f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep))) return; // 색인 폴더 밖
    this.pending.add(f);
    this.schedule();
  }

  /** 지운 파일·폴더 */
  removeFile(file: string) {
    file = path.normalize(file);
    const prefix = file.endsWith(path.sep) ? file : file + path.sep;
    let changed = this.byFile.delete(file);
    for (const f of [...this.byFile.keys()]) if (f.startsWith(prefix)) changed = this.byFile.delete(f) || changed;
    this.pending.delete(file);
    if (changed) this.changed();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FileIndex.BATCH_MS);
  }

  /** 예약된 갱신 처리 (테스트에서 직접 부를 수 있음). 처리가 겹치지 않게 차례로 */
  async flush(): Promise<string[]> {
    while (this.flushing) await this.flushing.catch(() => undefined);
    if (!this.ready || !this.pending.size) return [];
    const files = [...this.pending];
    this.pending.clear();
    const id = this.buildId;
    const p = runRgText(this.rgPath, this.spec.args(files, [])).then((out) => {
      if (this.buildId !== id || !this.ready) return; // 그사이 전체 색인이 다시 시작됨
      const found = this.spec.parse(out);
      for (const f of files) {
        const list = found.get(f);
        if (list?.length) this.byFile.set(f, list);
        else this.byFile.delete(f);
      }
      this.changed();
    });
    this.flushing = p;
    try {
      await p;
    } finally {
      this.flushing = undefined;
    }
    return files;
  }

  private changed() {
    this.all = undefined;
    this.onChange?.();
  }

  /** 모든 항목 */
  entries(): E[] {
    if (!this.all) this.all = [...this.byFile.values()].flat();
    return this.all;
  }

  /** 항목이 있는 파일 수 */
  get fileCount(): number {
    return this.byFile.size;
  }

  has(file: string): boolean {
    return this.byFile.has(file);
  }
}
