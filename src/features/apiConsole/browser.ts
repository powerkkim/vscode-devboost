import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CaptureStore, Captured } from './capture';
import { WsClient } from './ws';

/**
 * 캡처용 브라우저: Chrome · Edge 를 전용 프로필로 띄우고 디버깅 포트(Chrome DevTools Protocol)에 붙어
 * 네트워크 호출을 받는다. 개발자 도구의 네트워크 탭과 같은 자료다. vscode 모듈에 의존하지 않는다.
 */

/** 설치된 Chrome · Edge 실행 파일을 찾는다 */
export function findBrowser(custom?: string): string | undefined {
  if (custom && fs.existsSync(custom)) return custom;
  const env = process.env;
  const list: string[] = [];
  if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter((x): x is string => !!x);
    for (const r of roots) list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const r of roots) list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
    list.push(path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
    for (const dir of (env['PATH'] ?? '').split(path.delimiter).concat(['/usr/bin', '/usr/local/bin', '/snap/bin'])) for (const n of names) if (dir) list.push(path.join(dir, n));
  }
  return list.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export interface BrowserCaptureOptions {
  executable: string;
  /** 전용 프로필 폴더 (로그인 상태가 여기에 남는다) */
  profileDir: string;
  startUrl?: string;
  /** 이보다 큰 응답 본문은 받지 않는다 */
  maxBodyBytes: number;
  /** 추가 실행 인자 (테스트용: --headless=new 등) */
  extraArgs?: string[];
  store: CaptureStore;
  /** 호출이 바뀌었을 때 (새로 생김 · 응답 옴 · 본문 받음) */
  onChange: (c: Captured) => void;
  /** 요청 헤더가 다 모였을 때 (인증 이어받기용) */
  onRequest: (c: Captured) => void;
  /** 브라우저가 닫혔거나 연결이 끊김 */
  onClose: () => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class BrowserCapture {
  private child: ChildProcess | undefined;
  private ws: WsClient | undefined;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private readonly opts: BrowserCaptureOptions) {}

  static async start(opts: BrowserCaptureOptions): Promise<BrowserCapture> {
    const cap = new BrowserCapture(opts);
    try {
      await cap.launch();
    } catch (e) {
      cap.stop();
      throw e;
    }
    return cap;
  }

  private async launch() {
    const { executable, profileDir, startUrl } = this.opts;
    fs.mkdirSync(profileDir, { recursive: true });
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const readPort = (): string | undefined => {
      try {
        const [p, w] = fs.readFileSync(portFile, 'utf8').split('\n');
        return /^\d+$/.test(p.trim()) && w?.trim() ? `ws://127.0.0.1:${p.trim()}${w.trim()}` : undefined;
      } catch {
        return undefined; // 아직 없다
      }
    };
    // 지난번 캡처 브라우저가 아직 떠 있으면 거기에 다시 붙는다 (같은 프로필로는 두 번 띄울 수 없다)
    let ws: WsClient | undefined;
    const old = readPort();
    if (old) {
      try {
        ws = await WsClient.connect(old, 800);
      } catch {
        // 떠 있지 않다: 새로 띄운다
      }
    }
    if (ws) {
      this.attach(ws);
      if (startUrl) this.send('Target.createTarget', { url: startUrl }).catch(() => undefined);
    } else {
      try {
        fs.unlinkSync(portFile);
      } catch {
        // 없으면 그만
      }
      const args = [`--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...(this.opts.extraArgs ?? []), startUrl || 'about:blank'];
      const child = spawn(executable, args, { stdio: 'ignore', detached: false });
      this.child = child;
      let exited = false;
      child.on('exit', () => {
        exited = true;
        this.finish();
      });
      child.on('error', () => {
        exited = true;
        this.finish();
      });
      // 브라우저가 포트를 적어 줄 때까지 기다린다
      let url: string | undefined;
      for (let i = 0; i < 150 && !url; i++) {
        if (exited) throw new Error('브라우저가 바로 닫혔습니다. 실행 파일 경로(devBoost.apiConsole.capture.browserPath)를 확인하세요.');
        await new Promise((r) => setTimeout(r, 100));
        url = readPort();
      }
      if (!url) throw new Error('브라우저의 디버깅 포트를 찾지 못했습니다. 회사 정책으로 원격 디버깅이 막혀 있으면 HAR 가져오기를 쓰세요.');
      this.attach(await WsClient.connect(url));
    }
    // 탭(과 그 안의 프레임·워커)이 생길 때마다 자동으로 붙는다
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await this.send('Target.setDiscoverTargets', { discover: true });
  }

  private attach(ws: WsClient) {
    this.ws = ws;
    ws.onMessage = (text) => this.onMessage(text);
    ws.onClose = () => this.finish();
  }

  private send(method: string, params: unknown = {}, sessionId?: string): Promise<unknown> {
    const ws = this.ws;
    if (!ws || this.closed) return Promise.reject(new Error('브라우저와 연결이 끊겼습니다'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private onMessage(text: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? '오류'));
      else p.resolve(m.result);
      return;
    }
    if (m.method === 'Target.attachedToTarget') {
      const type = m.params?.targetInfo?.type;
      const sid = m.params?.sessionId;
      if (!sid) return;
      if (type === 'page' || type === 'iframe' || type === 'worker' || type === 'service_worker' || type === 'shared_worker') {
        this.send('Network.enable', { maxPostDataSize: 256 * 1024 }, sid).catch(() => undefined);
        // 페이지 안의 프레임·워커에도 이어서 붙는다
        this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => undefined);
      }
      return;
    }
    if (typeof m.method !== 'string' || !m.method.startsWith('Network.')) return;
    const { store } = this.opts;
    const ev = store.onEvent(m.method, m.params, m.sessionId);
    const changed = ev.changed ? store.get(ev.changed) : undefined;
    if (changed) {
      this.opts.onChange(changed);
      if (m.method === 'Network.requestWillBeSent' || m.method === 'Network.requestWillBeSentExtraInfo') this.opts.onRequest(changed);
    }
    if (ev.needPostData) {
      const { id, requestId, sessionId } = ev.needPostData;
      this.send('Network.getRequestPostData', { requestId }, sessionId)
        .then((r) => {
          const c = store.get(id);
          const data = (r as { postData?: string })?.postData;
          if (c && typeof data === 'string') {
            c.reqBody = data;
            this.opts.onChange(c);
          }
        })
        .catch(() => undefined);
    }
    if (ev.finished) {
      const { id, requestId, sessionId } = ev.finished;
      const c = store.get(id);
      if (!c) return;
      if ((c.size ?? 0) > this.opts.maxBodyBytes) {
        c.resSkipped = true;
        return;
      }
      this.send('Network.getResponseBody', { requestId }, sessionId)
        .then((r) => {
          const got = r as { body?: string; base64Encoded?: boolean };
          if (typeof got?.body !== 'string') return;
          if (got.body.length > this.opts.maxBodyBytes * 1.4) {
            c.resSkipped = true;
            return;
          }
          c.resBody = got.body;
          if (got.base64Encoded) c.resBase64 = true;
          this.opts.onChange(c);
        })
        .catch(() => undefined); // 화면이 넘어가 본문이 사라진 경우
    }
  }

  get running(): boolean {
    return !this.closed;
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('브라우저와 연결이 끊겼습니다'));
    this.pending.clear();
    this.ws?.close();
    this.opts.onClose();
  }

  /** 캡처를 끝내고 브라우저를 닫는다 */
  stop() {
    const child = this.child;
    const kill = () => {
      try {
        if (child && child.exitCode === null) child.kill();
      } catch {
        // 이미 끝남
      }
    };
    if (this.ws && !this.closed) {
      // 브라우저가 스스로 닫히게 한다 (프로필이 깨지지 않게). 안 닫히면 프로세스를 끝낸다
      this.send('Browser.close').catch(() => undefined);
      setTimeout(() => this.finish(), 300);
      setTimeout(kill, 2000);
    } else {
      kill();
      this.finish();
    }
  }
}
