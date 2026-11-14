import { ApiRequest, KeyValue, emptyRequest, prettyJson, splitUrl } from './model';

/**
 * 브라우저 캡처의 자료와 계산: 네트워크 이벤트를 호출 한 건씩으로 모으기, HAR 읽기,
 * 캡처한 호출 → 요청, 인증에 쓰인 헤더 고르기. vscode · 브라우저에 의존하지 않는다.
 */

export interface Captured {
  id: string;
  /** 시작 시각 (ms) */
  at: number;
  method: string;
  url: string;
  /** xhr · fetch · document … (소문자) */
  type: string;
  reqHeaders: [string, string][];
  reqBody?: string;
  status?: number;
  statusText?: string;
  resHeaders?: [string, string][];
  mime?: string;
  resBody?: string;
  /** resBody 가 base64 (글이 아닌 응답) */
  resBase64?: boolean;
  /** 본문이 커서 받지 않음 */
  resSkipped?: boolean;
  ms?: number;
  size?: number;
  failed?: string;
  done: boolean;
}

/** 목록에 보여 줄 한 줄 */
export interface CapturedRow {
  id: string;
  at: number;
  method: string;
  url: string;
  type: string;
  status?: number;
  ms?: number;
  size?: number;
  failed?: string;
  done: boolean;
}

export const rowOf = (c: Captured): CapturedRow => ({ id: c.id, at: c.at, method: c.method, url: c.url, type: c.type, status: c.status, ms: c.ms, size: c.size, failed: c.failed, done: c.done });

const pairsOf = (h: unknown): [string, string][] => (h && typeof h === 'object' ? Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string]) : []);

/** 같은 이름은 뒤의 것으로 바꾸고, 없던 이름은 보탠다 (대소문자 무시) */
function mergeHeaders(base: [string, string][], over: [string, string][]): [string, string][] {
  const out = base.filter(([k]) => !over.some(([o]) => o.toLowerCase() === k.toLowerCase()));
  return out.concat(over);
}

export const headerOf = (headers: [string, string][] | undefined, name: string): string | undefined => headers?.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const KEEP_TYPES = new Set(['xhr', 'fetch']);

export interface CaptureEvent {
  /** 바뀐 호출의 id (목록을 고칠 것) */
  changed?: string;
  /** 본문을 받아 올 때가 된 호출 */
  finished?: { id: string; requestId: string; sessionId?: string };
  /** 요청 본문을 따로 받아 와야 하는 호출 */
  needPostData?: { id: string; requestId: string; sessionId?: string };
}

/**
 * 네트워크 이벤트(Chrome DevTools Protocol 의 Network.*)를 호출 한 건씩으로 모은다.
 * XHR · fetch 만 남긴다 (화면·그림·스크립트는 버린다). 최근 max 건만 둔다.
 */
export class CaptureStore {
  private list: Captured[] = [];
  private byKey = new Map<string, Captured>();
  /** requestWillBeSent 보다 먼저 온 추가 헤더 */
  private early = new Map<string, [string, string][]>();
  /** 같은 경우의 응답 쪽 추가 헤더 */
  private earlyRes = new Map<string, [string, string][]>();
  private startTs = new Map<string, number>();
  /** 방금 끝난 호출: 끝난 뒤에 오는 추가 헤더(Set-Cookie 등)를 붙이려고 잠깐 둔다 */
  private late = new Map<string, Captured>();
  private seq = 0;

  constructor(private readonly max = 300) {}

  rows(): CapturedRow[] {
    return this.list.map(rowOf);
  }
  get(id: string): Captured | undefined {
    return this.list.find((c) => c.id === id);
  }
  all(): Captured[] {
    return this.list;
  }
  clear() {
    this.list = [];
    this.byKey.clear();
    this.early.clear();
    this.earlyRes.clear();
    this.startTs.clear();
    this.late.clear();
  }

  private finish(key: string, c: Captured) {
    this.byKey.delete(key);
    this.startTs.delete(key);
    this.late.set(key, c);
    if (this.late.size > 100) this.late.delete(this.late.keys().next().value as string);
  }

  add(c: Omit<Captured, 'id'>): Captured {
    const entry: Captured = { ...c, id: `c${Date.now().toString(36)}${(this.seq++).toString(36)}` };
    this.list.unshift(entry);
    if (this.list.length > this.max) {
      const dropped = this.list.splice(this.max);
      for (const [k, v] of this.byKey) if (dropped.includes(v)) this.byKey.delete(k);
    }
    return entry;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent(method: string, p: any, sessionId?: string): CaptureEvent {
    const key = `${sessionId ?? ''}:${p?.requestId}`;
    switch (method) {
      case 'Network.requestWillBeSent': {
        const type = String(p.type ?? '').toLowerCase();
        const out: CaptureEvent = {};
        const prev = this.byKey.get(key);
        if (prev && p.redirectResponse) {
          // 같은 requestId 로 다시 오면 앞의 것은 리다이렉트 응답으로 끝난 것
          prev.status = p.redirectResponse.status;
          prev.statusText = p.redirectResponse.statusText;
          prev.resHeaders = pairsOf(p.redirectResponse.headers);
          prev.done = true;
          this.byKey.delete(key);
        }
        if (type && !KEEP_TYPES.has(type)) {
          this.early.delete(key);
          this.earlyRes.delete(key);
          return out;
        }
        if (!/^https?:/i.test(p.request?.url ?? '')) return out;
        const c = this.add({
          at: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(),
          method: String(p.request.method ?? 'GET').toUpperCase(),
          url: String(p.request.url) + (p.request.urlFragment ?? ''),
          type: type || 'xhr',
          reqHeaders: mergeHeaders(pairsOf(p.request.headers), this.early.get(key) ?? []),
          ...(typeof p.request.postData === 'string' ? { reqBody: p.request.postData } : {}),
          ...(this.earlyRes.has(key) ? { resHeaders: this.earlyRes.get(key) } : {}),
          done: false,
        });
        this.early.delete(key);
        this.earlyRes.delete(key);
        this.byKey.set(key, c);
        this.startTs.set(key, Number(p.timestamp) || 0);
        out.changed = c.id;
        if (p.request.hasPostData && typeof p.request.postData !== 'string') out.needPostData = { id: c.id, requestId: p.requestId, sessionId };
        return out;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        // 실제로 나간 헤더 (Cookie · Authorization 포함)
        const headers = pairsOf(p.headers).filter(([k]) => !k.startsWith(':'));
        const c = this.byKey.get(key) ?? this.late.get(key);
        if (!c) {
          this.early.set(key, headers);
          if (this.early.size > 200) this.early.delete(this.early.keys().next().value as string);
          return {};
        }
        c.reqHeaders = mergeHeaders(c.reqHeaders, headers);
        return { changed: c.id };
      }
      case 'Network.responseReceived': {
        const c = this.byKey.get(key);
        if (!c) return {};
        c.status = p.response?.status;
        c.statusText = p.response?.statusText ?? '';
        c.resHeaders = mergeHeaders(pairsOf(p.response?.headers), c.resHeaders ?? []);
        c.mime = p.response?.mimeType;
        return { changed: c.id };
      }
      case 'Network.responseReceivedExtraInfo': {
        const c = this.byKey.get(key) ?? this.late.get(key);
        if (!c) {
          this.earlyRes.set(key, pairsOf(p.headers));
          if (this.earlyRes.size > 200) this.earlyRes.delete(this.earlyRes.keys().next().value as string);
          return {};
        }
        c.resHeaders = mergeHeaders(c.resHeaders ?? [], pairsOf(p.headers));
        return { changed: c.id };
      }
      case 'Network.loadingFinished': {
        const c = this.byKey.get(key);
        if (!c) return {};
        c.done = true;
        c.size = Number(p.encodedDataLength) || 0;
        const start = this.startTs.get(key);
        if (start && p.timestamp) c.ms = Math.max(0, Math.round((p.timestamp - start) * 1000));
        this.finish(key, c);
        return { changed: c.id, finished: { id: c.id, requestId: p.requestId, sessionId } };
      }
      case 'Network.loadingFailed': {
        const c = this.byKey.get(key);
        if (!c) return {};
        c.done = true;
        c.failed = p.canceled ? '취소됨' : String(p.errorText ?? '실패');
        this.finish(key, c);
        return { changed: c.id };
      }
      default:
        return {};
    }
  }
}

/* ------------------------------------------------------------------ HAR */

/** 브라우저 개발자 도구에서 저장한 HAR 파일 → 호출들 (최근 것이 앞). HAR 이 아니면 undefined */
export function parseHar(text: string, onlyApi = true): Omit<Captured, 'id'>[] | undefined {
  let j: { log?: { entries?: unknown[] } };
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j?.log || !Array.isArray(j.log.entries)) return undefined;
  const nv = (rows: unknown): [string, string][] =>
    (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && r.name !== undefined && !String(r.name).startsWith(':')).map((r) => [String(r.name), String(r.value ?? '')] as [string, string]);
  const out: Omit<Captured, 'id'>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of j.log.entries as any[]) {
    const req = e?.request;
    const res = e?.response;
    if (!req?.url || !/^https?:/i.test(req.url)) continue;
    const type = String(e._resourceType ?? '').toLowerCase();
    const mime = String(res?.content?.mimeType ?? '');
    // 종류가 적혀 있으면 XHR · fetch 만, 없으면 응답 종류로 가린다 (JSON · 글 · 본문 없는 응답)
    const api = type ? KEEP_TYPES.has(type) : /json|text\/plain|xml/i.test(mime) || !mime || String(req.method).toUpperCase() !== 'GET';
    if (onlyApi && !api) continue;
    const post = req.postData;
    let reqBody: string | undefined;
    if (post && typeof post.text === 'string') reqBody = post.text;
    else if (post && Array.isArray(post.params)) reqBody = nv(post.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const body = res?.content?.text;
    out.push({
      at: Date.parse(e.startedDateTime) || 0,
      method: String(req.method ?? 'GET').toUpperCase(),
      url: String(req.url),
      type: type || 'xhr',
      reqHeaders: nv(req.headers),
      ...(reqBody !== undefined ? { reqBody } : {}),
      status: Number(res?.status) || 0,
      statusText: String(res?.statusText ?? ''),
      resHeaders: nv(res?.headers),
      mime,
      ...(typeof body === 'string' ? { resBody: body, ...(res.content.encoding === 'base64' ? { resBase64: true } : {}) } : {}),
      ms: Math.max(0, Math.round(Number(e.time) || 0)),
      size: Math.max(0, Number(res?.content?.size) || 0),
      done: true,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/* ------------------------------------------------------------------ 캡처 → 요청 */

/** 브라우저가 알아서 붙이는 헤더: 요청으로 옮길 때 뺀다 */
const BROWSER_HEADERS = /^(host|connection|content-length|accept-encoding|accept-language|user-agent|referer|origin|cookie|pragma|cache-control|upgrade-insecure-requests|priority|dnt|te|sec-.*|x-devtools-.*|if-none-match|if-modified-since)$/i;

/** 인증에 쓰이는 헤더 이름인가 (Authorization, X-Auth-Token, X-XSRF-TOKEN, X-API-KEY …) */
export function isAuthHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('sec-') || n === 'www-authenticate' || n === 'cookie' || n === 'set-cookie') return false;
  return n === 'authorization' || n === 'proxy-authorization' || /token|csrf|xsrf|api[-_]?key|^x-auth|^x-session|session-?id/.test(n);
}

/** 요청 헤더 중 인증에 쓰인 것 */
export function authHeadersOf(headers: [string, string][]): [string, string][] {
  return headers.filter(([k, v]) => isAuthHeader(k) && v.trim() !== '');
}

export interface ToRequestOptions {
  /** 이 주소로 시작하면 {{baseUrl}} 로 바꿔 적는다 */
  baseUrl?: string;
  /** 인증 헤더를 요청에 적지 않는다 (이어받기가 보낼 때 붙이므로) */
  dropAuth?: boolean;
}

/** 캡처한 호출 하나 → 요청 */
export function capturedToRequest(c: Captured, opts: ToRequestOptions = {}): ApiRequest {
  const req = emptyRequest('캡처한 요청');
  req.method = c.method;
  let url = c.url;
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  if (base && (url === base || url.startsWith(base + '/') || url.startsWith(base + '?'))) url = '{{baseUrl}}' + url.slice(base.length);
  const split = splitUrl(url);
  req.url = split.url;
  req.params = split.params;
  try {
    req.name = new URL(c.url).pathname.replace(/\/$/, '') || '/';
  } catch {
    // 이름은 기본값
  }
  const headers: KeyValue[] = [];
  for (const [k, v] of c.reqHeaders) {
    if (BROWSER_HEADERS.test(k) || k.startsWith(':')) continue;
    if (opts.dropAuth && isAuthHeader(k)) continue;
    if (k.toLowerCase() === 'accept' && v.trim() === '*/*') continue;
    headers.push({ key: k, value: v, enabled: true });
  }
  const bearer = headers.findIndex((h) => h.key.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(h.value));
  if (bearer >= 0) {
    req.auth = { type: 'bearer', token: headers[bearer].value.replace(/^Bearer\s+/i, '') };
    headers.splice(bearer, 1);
  }
  const ctype = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (c.reqBody !== undefined && c.reqBody !== '') {
    if (ctype.includes('json') || /^\s*[[{]/.test(c.reqBody)) {
      req.bodyMode = 'json';
      req.bodyText = prettyJson(c.reqBody);
    } else if (ctype.includes('x-www-form-urlencoded')) {
      req.bodyMode = 'form';
      req.bodyForm = splitUrl('?' + c.reqBody).params;
    } else {
      // multipart 는 경계가 든 원문 그대로는 다시 보낼 수 없어 글로 둔다
      req.bodyMode = 'text';
      req.bodyText = c.reqBody;
    }
  }
  // 본문 종류로 정해지는 Content-Type 은 표에서 뺀다 (multipart 원문은 경계 때문에 남긴다)
  req.headers = headers.filter((h) => !(h.key.toLowerCase() === 'content-type' && (req.bodyMode === 'json' || req.bodyMode === 'form' || req.bodyMode === 'none')));
  if (c.status) req.note = `브라우저에서 캡처: ${new Date(c.at).toLocaleString()} · ${c.status}${c.ms !== undefined ? ` · ${c.ms}ms` : ''}`;
  return req;
}

/* ------------------------------------------------------------------ 인증 이어받기 */

export interface FollowedHost {
  /** 헤더 이름(원래 대소문자) → 값 */
  headers: [string, string][];
  /** 마지막으로 본 Cookie 헤더 */
  cookie?: string;
  at: number;
}

/**
 * 브라우저에서 본 인증(토큰 헤더 · 쿠키)을 호스트 이름별로 기억해 두었다가, 같은 호스트로 보내는 요청에 붙인다.
 * 포트는 가리지 않는다 (화면 서버 localhost:5173 에서 본 토큰을 백엔드 localhost:8080 에도).
 */
export class AuthFollow {
  private hosts = new Map<string, FollowedHost>();

  /** 캡처한 요청 하나를 보고 기억을 고친다. 바뀌었으면 true */
  learn(url: string, reqHeaders: [string, string][], at = Date.now()): boolean {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    const auth = authHeadersOf(reqHeaders);
    const cookie = headerOf(reqHeaders, 'cookie');
    if (!auth.length && !cookie) return false;
    const cur = this.hosts.get(host) ?? { headers: [], at };
    let changed = false;
    for (const [k, v] of auth) {
      const i = cur.headers.findIndex(([n]) => n.toLowerCase() === k.toLowerCase());
      if (i < 0) {
        cur.headers.push([k, v]);
        changed = true;
      } else if (cur.headers[i][1] !== v) {
        cur.headers[i] = [cur.headers[i][0], v];
        changed = true;
      }
    }
    if (cookie && cookie !== cur.cookie) {
      cur.cookie = cookie;
      changed = true;
    }
    if (changed) {
      cur.at = at;
      this.hosts.set(host, cur);
    }
    return changed;
  }

  /** 이 주소로 보낼 때 붙일 헤더 */
  headersFor(url: string): [string, string][] {
    try {
      return this.hosts.get(new URL(url).hostname.toLowerCase())?.headers ?? [];
    } catch {
      return [];
    }
  }

  summary(): { host: string; headers: string[]; cookies: number; at: number }[] {
    return [...this.hosts.entries()].map(([host, f]) => ({ host, headers: f.headers.map(([k]) => k), cookies: f.cookie ? f.cookie.split(';').filter((x) => x.includes('=')).length : 0, at: f.at }));
  }

  entries(): [string, FollowedHost][] {
    return [...this.hosts.entries()];
  }

  clear() {
    this.hosts.clear();
  }

  toJSON(): string {
    return JSON.stringify([...this.hosts.entries()]);
  }

  load(text: string | undefined) {
    if (!text) return;
    try {
      const rows = JSON.parse(text) as [string, FollowedHost][];
      for (const [host, f] of rows) {
        if (typeof host === 'string' && f && Array.isArray(f.headers)) this.hosts.set(host, { headers: f.headers.filter((h) => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)]), ...(typeof f.cookie === 'string' ? { cookie: f.cookie } : {}), at: Number(f.at) || 0 });
      }
    } catch {
      // 읽을 수 없으면 비운 채로
    }
  }
}
