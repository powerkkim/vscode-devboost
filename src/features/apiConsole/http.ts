import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { BuiltRequest, CookieJar } from './model';

/**
 * 요청 보내기. Node 내장 http/https 만 쓴다 (추가 라이브러리 없음). vscode 모듈에 의존하지 않는다.
 * 브라우저가 아니라 확장에서 보내므로 CORS 제약이 없다.
 */

export interface SendOptions {
  timeoutMs: number;
  /** 사설 인증서(개발 서버)도 받아들인다 */
  insecureTls: boolean;
  /** 3xx 를 따라간다 (최대 5번) */
  followRedirects: boolean;
  /** 본문이 이보다 크면 여기까지만 받는다 */
  maxBodyBytes: number;
  jar?: CookieJar;
  signal?: AbortSignal;
}

export interface SentResponse {
  status: number;
  statusText: string;
  /** 같은 이름이 여러 번이면 값이 여러 개 */
  headers: [string, string][];
  /** 압축을 푼 본문 */
  body: Buffer;
  /** 받은 크기(압축 상태 그대로) */
  bytes: number;
  ms: number;
  /** 마지막으로 요청한 URL (리다이렉트를 따라갔으면 그 끝) */
  url: string;
  redirects: string[];
  /** maxBodyBytes 에서 잘림 */
  truncated: boolean;
  /** 보낸 헤더 (쿠키 포함, 실제로 나간 그대로) */
  sentHeaders: Record<string, string>;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  try {
    const e = (encoding ?? '').toLowerCase();
    if (e.includes('br')) return zlib.brotliDecompressSync(body);
    if (e.includes('gzip')) return zlib.gunzipSync(body);
    if (e.includes('deflate')) return zlib.inflateSync(body);
  } catch {
    // 압축 표시와 내용이 안 맞으면 받은 그대로
  }
  return body;
}

interface Once {
  status: number;
  statusText: string;
  rawHeaders: string[];
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function once(method: string, url: URL, headers: Record<string, string>, body: Buffer | undefined, opts: SendOptions): Promise<Once> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    if (!secure && url.protocol !== 'http:') {
      reject(new Error(`http, https 주소만 보낼 수 있습니다: ${url.protocol}//`));
      return;
    }
    const req = (secure ? https : http).request(
      url,
      { method, headers, ...(secure ? { rejectUnauthorized: !opts.insecureTls } : {}), signal: opts.signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > opts.maxBodyBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - opts.maxBodyBytes)));
            req.destroy();
            done();
          } else chunks.push(c);
        });
        const done = () =>
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', rawHeaders: res.rawHeaders, headers: res.headers, body: Buffer.concat(chunks), truncated });
        res.on('end', done);
        res.on('error', (e) => (truncated ? undefined : reject(e)));
      }
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`${Math.round(opts.timeoutMs / 1000)}초 안에 응답이 없습니다`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 오류를 사람이 읽을 말로 */
export function explainError(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  const code = err?.code ?? err?.cause?.code ?? '';
  const table: Record<string, string> = {
    ECONNREFUSED: '연결이 거부됐습니다. 서버가 떠 있는지, 포트가 맞는지 확인하세요',
    ENOTFOUND: '주소를 찾을 수 없습니다. 호스트 이름을 확인하세요',
    EAI_AGAIN: '주소를 찾을 수 없습니다. 호스트 이름과 네트워크를 확인하세요',
    ECONNRESET: '서버가 연결을 끊었습니다',
    ETIMEDOUT: '연결 시간이 지났습니다',
    EHOSTUNREACH: '서버에 닿을 수 없습니다',
    ABORT_ERR: '취소했습니다',
    DEPTH_ZERO_SELF_SIGNED_CERT: '서버 인증서가 사설 인증서입니다. 설정 devBoost.apiConsole.insecureTls 를 켜면 받아들입니다',
    SELF_SIGNED_CERT_IN_CHAIN: '서버 인증서가 사설 인증서입니다. 설정 devBoost.apiConsole.insecureTls 를 켜면 받아들입니다',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '서버 인증서를 확인할 수 없습니다. 설정 devBoost.apiConsole.insecureTls 를 켜면 받아들입니다',
    CERT_HAS_EXPIRED: '서버 인증서가 만료됐습니다',
    ERR_INVALID_URL: '주소 모양이 올바르지 않습니다',
  };
  if (err?.name === 'AbortError') return table.ABORT_ERR;
  return table[code] ? `${table[code]} (${code})` : err?.message || String(e);
}

export async function send(built: BuiltRequest, opts: SendOptions): Promise<SentResponse> {
  const started = Date.now();
  let url = new URL(built.url);
  let method = built.method;
  let body = built.body;
  const headers: Record<string, string> = { ...built.headers };
  const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (!has('accept')) headers['Accept'] = '*/*';
  if (!has('accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br';
  if (!has('user-agent')) headers['User-Agent'] = 'DevBoost-ApiConsole';
  const ownCookie = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
  const redirects: string[] = [];
  let sentHeaders: Record<string, string> = {};
  for (let hop = 0; ; hop++) {
    const h: Record<string, string> = { ...headers };
    if (body) h['Content-Length'] = String(body.length);
    const jarCookie = opts.jar?.header(url.toString()) ?? '';
    if (jarCookie) {
      // 직접 적은 Cookie 헤더가 있으면 그 뒤에 잇는다
      if (ownCookie) h[ownCookie] = `${h[ownCookie]}; ${jarCookie}`;
      else h['Cookie'] = jarCookie;
    }
    if (hop === 0) sentHeaders = h;
    const res = await once(method, url, h, body, opts);
    const setCookie = res.headers['set-cookie'];
    opts.jar?.store(url.toString(), setCookie);
    const location = res.headers.location;
    if (opts.followRedirects && [301, 302, 303, 307, 308].includes(res.status) && location && hop < 5) {
      const next = new URL(location, url);
      redirects.push(next.toString());
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        for (const k of Object.keys(headers)) if (/^content-(type|length)$/i.test(k)) delete headers[k];
      }
      // 다른 호스트로 넘어가면 인증 헤더는 보내지 않는다
      if (next.host !== url.host) for (const k of Object.keys(headers)) if (/^(authorization|cookie)$/i.test(k)) delete headers[k];
      url = next;
      continue;
    }
    const pairs: [string, string][] = [];
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
    return {
      status: res.status,
      statusText: res.statusText,
      headers: pairs,
      body: res.truncated ? res.body : decode(res.body, res.headers['content-encoding']),
      bytes: res.body.length,
      ms: Date.now() - started,
      url: url.toString(),
      redirects,
      truncated: res.truncated,
      sentHeaders,
    };
  }
}

/** 본문을 글로 보여 줄 수 있는가 (Content-Type 과 내용으로 판단) */
export function isText(contentType: string | undefined, body: Buffer): boolean {
  const t = (contentType ?? '').toLowerCase();
  if (/json|xml|text\/|javascript|html|x-www-form-urlencoded|yaml|csv/.test(t)) return true;
  if (/image\/|audio\/|video\/|octet-stream|zip|pdf|font\//.test(t)) return false;
  return !body.subarray(0, 2000).includes(0);
}

/** Content-Type 의 charset (없으면 utf-8) */
export function charsetOf(contentType: string | undefined): string {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '');
  return m ? m[1].toLowerCase() : 'utf-8';
}

export function decodeText(body: Buffer, contentType: string | undefined): string {
  const cs = charsetOf(contentType);
  try {
    return new TextDecoder(cs === 'ks_c_5601-1987' ? 'euc-kr' : cs).decode(body);
  } catch {
    return body.toString('utf8');
  }
}
