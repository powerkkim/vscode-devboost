import * as fs from 'fs';
import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { decodeText, explainError, isText, send } from './http';
import { ApiEnvironment, ApiNode, ApiRequest, CookieJar, buildRequest, exportJson, findNode, importJson, parseCurl, toCurl, variablesOf } from './model';
import { ApiStore } from './store';

/**
 * API 콘솔: API 요청을 모음(폴더)으로 저장해 두고 보내 보는 화면. 편집기 탭으로 열린다.
 *  - 메서드·URL·파라미터·헤더·본문(JSON · 글 · form · 파일 첨부), 인증(Bearer · Basic), 쿠키 이어 가기
 *  - 환경 변수 {{baseUrl}}, 실행 기록, cURL 붙여넣기·복사, 모음 내보내기·가져오기(Postman 모음 포함)
 * 요청은 확장이 직접 보낸다(Node 내장 http). 화면을 열기 전에는 아무것도 읽지 않는다.
 */

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

    const post = (msg: unknown) => void panel?.webview.postMessage(msg);
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

    return [
      vscode.commands.registerCommand('devBoost.apiConsole.open', open),
      {
        dispose: () => {
          inFlight?.abort();
          panel?.dispose();
          void store.flush();
        },
      },
    ];
  },
};
