import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { BrowserCapture, findBrowser } from './browser';
import { AuthFollow, CaptureStore, Captured, capturedToRequest, parseHar, rowOf } from './capture';
import { EndpointLens, endpointAt, endpointsOf, endpointsToRequests } from './endpoints';
import { decodeText, explainError, isText, send } from './http';
import { ApiEnvironment, ApiNode, ApiRequest, CookieJar, buildRequest, exportJson, findNode, importJson, matchTemplate, parseCurl, pickValue, toCurl, variablesOf } from './model';
import { ApiStore } from './store';

/**
 * API 콘솔: API 요청을 모음(폴더)으로 저장해 두고 보내 보는 화면. 편집기 탭으로 열린다.
 *  - 메서드·URL·파라미터·헤더·본문(JSON · 글 · form · 파일 첨부), 인증(Bearer · Basic), 쿠키 이어 가기
 *  - 환경 변수 {{baseUrl}}, 실행 기록, cURL 붙여넣기·복사, 모음 내보내기·가져오기(Postman 모음 포함)
 *  - Controller 의 매핑 메서드에서 요청 만들기 (CodeLens · 우클릭)
 *  - 브라우저 캡처: 전용 브라우저의 XHR · fetch 호출을 받아 보고 요청으로 옮기기, 토큰 · 쿠키 이어받기, HAR 가져오기
 * 요청은 확장이 직접 보낸다(Node 내장 http). 화면을 열기 전에는 아무것도 읽지 않는다.
 */

const FOLLOW_ON = 'devBoost.apiConsole.followOn';
const FOLLOW_SECRET = 'devBoost.apiConsole.follow';
const CAPTURE_URL = 'devBoost.apiConsole.captureUrl';

function cfg() {
  return vscode.workspace.getConfiguration('devBoost.apiConsole');
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

interface FromView {
  type: string;
  [k: string]: unknown;
}

export const apiConsole: Feature = {
  id: 'apiConsole',
  name: 'API 콘솔',
  start(context) {
    const store = new ApiStore(context);
    const jar = new CookieJar();
    let panel: vscode.WebviewPanel | undefined;
    /** 보내는 중인 요청 (취소용) */
    let inFlight: AbortController | undefined;
    /** 마지막 응답의 본문 (글이 아닌 응답을 파일로 저장할 때) */
    let lastBody: { body: Buffer; name: string } | undefined;

    /** 화면이 준비됐는가 (준비 전에 보낼 것은 모아 둔다) */
    let ready = false;
    const waiting: unknown[] = [];

    const post = (msg: unknown) => void panel?.webview.postMessage(msg);
    const postWhenReady = (msg: unknown) => {
      if (ready) post(msg);
      else waiting.push(msg);
    };

    /* ---------------------------------------------------------- 인증 이어받기 · 캡처 */
    const follow = new AuthFollow();
    let followOn = context.globalState.get<boolean>(FOLLOW_ON, true);
    const captured = new CaptureStore(300);
    let capture: BrowserCapture | undefined;
    let starting = false;
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    status.text = '$(record) API 캡처 중';
    status.tooltip = 'API 콘솔이 브라우저의 호출을 받고 있습니다. 누르면 API 콘솔을 엽니다';
    status.command = 'devBoost.apiConsole.open';

    const followState = () => ({ type: 'follow', on: followOn, hosts: follow.summary() });
    const captureState = () => ({ type: 'capture', running: !!capture?.running, rows: captured.rows() });
    let followTimer: ReturnType<typeof setTimeout> | undefined;
    const followChanged = () => {
      if (followTimer) return;
      followTimer = setTimeout(() => {
        followTimer = undefined;
        post(followState());
        post({ type: 'cookies', cookies: jar.count() });
        void context.secrets.store(FOLLOW_SECRET, follow.toJSON());
      }, 500);
    };
    /** 브라우저가 보낸 요청에서 인증(토큰 헤더 · 쿠키)을 배운다 */
    const learn = (c: Captured) => {
      if (!followOn) return;
      if (!follow.learn(c.url, c.reqHeaders)) return;
      const cookie = c.reqHeaders.find(([k]) => k.toLowerCase() === 'cookie')?.[1];
      if (cookie) jar.absorb(c.url, cookie);
      followChanged();
    };
    // 지난번에 이어받은 인증을 다시 쓴다
    void Promise.resolve(context.secrets.get(FOLLOW_SECRET)).then((text) => {
      follow.load(text);
      if (followOn) for (const [host, f] of follow.entries()) if (f.cookie) jar.absorb(`http://${host}/`, f.cookie);
      if (ready) {
        post(followState());
        post({ type: 'cookies', cookies: jar.count() });
      }
    });

    /** 바뀐 호출을 조금 모아서 화면에 알린다 */
    const dirty = new Set<string>();
    let rowTimer: ReturnType<typeof setTimeout> | undefined;
    const rowChanged = (c: Captured) => {
      dirty.add(c.id);
      if (rowTimer) return;
      rowTimer = setTimeout(() => {
        rowTimer = undefined;
        const rows = [...dirty].map((id) => captured.get(id)).filter((x): x is Captured => !!x).map(rowOf);
        dirty.clear();
        if (rows.length) post({ type: 'captureRows', rows });
      }, 150);
    };

    const captureStop = () => {
      capture?.stop();
      capture = undefined;
      status.hide();
      post(captureState());
    };

    const captureStart = async (askUrl = false) => {
      if (capture?.running || starting) return;
      if (vscode.env.remoteName) {
        void vscode.window.showWarningMessage('원격(WSL · SSH · 컨테이너) 창에서는 브라우저를 띄울 수 없습니다. 브라우저 개발자 도구에서 저장한 HAR 파일을 "HAR 가져오기"로 불러오세요.');
        return;
      }
      const exe = findBrowser(cfg().get<string>('capture.browserPath', '') || undefined);
      if (!exe) {
        void vscode.window.showWarningMessage('Chrome 이나 Edge 를 찾지 못했습니다. 설정 devBoost.apiConsole.capture.browserPath 에 실행 파일 경로를 적어 주세요.');
        return;
      }
      let url = context.globalState.get<string>(CAPTURE_URL);
      if (url === undefined || askUrl) {
        const typed = await vscode.window.showInputBox({
          title: '브라우저 캡처: 처음에 열 주소',
          prompt: '개발 중인 화면의 주소. 다음부터는 묻지 않습니다 (캡처 메뉴의 "시작 주소 바꾸기"로 고칠 수 있습니다)',
          value: url ?? 'http://localhost:5173',
        });
        if (typed === undefined) return;
        url = typed.trim();
        await context.globalState.update(CAPTURE_URL, url);
      }
      starting = true;
      try {
        capture = await BrowserCapture.start({
          executable: exe,
          profileDir: path.join(context.globalStorageUri.fsPath, 'apiConsole', 'browser'),
          startUrl: url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? 'http://' + url : url,
          maxBodyBytes: Math.max(1, cfg().get<number>('maxResponseMb', 5)) * 1024 * 1024,
          store: captured,
          onChange: rowChanged,
          onRequest: learn,
          onClose: () => {
            capture = undefined;
            status.hide();
            post(captureState());
          },
        });
        status.show();
        post(captureState());
      } catch (e) {
        capture = undefined;
        void vscode.window.showErrorMessage(`브라우저 캡처를 시작하지 못했습니다: ${(e as Error).message}`);
        post(captureState());
      } finally {
        starting = false;
      }
    };

    const envOf = (id: unknown): ApiEnvironment | undefined => store.current()?.environments.find((e) => e.id === id);
    const readFile = (p: string) => fs.readFileSync(p);

    const doSend = async (request: ApiRequest, envId: unknown, key: unknown) => {
      const env = envOf(envId);
      let built;
      try {
        built = buildRequest(request, variablesOf(env), readFile);
      } catch (e) {
        post({ type: 'response', key, ok: false, error: `첨부 파일을 읽을 수 없습니다: ${(e as Error).message}` });
        return;
      }
      if (built.missingPath.length) {
        post({ type: 'response', key, ok: false, error: `경로 값이 비었습니다: ${built.missingPath.map((m) => `{${m}}`).join(', ')} — 파라미터 탭의 "경로 값"에 넣으세요` });
        return;
      }
      if (built.missing.length) {
        post({ type: 'response', key, ok: false, error: `값이 없는 변수: ${built.missing.map((m) => `{{${m}}}`).join(', ')} — ${env ? `환경 "${env.name}" 에 추가하세요` : '환경을 고르거나 만들어 변수를 넣으세요'}` });
        return;
      }
      if (!built.url) {
        post({ type: 'response', key, ok: false, error: '주소를 입력하세요' });
        return;
      }
      if (env?.confirm) {
        const go = await vscode.window.showWarningMessage(`"${env.name}" 환경으로 보냅니다`, { modal: true, detail: `${built.method} ${built.url}` }, '보내기');
        if (go !== '보내기') {
          post({ type: 'response', key, ok: false, error: '보내지 않았습니다', cancelled: true });
          return;
        }
      }
      // 브라우저에서 이어받은 인증: 요청에 같은 헤더가 없을 때만 붙인다
      const followed: string[] = [];
      if (followOn) {
        for (const [k, v] of follow.headersFor(built.url)) {
          if (Object.keys(built.headers).some((h) => h.toLowerCase() === k.toLowerCase())) continue;
          built.headers[k] = v;
          followed.push(k);
        }
      }
      inFlight?.abort();
      const ctl = new AbortController();
      inFlight = ctl;
      try {
        const res = await send(built, {
          timeoutMs: Math.max(1, cfg().get<number>('timeoutSeconds', 30)) * 1000,
          insecureTls: cfg().get<boolean>('insecureTls', false),
          followRedirects: cfg().get<boolean>('followRedirects', true),
          maxBodyBytes: Math.max(1, cfg().get<number>('maxResponseMb', 5)) * 1024 * 1024,
          jar,
          signal: ctl.signal,
        });
        const ctype = res.headers.find((h) => h[0].toLowerCase() === 'content-type')?.[1];
        const text = isText(ctype, res.body);
        let name = 'response';
        try {
          name = new URL(res.url).pathname.split('/').filter(Boolean).pop() || 'response';
        } catch {
          // 이름은 기본값
        }
        lastBody = { body: res.body, name };
        // "변수 저장"에 적어 둔 값들을 응답에서 꺼낸다 (성공한 응답에서만)
        const extracted: { key: string; value?: string }[] = [];
        const rules = (request.extract ?? []).filter((r) => r.enabled && r.key.trim() && r.value.trim());
        if (rules.length && res.status < 400) {
          let json: unknown;
          if (text) {
            try {
              json = JSON.parse(decodeText(res.body, ctype));
            } catch {
              // JSON 이 아니면 헤더에서만 꺼낼 수 있다
            }
          }
          for (const r of rules) extracted.push({ key: r.key.trim(), value: pickValue(json, res.headers, r.value) });
        }
        post({
          type: 'response',
          key,
          ok: true,
          status: res.status,
          statusText: res.statusText,
          ms: res.ms,
          bytes: res.bytes,
          size: res.body.length,
          headers: res.headers,
          contentType: ctype ?? '',
          text: text ? decodeText(res.body, ctype) : null,
          truncated: res.truncated,
          url: res.url,
          redirects: res.redirects,
          sent: { method: built.method, url: built.url, headers: res.sentHeaders, body: built.body && built.body.length <= 200_000 ? built.body.toString('utf8') : built.body ? `(본문 ${built.body.length}바이트)` : '' },
          cookies: jar.count(),
          followed,
          extracted,
        });
        post({ type: 'history', history: store.addHistory({ at: Date.now(), method: built.method, url: built.url, status: res.status, ms: res.ms, request, environment: env?.name }) });
      } catch (e) {
        post({ type: 'response', key, ok: false, error: explainError(e), cancelled: ctl.signal.aborted });
      } finally {
        if (inFlight === ctl) inFlight = undefined;
      }
    };

    const onMessage = async (m: FromView) => {
      switch (m.type) {
        case 'ready': {
          const data = await store.load();
          post({ type: 'init', data, version: String(context.extension.packageJSON.version ?? ''), cookies: jar.count() });
          post(followState());
          post(captureState());
          ready = true;
          for (const msg of waiting.splice(0)) post(msg);
          break;
        }
        case 'captureStart':
          await captureStart(!!m.askUrl);
          break;
        case 'captureStop':
          captureStop();
          break;
        case 'captureClear':
          captured.clear();
          post(captureState());
          break;
        case 'captureDetail':
          post({ type: 'captureDetail', token: m.token, entry: captured.get(String(m.id)) ?? null });
          break;
        case 'captureToRequest': {
          const c = captured.get(String(m.id));
          const base = variablesOf(envOf(m.envId)).baseUrl;
          // 이어받기가 켜져 있으면 토큰은 요청에 적지 않는다 (보낼 때 최신 것이 붙는다)
          post({ type: 'captureToRequest', token: m.token, request: c ? capturedToRequest(c, { baseUrl: base, dropAuth: followOn }) : null });
          break;
        }
        case 'matchCapture': {
          // 캡처한 호출과 주소 틀이 맞는 모음의 요청 (글자 그대로 맞은 조각이 가장 많은 것)
          const c = captured.get(String(m.id));
          let best: { id: string; vars: Record<string, string>; fixed: number } | undefined;
          for (const cand of c && Array.isArray(m.requests) ? (m.requests as { id: string; method: string; url: string }[]) : []) {
            if (String(cand.method).toUpperCase() !== c!.method) continue;
            const hit = matchTemplate(String(cand.url), c!.url);
            if (hit && (!best || hit.fixed > best.fixed)) best = { id: cand.id, ...hit };
          }
          post({ type: 'matchCapture', token: m.token, match: best ?? null });
          break;
        }
        case 'importHar': {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'HAR 가져오기', filters: { HAR: ['har', 'json'] } });
          if (!picked?.[0]) break;
          try {
            const entries = parseHar(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
            if (!entries) {
              void vscode.window.showWarningMessage('HAR 파일이 아닙니다. 브라우저 개발자 도구의 네트워크 탭에서 "HAR 로 모두 저장"한 파일을 고르세요.');
              break;
            }
            // 오래된 것부터 넣어야 최근 것이 위로, 인증도 마지막 것이 남는다
            for (const e of entries.slice(0, 300).reverse()) learn(captured.add(e));
            post(captureState());
            post({ type: 'toast', text: entries.length ? `HAR 에서 호출 ${Math.min(entries.length, 300)}개를 가져왔습니다` : 'HAR 에 XHR · fetch 호출이 없습니다' });
          } catch (e) {
            void vscode.window.showErrorMessage(`가져오지 못했습니다: ${(e as Error).message}`);
          }
          break;
        }
        case 'setFollow':
          followOn = !!m.on;
          await context.globalState.update(FOLLOW_ON, followOn);
          if (followOn) for (const [host, f] of follow.entries()) if (f.cookie) jar.absorb(`http://${host}/`, f.cookie);
          post(followState());
          post({ type: 'cookies', cookies: jar.count() });
          break;
        case 'clearFollow':
          follow.clear();
          jar.clear();
          await context.secrets.delete(FOLLOW_SECRET);
          post(followState());
          post({ type: 'cookies', cookies: 0 });
          post({ type: 'toast', text: '이어받은 인증과 쿠키를 지웠습니다' });
          break;
        case 'input': {
          const value = await vscode.window.showInputBox({ title: String(m.title ?? ''), prompt: m.prompt ? String(m.prompt) : undefined, value: String(m.value ?? '') });
          post({ type: 'input', token: m.token, value: value ?? null });
          break;
        }
        case 'save':
          store.update(m.data as { collections: ApiNode[]; environments: ApiEnvironment[]; activeEnvironment?: string });
          break;
        case 'send':
          await doSend(m.request as ApiRequest, m.envId, m.key);
          break;
        case 'cancel':
          inFlight?.abort();
          break;
        case 'pickFile': {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '첨부' });
          if (picked?.[0]) post({ type: 'filePicked', token: m.token, path: picked[0].fsPath });
          break;
        }
        case 'parseCurl': {
          const request = parseCurl(String(m.text ?? ''));
          post({ type: 'curlParsed', token: m.token, request: request ?? null });
          break;
        }
        case 'copyCurl': {
          const request = m.request as ApiRequest;
          try {
            const built = buildRequest(request, variablesOf(envOf(m.envId)), () => Buffer.alloc(0));
            const form = request.bodyMode === 'multipart' ? request.bodyForm.filter((r) => r.enabled && r.key.trim()) : undefined;
            await vscode.env.clipboard.writeText(toCurl(built, form));
            post({ type: 'toast', text: 'cURL 을 복사했습니다' });
          } catch (e) {
            post({ type: 'toast', text: `복사하지 못했습니다: ${(e as Error).message}` });
          }
          break;
        }
        case 'copy':
          await vscode.env.clipboard.writeText(String(m.text ?? ''));
          post({ type: 'toast', text: '복사했습니다' });
          break;
        case 'import': {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '가져오기', filters: { JSON: ['json'] } });
          if (!picked?.[0]) break;
          try {
            const got = importJson(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'));
            if (!got) {
              void vscode.window.showWarningMessage('가져올 수 없는 파일입니다. API 콘솔이 내보낸 파일이나 Postman 모음(v2) · 환경 파일을 고르세요.');
              break;
            }
            post({ type: 'imported', collections: got.collections, environments: got.environments });
          } catch (e) {
            void vscode.window.showErrorMessage(`가져오지 못했습니다: ${(e as Error).message}`);
          }
          break;
        }
        case 'export': {
          const data = store.current();
          if (!data) break;
          await store.flush();
          const hit = typeof m.id === 'string' ? findNode(data.collections, m.id) : undefined;
          const nodes = hit ? [hit.node] : data.collections;
          const base = (hit?.node.name ?? 'api-console').replace(/[\\/:*?"<>|]/g, '_');
          const day = new Date().toISOString().slice(0, 10);
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${base}-${day}.json`), filters: { JSON: ['json'] } });
          if (!target) break;
          await vscode.workspace.fs.writeFile(target, Buffer.from(exportJson(nodes, hit ? [] : data.environments), 'utf8'));
          post({ type: 'toast', text: '내보냈습니다 (환경 변수의 값은 넣지 않았습니다)' });
          break;
        }
        case 'saveBody': {
          if (!lastBody) break;
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(lastBody.name) });
          if (target) await vscode.workspace.fs.writeFile(target, lastBody.body);
          break;
        }
        case 'clearCookies':
          jar.clear();
          post({ type: 'cookies', cookies: 0 });
          post({ type: 'toast', text: '쿠키를 비웠습니다' });
          break;
        case 'clearHistory':
          store.clearHistory();
          post({ type: 'history', history: [] });
          break;
        default:
          break;
      }
    };

    const open = () => {
      if (panel) {
        panel.reveal();
        return;
      }
      const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'apiConsole');
      panel = vscode.window.createWebviewPanel('devBoost.apiConsole', 'API 콘솔', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true, // 다른 탭에 다녀와도 쓰던 내용과 응답이 남게
        localResourceRoots: [mediaRoot],
      });
      panel.iconPath = new vscode.ThemeIcon('globe');
      const subs: vscode.Disposable[] = [];
      panel.webview.onDidReceiveMessage((m: FromView) => void onMessage(m), null, subs);
      panel.onDidDispose(
        () => {
          panel = undefined;
          ready = false;
          waiting.length = 0;
          inFlight?.abort();
          lastBody = undefined;
          void store.flush();
          subs.forEach((d) => d.dispose());
        },
        null,
        subs
      );
      const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'app.css'));
      const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'app.js'));
      const n = nonce();
      panel.webview.html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${css}" rel="stylesheet">
  <title>API 콘솔</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${n}" src="${js}"></script>
</body>
</html>`;
    };

    /* ---------------------------------------------------------- Controller → 요청 */
    const lens = new EndpointLens();

    const docOf = async (uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
      if (uri instanceof vscode.Uri) return vscode.workspace.openTextDocument(uri);
      const ed = vscode.window.activeTextEditor;
      return ed?.document.languageId === 'java' ? ed.document : undefined;
    };

    /** 매핑 메서드 하나를 API 콘솔에서 연다. CodeLens 는 (uri, origin) 을 주고, 우클릭 · 명령은 커서 자리에서 찾는다 */
    const openEndpoint = async (uri?: vscode.Uri, origin?: string) => {
      const doc = await docOf(uri);
      if (!doc) {
        void vscode.window.showInformationMessage('Controller(Java) 파일에서 쓰는 명령입니다.');
        return;
      }
      const all = endpointsOf(doc);
      let ep = typeof origin === 'string' ? all.find((e) => e.origin === origin) : undefined;
      if (!ep && typeof origin !== 'string') {
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document === doc) ep = endpointAt(doc, ed.selection.active.line);
      }
      if (!ep) {
        if (!all.length) {
          void vscode.window.showInformationMessage('이 파일에서 @GetMapping · @PostMapping 같은 매핑 메서드를 찾지 못했습니다.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          all.map((e) => ({ label: `${e.http} ${e.path || '/'}`, description: e.title === e.method.name ? `${e.cls.name}.${e.method.name}()` : `${e.title} · ${e.method.name}()`, ep: e })),
          { title: 'API 콘솔에서 열 요청', matchOnDescription: true }
        );
        if (!picked) return;
        ep = picked.ep;
      }
      const got = await endpointsToRequests(doc.uri, [ep]);
      open();
      postWhenReady({ type: 'addEndpoints', ...got });
    };

    /** Controller 의 매핑 메서드를 모두 모음에 넣는다 */
    const addController = async (uri?: vscode.Uri, fqcn?: string) => {
      const doc = await docOf(uri);
      if (!doc) {
        void vscode.window.showInformationMessage('Controller(Java) 파일에서 쓰는 명령입니다.');
        return;
      }
      const all = endpointsOf(doc).filter((e) => typeof fqcn !== 'string' || e.cls.fqcn === fqcn);
      if (!all.length) {
        void vscode.window.showInformationMessage('이 파일에서 @GetMapping · @PostMapping 같은 매핑 메서드를 찾지 못했습니다.');
        return;
      }
      const got = await endpointsToRequests(doc.uri, all);
      open();
      postWhenReady({ type: 'addEndpoints', ...got });
    };

    return [
      vscode.commands.registerCommand('devBoost.apiConsole.open', open),
      vscode.commands.registerCommand('devBoost.apiConsole.openEndpoint', openEndpoint),
      vscode.commands.registerCommand('devBoost.apiConsole.addController', addController),
      vscode.commands.registerCommand('devBoost.apiConsole.captureStart', async () => {
        open();
        await captureStart();
      }),
      vscode.commands.registerCommand('devBoost.apiConsole.captureStop', captureStop),
      vscode.languages.registerCodeLensProvider({ language: 'java' }, lens),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('devBoost.apiConsole.codeLens') && lens.refresh()),
      status,
      {
        dispose: () => {
          inFlight?.abort();
          capture?.stop();
          capture = undefined;
          if (followTimer) clearTimeout(followTimer);
          if (rowTimer) clearTimeout(rowTimer);
          panel?.dispose();
          void store.flush();
        },
      },
    ];
  },
};
