import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * JavaScript 작업대의 실행 (vscode 를 쓰지 않는다). 코드 · 입력 데이터를 새 임시 폴더에 쓰고 실행기(harness.js)를 Node 로 돌린다.
 * 실행기는 한 줄에 사건 하나를 MARK + JSON 으로 내보내고, MARK 없는 줄은 코드가 직접 쓴 글로 본다.
 * 한 번 실행은 시간 제한 안에 끝나야 하고, 출력이 OUTPUT_LIMIT 글자를 넘으면 그 자리에서 멈춘다. 임시 폴더는 끝나면 지운다.
 */
export const MARK = '\u001eJSB ';
/** 출력 한도(글자). 실행기도 넘기면 스스로 끝내고, 여기서도 넘기면 끊는다 */
export const OUTPUT_LIMIT = 2_000_000;

/** 실행기 동작. 앞 둘은 코드를 돌리고, 나머지는 입력 데이터를 바꾼다 */
export type Mode = 'run-js' | 'run-ts' | 'tsv' | 'camel' | 'pretty' | 'ts' | 'props';
export const runs = (mode: Mode) => mode === 'run-js' || mode === 'run-ts';

export type Kind = 'log' | 'warn' | 'error' | 'table' | 'value' | 'out' | 'text' | 'truncated';
const KINDS = new Set<string>(['log', 'warn', 'error', 'table', 'value', 'out', 'text', 'truncated']);

/** 사건 하나. table 은 columns · rows · more(보이지 않은 줄 수), 나머지는 text */
export interface BenchEvent {
  kind: Kind;
  text: string;
  columns?: string[];
  rows?: string[][];
  more?: number;
}

/** 실행 결과. exitCode 는 끊었으면 -1 */
export interface BenchResult {
  events: BenchEvent[];
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  cancelled: boolean;
  elapsedMs: number;
}

export function failed(r: BenchResult): boolean {
  return r.exitCode !== 0 || r.timedOut || r.truncated || r.events.some((e) => e.kind === 'error');
}

/** 실행기 한 줄을 사건으로. MARK 가 없거나 JSON 이 깨졌으면 text */
export function parseLine(line: string): BenchEvent {
  if (!line.startsWith(MARK)) return { kind: 'text', text: line };
  const body = line.slice(MARK.length);
  try {
    const o = JSON.parse(body) as { kind?: string; text?: unknown; columns?: unknown[]; rows?: unknown[][]; more?: number };
    if (!o || typeof o.kind !== 'string' || !KINDS.has(o.kind)) throw new Error('kind');
    if (o.kind !== 'table') return { kind: o.kind as Kind, text: typeof o.text === 'string' ? o.text : '' };
    const str = (v: unknown) => (v == null ? '' : String(v));
    if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) throw new Error('table');
    return { kind: 'table', text: '', columns: o.columns.map(str), rows: o.rows.map((r) => r.map(str)), more: Number(o.more) || 0 };
  } catch {
    return { kind: 'text', text: body };
  }
}

/** 브라우저 · Vue · React 화면에만 있는 이름. 이것이 없다는 오류면 "화면 전용 코드" 안내를 붙인다 */
const BROWSER_NAMES = [
  'document', 'window', 'localStorage', 'sessionStorage', 'navigator', 'location', 'alert', 'confirm', 'HTMLElement', 'FileReader', 'XMLHttpRequest', 'axios', 'Vue',
  'ref', 'reactive', 'computed', 'watch', 'onMounted', 'defineProps', 'defineEmits', 'React', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext',
];

/** 오류 글이 브라우저 · Vue 화면에만 있는 이름을 찾지 못한 것이면 그 이름 */
export function browserOnlyName(errorText: string): string | undefined {
  return BROWSER_NAMES.find((n) => errorText.includes(n + ' is not defined'));
}

/** 화면에 놓을 모양: 출력 글과 표들 */
export interface BenchView {
  output: string;
  tables: { columns: string[]; rows: string[][]; more: number }[];
}

export function viewOf(result: BenchResult): BenchView {
  const lines: string[] = [];
  const tables: BenchView['tables'] = [];
  let browser: string | undefined;
  for (const e of result.events) {
    if (e.kind === 'table') {
      tables.push({ columns: e.columns ?? [], rows: e.rows ?? [], more: e.more ?? 0 });
      lines.push(`[표 ${tables.length}: ${(e.rows?.length ?? 0) + (e.more ?? 0)}줄 → "표" 탭]`);
    } else if (e.kind === 'value') lines.push('[마지막 값] ' + e.text);
    else if (e.kind === 'warn') lines.push('[경고] ' + e.text);
    else if (e.kind === 'error') {
      lines.push('[오류] ' + e.text);
      browser ??= browserOnlyName(e.text);
    } else lines.push(e.text);
  }
  if (browser) lines.push('', `${browser} 은(는) 브라우저 · Vue 화면에만 있습니다. 이 코드는 화면에서 돌려 보거나, 그 부분을 빼고 실행하세요.`);
  return { output: lines.length ? lines.join('\n') + '\n' : '', tables };
}

export interface RunOptions {
  /** Node 실행 파일. VS Code 자체(Electron)면 electron: true */
  node: string;
  electron?: boolean;
  /** harness.js 의 경로 */
  harness: string;
  mode: Mode;
  code: string;
  data: string;
  /** run-ts 일 때 typescript/lib 폴더 */
  tsLib?: string;
  timeoutMs: number;
}

export interface Run {
  done: Promise<BenchResult>;
  /** 사용자가 끊는다 */
  stop(): void;
}

/** Node 를 못 띄우거나 임시 파일을 못 쓰면 done 이 거절된다 */
export function startRun(o: RunOptions): Run {
  let child: ChildProcess | undefined;
  let stopped = false;
  const kill = () => {
    try {
      child?.kill('SIGKILL');
    } catch {
      // 이미 끝난 프로세스
    }
  };
  const done = (async (): Promise<BenchResult> => {
    const start = Date.now();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devboost-jsbench-'));
    try {
      await fs.promises.writeFile(path.join(dir, 'code.txt'), o.code, 'utf8');
      await fs.promises.writeFile(path.join(dir, 'data.txt'), o.data, 'utf8');
      if (stopped) return { events: [], exitCode: -1, timedOut: false, truncated: false, cancelled: true, elapsedMs: 0 };
      const args = [o.harness, o.mode, dir, String(OUTPUT_LIMIT)];
      if (o.tsLib) args.push(o.tsLib);
      // 사용자 환경의 NODE_OPTIONS(디버거 · 메모리 옵션 등)가 작업대 실행에 섞이지 않게 뺀다
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_OPTIONS;
      if (o.electron) env.ELECTRON_RUN_AS_NODE = '1';
      const events: BenchEvent[] = [];
      let truncated = false;
      let timedOut = false;
      let total = 0;
      const exitCode = await new Promise<number>((resolve, reject) => {
        const p = spawn(o.node, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child = p;
        const timer = setTimeout(() => {
          timedOut = !stopped && !truncated;
          kill();
        }, o.timeoutMs);
        const reader = (stream: NodeJS.ReadableStream) => {
          let rest = '';
          stream.setEncoding('utf8');
          const take = (line: string) => {
            if (truncated) return;
            total += line.length + 1;
            if (total > OUTPUT_LIMIT) {
              truncated = true;
              kill();
              return;
            }
            const e = parseLine(line.replace(/\r$/, ''));
            if (e.kind === 'truncated') truncated = true;
            else events.push(e);
          };
          stream.on('data', (chunk: string) => {
            const parts = (rest + chunk).split('\n');
            rest = parts.pop() ?? '';
            parts.forEach(take);
          });
          stream.on('end', () => rest && take(rest));
        };
        reader(p.stdout!);
        reader(p.stderr!);
        p.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        // close: 출력을 끝까지 읽은 뒤에 온다
        p.on('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });
      const ended = !timedOut && !stopped && !truncated;
      return { events, exitCode: ended ? exitCode : -1, timedOut, truncated, cancelled: stopped && !truncated && !timedOut, elapsedMs: Date.now() - start };
    } finally {
      // 임시 폴더 지우기 실패는 결과에 영향이 없다. OS 가 나중에 치운다
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  return {
    done,
    stop() {
      stopped = true;
      kill();
    },
  };
}
