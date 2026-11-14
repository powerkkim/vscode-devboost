/**
 * API 콘솔의 자료 모양과 계산: 변수 채우기, URL·헤더·본문 만들기, cURL 읽기/쓰기, Postman 모음 읽기/쓰기, 쿠키.
 * vscode 모듈에 의존하지 않아 단독 테스트가 가능하다.
 */

export interface KeyValue {
  key: string;
  value: string;
  /** 꺼 둔 줄은 보내지 않는다 */
  enabled: boolean;
  /** multipart 에서 파일 줄이면 value 는 파일 경로 */
  file?: boolean;
}

export type BodyMode = 'none' | 'json' | 'text' | 'form' | 'multipart';
export type AuthType = 'none' | 'bearer' | 'basic';

export interface ApiRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  bodyMode: BodyMode;
  /** json · text 본문 */
  bodyText: string;
  /** form · multipart 본문 */
  bodyForm: KeyValue[];
  auth: { type: AuthType; token?: string; username?: string; password?: string };
  /** 이 API 가 무엇인지 적어 두는 메모 */
  note: string;
  /** 예시로 남겨 둔 응답 */
  example?: { status: number; body: string; savedAt: number };
  /** 주소의 {id} 자리에 넣을 값 (이름은 주소에서 나온다) */
  pathVars?: KeyValue[];
  /** Controller 에서 만든 요청이면 "클래스#메서드" — 같은 것을 두 번 만들지 않으려고 */
  origin?: string;
  /** 응답이 오면 환경 변수로 저장할 값: key 는 변수 이름, value 는 응답에서의 위치 (data.items[0].id, @header.X-Token) */
  extract?: KeyValue[];
}

export interface ApiFolder {
  id: string;
  name: string;
  /** 접힘 */
  collapsed?: boolean;
  items: ApiNode[];
}

export type ApiNode = ({ kind: 'folder' } & ApiFolder) | ({ kind: 'request' } & ApiRequest);

export interface ApiEnvironment {
  id: string;
  name: string;
  variables: KeyValue[];
  /** 보내기 전에 확인 (운영처럼 되돌릴 수 없는 곳) */
  confirm?: boolean;
}

export interface HistoryEntry {
  at: number;
  method: string;
  url: string;
  status: number;
  ms: number;
  /** 다시 열 수 있게 요청을 통째로 */
  request: ApiRequest;
  environment?: string;
}

export interface ApiData {
  version: 1;
  /** 맨 위는 모음(폴더)들 */
  collections: ApiNode[];
  environments: ApiEnvironment[];
  activeEnvironment?: string;
  history: HistoryEntry[];
}

export const HISTORY_MAX = 50;

let seq = 0;
export function newId(): string {
  return Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
}

export function emptyRequest(name = '새 요청'): ApiRequest {
  return { id: newId(), name, method: 'GET', url: '', params: [], headers: [], bodyMode: 'none', bodyText: '', bodyForm: [], auth: { type: 'none' }, note: '' };
}

export function emptyData(): ApiData {
  return { version: 1, collections: [], environments: [], history: [] };
}

/** 저장 파일을 읽어 모양을 맞춘다 (없는 칸은 기본값으로, 알 수 없는 것은 버린다) */
export function normalizeData(raw: unknown): ApiData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<ApiData>;
  const kv = (x: unknown): KeyValue[] =>
    Array.isArray(x)
      ? x.filter((r) => r && typeof r === 'object').map((r) => ({ key: String(r.key ?? ''), value: String(r.value ?? ''), enabled: r.enabled !== false, ...(r.file ? { file: true } : {}) }))
      : [];
  const req = (r: Partial<ApiRequest>): ApiRequest => ({
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    name: String(r.name ?? '요청'),
    method: String(r.method ?? 'GET').toUpperCase(),
    url: String(r.url ?? ''),
    params: kv(r.params),
    headers: kv(r.headers),
    bodyMode: (['none', 'json', 'text', 'form', 'multipart'] as BodyMode[]).includes(r.bodyMode as BodyMode) ? (r.bodyMode as BodyMode) : 'none',
    bodyText: String(r.bodyText ?? ''),
    bodyForm: kv(r.bodyForm),
    auth: {
      type: (['none', 'bearer', 'basic'] as AuthType[]).includes(r.auth?.type as AuthType) ? (r.auth!.type as AuthType) : 'none',
      token: r.auth?.token,
      username: r.auth?.username,
      password: r.auth?.password,
    },
    note: String(r.note ?? ''),
    ...(r.example && typeof r.example === 'object' ? { example: { status: Number(r.example.status) || 0, body: String(r.example.body ?? ''), savedAt: Number(r.example.savedAt) || 0 } } : {}),
    ...(Array.isArray(r.pathVars) && r.pathVars.length ? { pathVars: kv(r.pathVars) } : {}),
    ...(typeof r.origin === 'string' && r.origin ? { origin: r.origin } : {}),
    ...(Array.isArray(r.extract) && r.extract.length ? { extract: kv(r.extract) } : {}),
  });
  const node = (n: unknown): ApiNode | undefined => {
    if (!n || typeof n !== 'object') return undefined;
    const x = n as Partial<ApiNode> & { items?: unknown };
    if (x.kind === 'folder') {
      return {
        kind: 'folder',
        id: typeof x.id === 'string' && x.id ? x.id : newId(),
        name: String(x.name ?? '폴더'),
        ...(x.collapsed ? { collapsed: true } : {}),
        items: (Array.isArray(x.items) ? x.items : []).map(node).filter((v): v is ApiNode => !!v),
      };
    }
    if (x.kind === 'request') return { kind: 'request', ...req(x as Partial<ApiRequest>) };
    return undefined;
  };
  return {
    version: 1,
    collections: (Array.isArray(d.collections) ? d.collections : []).map(node).filter((v): v is ApiNode => !!v),
    environments: (Array.isArray(d.environments) ? d.environments : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ id: typeof e.id === 'string' && e.id ? e.id : newId(), name: String(e.name ?? '환경'), variables: kv(e.variables), ...(e.confirm ? { confirm: true } : {}) })),
    ...(typeof d.activeEnvironment === 'string' ? { activeEnvironment: d.activeEnvironment } : {}),
    history: (Array.isArray(d.history) ? d.history : [])
      .filter((h) => h && typeof h === 'object' && h.request)
      .slice(0, HISTORY_MAX)
      .map((h) => ({ at: Number(h.at) || 0, method: String(h.method ?? ''), url: String(h.url ?? ''), status: Number(h.status) || 0, ms: Number(h.ms) || 0, request: req(h.request), environment: h.environment })),
  };
}

/* ------------------------------------------------------------------ 변수 */

export type Variables = Record<string, string>;

export function variablesOf(env: ApiEnvironment | undefined): Variables {
  const out: Variables = {};
  for (const v of env?.variables ?? []) if (v.enabled && v.key.trim()) out[v.key.trim()] = v.value;
  return out;
}

/** {{이름}} 을 값으로. 값 안의 {{…}} 도 한 번 더 푼다 (서로를 가리켜도 5번에서 멈춤). 없는 변수는 그대로 두고 missing 에 적는다 */
export function fill(text: string, vars: Variables, missing?: Set<string>): string {
  let out = text;
  for (let i = 0; i < 5 && out.includes('{{'); i++) {
    let changed = false;
    out = out.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, name: string) => {
      if (name in vars) {
        changed = true;
        return vars[name];
      }
      missing?.add(name);
      return all;
    });
    if (!changed) break;
  }
  return out;
}

/**
 * 응답에서 값 하나를 꺼낸다. 위치는 data.items[0].id 처럼 점과 [번호]로, 이름에 점이 있으면 ["a.b"] 로.
 * @header.이름 은 응답 헤더. 없으면 undefined. 객체 · 배열은 JSON 글로 돌려준다.
 */
export function pickValue(json: unknown, headers: [string, string][], where: string): string | undefined {
  const w = where.trim();
  if (!w) return undefined;
  const head = w.match(/^@header\.(.+)$/i);
  if (head) return headers.find(([k]) => k.toLowerCase() === head[1].trim().toLowerCase())?.[1];
  let cur: unknown = json;
  const re = /\[\s*(\d+)\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\.?([^.[\]]+)/g;
  let at = 0;
  for (let m = re.exec(w); m; m = re.exec(w)) {
    if (m.index !== at) return undefined; // 읽을 수 없는 모양
    at = re.lastIndex;
    if (cur === null || typeof cur !== 'object') return undefined;
    if (m[1] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[1])] : undefined;
    else cur = (cur as Record<string, unknown>)[m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim()];
  }
  if (at !== w.length || cur === undefined || cur === null) return undefined;
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

/** 주소에서 호스트 앞부분({{baseUrl}} 이나 http://host)을 뗀 경로 조각들. ? 뒤는 버린다 */
export function pathPartsOf(url: string): string[] {
  return url
    .split(/[?#]/)[0]
    .replace(/^\{\{[^}]*\}\}/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .split('/')
    .filter(Boolean);
}

/**
 * 요청의 주소 틀(…/users/{id})이 실제 호출의 경로(…/users/7)와 맞는가. 뒤에서부터 맞춘다 (context-path · 프록시 차이를 넘기려고).
 * 맞으면 경로 값과 "글자 그대로 맞은 조각 수"를 돌려준다.
 */
export function matchTemplate(template: string, actualUrl: string): { vars: Record<string, string>; fixed: number } | undefined {
  const t = pathPartsOf(template);
  const a = pathPartsOf(actualUrl);
  if (!t.length || t.length > a.length) return undefined;
  const vars: Record<string, string> = {};
  let fixed = 0;
  for (let i = 1; i <= t.length; i++) {
    const seg = t[t.length - i];
    const val = a[a.length - i];
    const name = seg.match(/^\{([A-Za-z_][\w.-]*)(?::[^{}]*)?\}$/)?.[1];
    if (name) {
      try {
        vars[name] = decodeURIComponent(val);
      } catch {
        vars[name] = val;
      }
    } else if (/\{\{/.test(seg)) {
      // 변수가 든 조각은 무엇이든 맞는 것으로
    } else if (seg === val) fixed++;
    else return undefined;
  }
  return fixed ? { vars, fixed } : undefined;
}

/* ------------------------------------------------------------------ 요청 만들기 */

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** 채우지 못한 변수 이름 */
  missing: string[];
  /** 값이 비어 있는 경로 자리 이름 ({id}) */
  missingPath: string[];
}

/** 주소의 {id} · {id:[0-9]+} 자리 (Spring 의 경로 변수 모양). {{변수}} 는 아니다 */
const PATH_VAR = /(?<!\{)\{([A-Za-z_][\w.-]*)(?::[^{}]*)?\}(?!\})/g;

/** 주소에 나온 경로 자리 이름 (나온 순서, 겹치면 한 번) */
export function pathNames(url: string): string[] {
  const head = url.split(/[?#]/)[0];
  const out: string[] = [];
  for (const m of head.matchAll(PATH_VAR)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** 주소가 바뀌었을 때 경로 값 표를 맞춘다: 있는 이름의 값은 두고, 새 이름은 빈 값으로, 사라진 이름은 뺀다 */
export function syncPathVars(url: string, rows: KeyValue[] | undefined): KeyValue[] {
  return pathNames(url).map((name) => rows?.find((r) => r.key === name) ?? { key: name, value: '', enabled: true });
}

/** {id} 자리에 값을 넣는다. 값이 없는 자리는 그대로 두고 missing 에 적는다 */
export function fillPath(url: string, rows: KeyValue[] | undefined, vars: Variables, missingVars?: Set<string>, missingPath?: Set<string>): string {
  const cut = url.search(/[?#]/);
  const head = cut < 0 ? url : url.slice(0, cut);
  const tail = cut < 0 ? '' : url.slice(cut);
  return (
    head.replace(PATH_VAR, (all, name: string) => {
      const row = rows?.find((r) => r.key === name);
      const value = row ? fill(row.value, vars, missingVars).trim() : '';
      if (!value) {
        missingPath?.add(name);
        return all;
      }
      return encodeURIComponent(value);
    }) + tail
  );
}

export interface FileReader {
  (path: string): Buffer;
}

const hasHeader = (h: Record<string, string>, name: string) => Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());

/** URL 의 ? 뒤에 켜 둔 파라미터를 붙인다 (URL 에 이미 있는 것은 그대로 둔다) */
export function buildUrl(url: string, params: KeyValue[], vars: Variables, missing?: Set<string>): string {
  let u = fill(url.trim(), vars, missing);
  if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  const extra = params
    .filter((p) => p.enabled && p.key.trim())
    .map((p) => encodeURIComponent(fill(p.key.trim(), vars, missing)) + '=' + encodeURIComponent(fill(p.value, vars, missing)));
  if (!extra.length) return u;
  const hash = u.indexOf('#');
  const head = hash < 0 ? u : u.slice(0, hash);
  const tail = hash < 0 ? '' : u.slice(hash);
  return head + (head.includes('?') ? (/[?&]$/.test(head) ? '' : '&') : '?') + extra.join('&') + tail;
}

/** multipart/form-data 본문 */
export function buildMultipart(rows: { key: string; value: string; file?: boolean }[], boundary: string, readFile: FileReader): Buffer {
  const parts: Buffer[] = [];
  const esc = (s: string) => s.replace(/"/g, '%22').replace(/\r?\n/g, ' ');
  for (const r of rows) {
    if (r.file) {
      const name = r.value.replace(/\\/g, '/').split('/').pop() || 'file';
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(r.key)}"; filename="${esc(name)}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      parts.push(readFile(r.value));
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(r.key)}"\r\n\r\n${r.value}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/** 화면의 요청 → 실제로 보낼 것 (변수 채움, 인증·본문 헤더 붙임) */
export function buildRequest(req: ApiRequest, vars: Variables, readFile: FileReader, boundary = '----DevBoost' + newId()): BuiltRequest {
  const missing = new Set<string>();
  const f = (s: string) => fill(s, vars, missing);
  const headers: Record<string, string> = {};
  for (const h of req.headers) {
    if (h.enabled && h.key.trim()) headers[f(h.key.trim())] = f(h.value);
  }
  if (req.auth.type === 'bearer' && req.auth.token && !hasHeader(headers, 'authorization')) {
    headers['Authorization'] = 'Bearer ' + f(req.auth.token).replace(/^Bearer\s+/i, '');
  } else if (req.auth.type === 'basic' && !hasHeader(headers, 'authorization')) {
    headers['Authorization'] = 'Basic ' + Buffer.from(f(req.auth.username ?? '') + ':' + f(req.auth.password ?? '')).toString('base64');
  }
  const method = (req.method || 'GET').toUpperCase();
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.bodyMode === 'json' || req.bodyMode === 'text') {
      const text = f(req.bodyText);
      if (text.length) {
        body = Buffer.from(text, 'utf8');
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = req.bodyMode === 'json' ? 'application/json' : 'text/plain; charset=utf-8';
      }
    } else if (req.bodyMode === 'form') {
      const rows = req.bodyForm.filter((r) => r.enabled && r.key.trim());
      body = Buffer.from(rows.map((r) => encodeURIComponent(f(r.key.trim())) + '=' + encodeURIComponent(f(r.value))).join('&'), 'utf8');
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (req.bodyMode === 'multipart') {
      const rows = req.bodyForm.filter((r) => r.enabled && r.key.trim()).map((r) => ({ key: f(r.key.trim()), value: f(r.value), file: r.file }));
      body = buildMultipart(rows, boundary, readFile);
      // 경계 값이 들어가야 하므로 직접 적은 Content-Type 은 바꿔 넣는다
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
      headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
    }
  }
  const missingPath = new Set<string>();
  const url = buildUrl(fillPath(req.url, req.pathVars, vars, missing, missingPath), req.params, vars, missing);
  return { method, url, headers, body, missing: [...missing], missingPath: [...missingPath] };
}

/* ------------------------------------------------------------------ cURL */

/** 셸 한 줄을 낱말로 (작은·큰 따옴표, $'…', 줄 끝의 \ 와 ^ 이어 쓰기) */
export function shellSplit(cmd: string): string[] {
  const s = cmd.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      const ansi = c === '$';
      if (ansi) i++;
      has = true;
      i++;
      while (i < s.length && s[i] !== "'") {
        if (ansi && s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else cur += s[i];
        i++;
      }
    } else if (c === '"') {
      has = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) i++;
        else if (s[i] === '^' && s[i + 1] === '"') i++; // cmd 의 ^"
        cur += s[i];
        i++;
      }
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

const pairs = (text: string): KeyValue[] =>
  text
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      const dec = (x: string) => {
        try {
          return decodeURIComponent(x.replace(/\+/g, ' '));
        } catch {
          return x;
        }
      };
      return { key: dec(i < 0 ? p : p.slice(0, i)), value: i < 0 ? '' : dec(p.slice(i + 1)), enabled: true };
    });

/** URL 의 ? 뒤를 파라미터 표로 떼어 낸다 ({{변수}} 가 있어도 글 그대로 다룬다) */
export function splitUrl(url: string): { url: string; params: KeyValue[] } {
  const hash = url.indexOf('#');
  const head = hash < 0 ? url : url.slice(0, hash);
  const q = head.indexOf('?');
  if (q < 0) return { url, params: [] };
  return { url: head.slice(0, q) + (hash < 0 ? '' : url.slice(hash)), params: pairs(head.slice(q + 1)) };
}

/** cURL 명령(브라우저 개발자 도구의 "Copy as cURL" 포함) → 요청. cURL 이 아니면 undefined */
export function parseCurl(text: string): ApiRequest | undefined {
  const args = shellSplit(text.trim());
  if (!args.length || !/^curl(\.exe)?$/i.test(args[0])) return undefined;
  const req = emptyRequest('가져온 요청');
  let method = '';
  let url = '';
  const data: string[] = [];
  const form: KeyValue[] = [];
  let dataMode: 'data' | 'urlencode' | 'json' = 'data';
  let asQuery = false;
  const takes = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-F', '--form', '--form-string', '-u', '--user', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '--url', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--cacert', '--cert', '--key', '-w', '--write-out', '--retry', '-c', '--cookie-jar', '--resolve']);
  for (let i = 1; i < args.length; i++) {
    let a = args[i];
    let v: string | undefined;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (/^-[A-Za-z]./.test(a) && !a.startsWith('--') && takes.has(a.slice(0, 2))) {
      v = a.slice(2); // -XPOST, -H'…'
      a = a.slice(0, 2);
    }
    if (!a.startsWith('-')) {
      if (!url) url = a;
      continue;
    }
    if (takes.has(a) && v === undefined) v = args[++i] ?? '';
    switch (a) {
      case '-X':
      case '--request':
        method = v!.toUpperCase();
        break;
      case '--url':
        url = v!;
        break;
      case '-H':
      case '--header': {
        const c = v!.indexOf(':');
        if (c > 0) req.headers.push({ key: v!.slice(0, c).trim(), value: v!.slice(c + 1).trim(), enabled: true });
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
        data.push(v!);
        break;
      case '--data-urlencode':
        data.push(v!);
        dataMode = 'urlencode';
        break;
      case '--json':
        data.push(v!);
        dataMode = 'json';
        break;
      case '-F':
      case '--form':
      case '--form-string': {
        const c = v!.indexOf('=');
        const key = c < 0 ? v! : v!.slice(0, c);
        const val = c < 0 ? '' : v!.slice(c + 1);
        const isFile = a !== '--form-string' && /^[@<]/.test(val);
        form.push({ key, value: isFile ? val.slice(1).replace(/;.*$/, '') : val, enabled: true, ...(isFile ? { file: true } : {}) });
        break;
      }
      case '-u':
      case '--user': {
        const c = v!.indexOf(':');
        req.auth = { type: 'basic', username: c < 0 ? v! : v!.slice(0, c), password: c < 0 ? '' : v!.slice(c + 1) };
        break;
      }
      case '-b':
      case '--cookie':
        if (v!.includes('=')) req.headers.push({ key: 'Cookie', value: v!, enabled: true });
        break;
      case '-A':
      case '--user-agent':
        req.headers.push({ key: 'User-Agent', value: v!, enabled: true });
        break;
      case '-e':
      case '--referer':
        req.headers.push({ key: 'Referer', value: v!, enabled: true });
        break;
      case '-G':
      case '--get':
        asQuery = true;
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      default:
        break; // --compressed, -s, -k, -L … 은 요청 내용과 무관
    }
  }
  if (!url) return undefined;
  const bearer = req.headers.findIndex((h) => h.key.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(h.value));
  if (bearer >= 0 && req.auth.type === 'none') {
    req.auth = { type: 'bearer', token: req.headers[bearer].value.replace(/^Bearer\s+/i, '') };
    req.headers.splice(bearer, 1);
  }
  const split = splitUrl(url);
  req.url = split.url;
  req.params = split.params;
  const ctype = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (form.length) {
    req.bodyMode = 'multipart';
    req.bodyForm = form;
    req.headers = req.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
  } else if (data.length) {
    const joined = data.join('&');
    if (asQuery) {
      req.params.push(...pairs(joined));
    } else if (dataMode === 'json' || ctype.includes('json') || /^\s*[[{]/.test(joined)) {
      req.bodyMode = 'json';
      req.bodyText = prettyJson(data.join(''));
      if (dataMode === 'json' && !ctype) req.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
    } else if (dataMode === 'urlencode' || ctype.includes('x-www-form-urlencoded') || (!ctype && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined))) {
      req.bodyMode = 'form';
      req.bodyForm = pairs(joined);
    } else {
      req.bodyMode = 'text';
      req.bodyText = joined;
    }
  }
  req.method = method || (asQuery ? 'GET' : data.length || form.length ? 'POST' : 'GET');
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(req.url) ? req.url : 'http://' + req.url);
    req.name = `${u.pathname.replace(/\/$/, '') || '/'}`;
  } catch {
    // 변수가 든 URL 등: 이름은 기본값
  }
  return req;
}

/** JSON 이면 보기 좋게, 아니면 그대로 */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 실제로 보낼 요청 → cURL 한 줄씩 (bash 따옴표) */
export function toCurl(built: BuiltRequest, form?: { key: string; value: string; file?: boolean }[]): string {
  const q = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";
  const lines = [`curl -X ${built.method} ${q(built.url)}`];
  for (const [k, v] of Object.entries(built.headers)) {
    if (form && k.toLowerCase() === 'content-type') continue; // multipart 는 curl 이 경계를 정한다
    lines.push(`-H ${q(`${k}: ${v}`)}`);
  }
  if (form) for (const r of form) lines.push(`-F ${q(`${r.key}=${r.file ? '@' : ''}${r.value}`)}`);
  else if (built.body) lines.push(`--data-raw ${q(built.body.toString('utf8'))}`);
  return lines.join(' \\\n  ');
}

/* ------------------------------------------------------------------ Postman 모음 */

interface PmKv {
  key?: string;
  value?: unknown;
  disabled?: boolean;
  type?: string;
  src?: unknown;
}

const pmKv = (rows: unknown): KeyValue[] =>
  (Array.isArray(rows) ? (rows as PmKv[]) : [])
    .filter((r) => r && typeof r === 'object' && r.key !== undefined)
    .map((r) => ({
      key: String(r.key ?? ''),
      value: r.type === 'file' ? String(Array.isArray(r.src) ? r.src[0] ?? '' : r.src ?? '') : String(r.value ?? ''),
      enabled: !r.disabled,
      ...(r.type === 'file' ? { file: true } : {}),
    }));

function pmRequest(name: string, r: Record<string, unknown>): ApiRequest {
  const req = emptyRequest(name);
  req.method = String(r.method ?? 'GET').toUpperCase();
  const u = r.url as unknown;
  const raw = typeof u === 'string' ? u : String((u as { raw?: string })?.raw ?? '');
  const split = splitUrl(raw);
  req.url = split.url;
  const query = typeof u === 'object' && u ? pmKv((u as { query?: unknown }).query) : [];
  req.params = query.length ? query : split.params;
  req.headers = pmKv(r.header);
  req.note = typeof r.description === 'string' ? r.description : String((r.description as { content?: string })?.content ?? '');
  const b = r.body as { mode?: string; raw?: string; urlencoded?: unknown; formdata?: unknown; options?: { raw?: { language?: string } } } | undefined;
  if (b?.mode === 'raw' && b.raw !== undefined) {
    const json = b.options?.raw?.language === 'json' || req.headers.some((h) => h.key.toLowerCase() === 'content-type' && /json/i.test(h.value)) || /^\s*[[{]/.test(b.raw);
    req.bodyMode = json ? 'json' : 'text';
    req.bodyText = b.raw;
  } else if (b?.mode === 'urlencoded') {
    req.bodyMode = 'form';
    req.bodyForm = pmKv(b.urlencoded);
  } else if (b?.mode === 'formdata') {
    req.bodyMode = 'multipart';
    req.bodyForm = pmKv(b.formdata);
  }
  const a = r.auth as { type?: string; bearer?: PmKv[]; basic?: PmKv[] } | undefined;
  const pick = (rows: PmKv[] | undefined, key: string) => String((rows ?? []).find((x) => x.key === key)?.value ?? '');
  if (a?.type === 'bearer') req.auth = { type: 'bearer', token: pick(a.bearer, 'token') };
  else if (a?.type === 'basic') req.auth = { type: 'basic', username: pick(a.basic, 'username'), password: pick(a.basic, 'password') };
  return req;
}

function pmItems(items: unknown): ApiNode[] {
  const out: ApiNode[] = [];
  for (const it of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name ?? '');
    if (Array.isArray(it.item)) out.push({ kind: 'folder', id: newId(), name: name || '폴더', items: pmItems(it.item) });
    else if (it.request) out.push({ kind: 'request', ...pmRequest(name || '요청', typeof it.request === 'string' ? { url: it.request } : (it.request as Record<string, unknown>)) });
  }
  return out;
}

export interface Imported {
  collections: ApiNode[];
  environments: ApiEnvironment[];
}

/** 가져오기: DevBoost 가 내보낸 파일, Postman 모음(v2.x), Postman 환경 파일. 알 수 없는 모양이면 undefined */
export function importJson(text: string): Imported | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  if (j.devBoostApi === 1) {
    const d = normalizeData({ collections: j.collections, environments: j.environments });
    return { collections: reId(d.collections), environments: d.environments.map((e) => ({ ...e, id: newId() })) };
  }
  const info = j.info as { name?: string; schema?: string } | undefined;
  if (info && Array.isArray(j.item)) {
    const vars = pmKv(j.variable);
    return {
      collections: [{ kind: 'folder', id: newId(), name: String(info.name ?? '가져온 모음'), items: pmItems(j.item) }],
      environments: vars.length ? [{ id: newId(), name: `${info.name ?? '모음'} 변수`, variables: vars }] : [],
    };
  }
  if (Array.isArray(j.values) && typeof j.name === 'string') {
    const values = (j.values as { key?: string; value?: unknown; enabled?: boolean }[]).map((v) => ({ key: String(v.key ?? ''), value: String(v.value ?? ''), enabled: v.enabled !== false }));
    return { collections: [], environments: [{ id: newId(), name: j.name, variables: values }] };
  }
  return undefined;
}

/** 가져온 것은 id 를 새로 매긴다 (같은 파일을 두 번 가져와도 겹치지 않게) */
function reId(nodes: ApiNode[]): ApiNode[] {
  return nodes.map((n) => (n.kind === 'folder' ? { ...n, id: newId(), items: reId(n.items) } : { ...n, id: newId() }));
}

/** 내보내기 파일. 환경 변수 값은 넣지 않는다 (토큰·비밀번호가 파일로 나가지 않게) — 이름만 */
export function exportJson(nodes: ApiNode[], environments: ApiEnvironment[]): string {
  return JSON.stringify(
    {
      devBoostApi: 1,
      exportedAt: new Date().toISOString(),
      collections: nodes,
      environments: environments.map((e) => ({ ...e, variables: e.variables.map((v) => ({ ...v, value: '' })) })),
    },
    null,
    2
  );
}

/* ------------------------------------------------------------------ 쿠키 */

interface Cookie {
  name: string;
  value: string;
  domain: string;
  /** Domain 속성이 없던 쿠키는 그 호스트에만 */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires?: number;
}

/** 요청 사이에 쿠키(세션)를 이어 주는 통. 메모리에만 둔다 */
export class CookieJar {
  private cookies: Cookie[] = [];

  /** 응답의 Set-Cookie 들을 넣는다 */
  store(url: string, setCookie: string[] | undefined, now = Date.now()) {
    if (!setCookie?.length) return;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    for (const line of setCookie) {
      const parts = line.split(';');
      const eq = parts[0].indexOf('=');
      if (eq <= 0) continue;
      const c: Cookie = { name: parts[0].slice(0, eq).trim(), value: parts[0].slice(eq + 1).trim(), domain: u.hostname.toLowerCase(), hostOnly: true, path: u.pathname.replace(/\/[^/]*$/, '') || '/', secure: false };
      let dead = false;
      for (const p of parts.slice(1)) {
        const i = p.indexOf('=');
        const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : p.slice(i + 1).trim();
        if (k === 'domain' && v) {
          c.domain = v.replace(/^\./, '').toLowerCase();
          c.hostOnly = false;
        } else if (k === 'path' && v.startsWith('/')) c.path = v;
        else if (k === 'secure') c.secure = true;
        else if (k === 'max-age' && /^-?\d+$/.test(v)) {
          const n = Number(v);
          if (n <= 0) dead = true;
          else c.expires = now + n * 1000;
        } else if (k === 'expires' && c.expires === undefined) {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) {
            if (t <= now) dead = true;
            else c.expires = t;
          }
        }
      }
      // 다른 도메인의 쿠키를 심으려는 것은 받지 않는다
      const host = u.hostname.toLowerCase();
      if (!c.hostOnly && host !== c.domain && !host.endsWith('.' + c.domain)) continue;
      this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
      if (!dead) this.cookies.push(c);
    }
  }

  /** 이 URL 로 보낼 Cookie 헤더 값 (없으면 '') */
  header(url: string, now = Date.now()): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return '';
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)))
      .filter((c) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/')
      .filter((c) => !c.secure || u.protocol === 'https:')
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /**
   * 브라우저가 보낸 Cookie 헤더("a=1; b=2")를 그 호스트의 쿠키로 받아 둔다 (브라우저의 로그인 상태를 이어받기).
   * 속성(경로·만료)은 알 수 없으므로 그 호스트의 모든 경로에 보낸다. 바뀐 개수를 돌려준다.
   */
  absorb(url: string, cookieHeader: string): number {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return 0;
    }
    const domain = u.hostname.toLowerCase();
    let changed = 0;
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) continue;
      const old = this.cookies.find((c) => c.name === name && c.domain === domain && c.path === '/');
      if (old) {
        if (old.value !== value) {
          old.value = value;
          changed++;
        }
      } else {
        this.cookies.push({ name, value, domain, hostOnly: true, path: '/', secure: false });
        changed++;
      }
    }
    return changed;
  }

  count(): number {
    return this.cookies.length;
  }

  clear() {
    this.cookies = [];
  }
}

/* ------------------------------------------------------------------ 모음 다루기 */

export function findNode(nodes: ApiNode[], id: string): { node: ApiNode; parent: ApiNode[]; index: number } | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent: nodes, index: i };
    if (n.kind === 'folder') {
      const hit = findNode(n.items, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 통째로 복제 (id 는 새로) */
export function cloneNode(n: ApiNode): ApiNode {
  const copy = JSON.parse(JSON.stringify(n)) as ApiNode;
  const walk = (x: ApiNode) => {
    x.id = newId();
    if (x.kind === 'folder') x.items.forEach(walk);
  };
  walk(copy);
  return copy;
}

/** 옮기기: id 를 target 폴더 안(끝)이나 target 요청 바로 앞으로. 자기 안으로는 옮기지 않는다 */
export function moveNode(nodes: ApiNode[], id: string, targetId: string | undefined, into: boolean): boolean {
  const src = findNode(nodes, id);
  if (!src || id === targetId) return false;
  if (targetId && src.node.kind === 'folder' && findNode(src.node.items, targetId)) return false;
  src.parent.splice(src.index, 1);
  if (!targetId) {
    nodes.push(src.node);
    return true;
  }
  const dst = findNode(nodes, targetId);
  if (!dst) {
    nodes.push(src.node);
    return true;
  }
  if (into && dst.node.kind === 'folder') dst.node.items.push(src.node);
  else dst.parent.splice(dst.index, 0, src.node);
  return true;
}
