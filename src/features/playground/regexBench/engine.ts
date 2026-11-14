import { Worker } from 'worker_threads';

/**
 * 정규식 작업대의 일치 · 바꾸기 계산 (vscode 를 쓰지 않는다). JavaScript 엔진(RegExp)으로 돌린다.
 * 같은 글을 여러 번 되짚는 패턴(예: (.*a){20})은 끝나지 않을 수 있어, 따로 띄운 작업 스레드에서 돌리고 시간을 넘기면 스레드를 끊는다.
 * 스레드는 처음 계산할 때 만들어 두고 다시 쓰며, 끊었으면 다음 계산 때 새로 만든다.
 */
export const MAX_MATCHES = 1000;

/** 그룹 하나. 일치에 끼지 않은 그룹은 start · end 가 -1, value 가 null. 0 번은 일치 전체 */
export interface Group {
  index: number;
  name: string | null;
  start: number;
  end: number;
  value: string | null;
}
export interface Match {
  start: number;
  end: number;
  groups: Group[];
}
export type Verdict = 'FULL' | 'PARTIAL' | 'NONE';

export interface RegexRequest {
  pattern: string;
  /** g i m s u */
  flags: string;
  text: string;
  replacement: string;
  /** "확인할 글" — 비었으면 보지 않는다 */
  check: string;
}

/**
 * matches 는 처음 MAX_MATCHES 개까지, count 는 전체 개수.
 * problem 이 SYNTAX 면 detail 은 엔진의 오류 설명. TIMEOUT 이면 나머지는 비어 있다
 */
export interface RegexResult {
  problem: 'NONE' | 'SYNTAX' | 'TIMEOUT';
  detail?: string;
  matches: Match[];
  count: number;
  replaced?: string;
  /** PARTIAL 이면 part 가 처음 맞은 부분 */
  check?: { verdict: Verdict; part?: string };
}

/** 작업 스레드에서 도는 코드 (묶어도 그대로 쓰이게 글로 둔다) */
const WORKER = `
const { parentPort } = require('worker_threads');
const MAX = ${MAX_MATCHES};

// 잡는 그룹의 이름을 차례로 (이름 없으면 null). 0 번은 일치 전체
function groupNames(p) {
  const names = [null];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') {
      if (p[i + 1] !== '?') names.push(null);
      else if (p[i + 2] === '<' && p[i + 3] !== '=' && p[i + 3] !== '!') names.push(p.slice(i + 3, p.indexOf('>', i)));
    }
  }
  return names;
}

function run(q) {
  const flags = q.flags.replace(/[^gimsu]/g, '');
  let re, plain;
  try {
    re = new RegExp(q.pattern, flags + 'd');
    plain = new RegExp(q.pattern, flags);
  } catch (e) {
    // "Invalid regular expression: /패턴/플래그: 설명" → 설명
    // (엔진은 플래그를 알파벳 차례로 적는다)
    const head = 'Invalid regular expression: /' + q.pattern + '/' + (flags + 'd').split('').sort().join('') + ': ';
    const msg = String(e.message);
    return { problem: 'SYNTAX', detail: msg.startsWith(head) ? msg.slice(head.length) : msg, matches: [], count: 0 };
  }
  const names = groupNames(q.pattern);
  const global = flags.includes('g');
  const unicode = flags.includes('u');
  const text = q.text;
  const matches = [];
  let count = 0;
  re.lastIndex = 0;
  for (let m; (m = re.exec(text)); ) {
    count++;
    if (matches.length < MAX) {
      const groups = [];
      for (let k = 0; k < m.length; k++) {
        const at = m.indices[k];
        groups.push({ index: k, name: names[k] || null, start: at ? at[0] : -1, end: at ? at[1] : -1, value: m[k] === undefined ? null : m[k] });
      }
      matches.push({ start: m.index, end: m.index + m[0].length, groups });
    }
    if (!global) break;
    // 빈 일치 뒤에는 한 글자(u 면 코드 포인트) 건너간다
    if (m[0] === '') {
      const cp = text.codePointAt(re.lastIndex);
      re.lastIndex += unicode && cp !== undefined && cp > 0xffff ? 2 : 1;
    }
  }
  const out = { problem: 'NONE', matches, count, replaced: text.replace(plain, q.replacement) };
  if (q.check) {
    const single = flags.replace('g', '');
    // 글 전체에 맞는지: 패턴 앞뒤에 "글의 처음 · 끝" 조건을 건다 (m 플래그와 상관없이)
    if (new RegExp('(?<![\\\\s\\\\S])(?:' + q.pattern + ')(?![\\\\s\\\\S])', single).test(q.check)) out.check = { verdict: 'FULL' };
    else {
      const m = new RegExp(q.pattern, single).exec(q.check);
      out.check = m ? { verdict: 'PARTIAL', part: m[0] } : { verdict: 'NONE' };
    }
  }
  return out;
}

parentPort.on('message', ({ id, q }) => {
  let result;
  try {
    result = run(q);
  } catch (e) {
    result = { problem: 'SYNTAX', detail: String(e && e.message), matches: [], count: 0 };
  }
  parentPort.postMessage({ id, result });
});
`;

const TIMED_OUT: RegexResult = { problem: 'TIMEOUT', matches: [], count: 0 };

interface Waiting {
  q: RegexRequest;
  timeoutMs: number;
  resolve: (r: RegexResult) => void;
  timer?: NodeJS.Timeout;
}

export class RegexEngine {
  private worker: Worker | undefined;
  private seq = 0;
  private waiting = new Map<number, Waiting>();

  /** 계산 하나. timeoutMs 를 넘기면 TIMEOUT 으로 끝낸다 */
  run(q: RegexRequest, timeoutMs: number): Promise<RegexResult> {
    const id = ++this.seq;
    return new Promise<RegexResult>((resolve) => {
      const w: Waiting = { q, timeoutMs, resolve };
      this.waiting.set(id, w);
      this.send(id, w);
    });
  }

  dispose() {
    this.stopWorker();
    const all = [...this.waiting.values()];
    this.waiting.clear();
    all.forEach((w) => (clearTimeout(w.timer), w.resolve(TIMED_OUT)));
  }

  private send(id: number, w: Waiting) {
    const worker = (this.worker ??= this.create());
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.timedOut(id), w.timeoutMs);
    worker.postMessage({ id, q: w.q });
  }

  /**
   * 시간을 넘긴 계산: 스레드를 끊어 멈추고 그 계산만 TIMEOUT 으로 끝낸다.
   * 그 뒤에 줄 서 있던 계산(그사이 새로 친 패턴 등)은 새 스레드에서 다시 돌린다
   */
  private timedOut(id: number) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    this.stopWorker();
    w.resolve(TIMED_OUT);
    for (const [other, rest] of this.waiting) this.send(other, rest);
  }

  private create(): Worker {
    const w = new Worker(WORKER, { eval: true });
    w.unref(); // 이 스레드 때문에 프로세스가 끝나지 못하는 일이 없게
    w.on('message', ({ id, result }: { id: number; result: RegexResult }) => {
      const done = this.waiting.get(id);
      if (!done) return;
      this.waiting.delete(id);
      clearTimeout(done.timer);
      done.resolve(result);
    });
    // 스레드가 죽으면(메모리 부족 등) 기다리던 계산을 모두 끝낸다
    w.on('error', () => this.worker === w && this.dispose());
    return w;
  }

  private stopWorker() {
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }
}
