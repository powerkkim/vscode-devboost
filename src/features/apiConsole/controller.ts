import { Ann, JavaClass, JavaMethod, parseJava } from '../sourceAtlas/backend/javaParser';
import { MAPPING_ANN, readMapping } from '../sourceAtlas/backend/attach';
import { joinMapping } from '../sourceAtlas/backend/pathMatch';
import { ApiRequest, KeyValue, emptyRequest } from './model';

/**
 * Spring Controller 의 매핑 메서드 → API 콘솔 요청.
 * 주소(클래스 + 메서드 경로), 경로 값, 파라미터, 헤더, 본문(DTO 필드로 만든 JSON 뼈대)을 채운다.
 * vscode 모듈에 의존하지 않는다. 다른 파일의 DTO 는 resolve 로 받아 온다.
 */

export interface Endpoint {
  cls: JavaClass;
  method: JavaMethod;
  /** GET · POST … */
  http: string;
  /** 클래스 경로 + 메서드 경로. {id:[0-9]+} 는 {id} 로 */
  path: string;
  /** 요청 이름: 요약(@Operation) → 주석 첫 줄 → 메서드 이름 */
  title: string;
  /** "패키지.클래스#메서드(타입,타입)" */
  origin: string;
  /** 경로가 글자가 아니라 상수여서 읽지 못함 */
  pathUnknown: boolean;
}

export interface ResolveClass {
  /** 타입 이름(Outer.Inner 가능)으로 클래스를 찾는다. from 은 그 이름을 쓴 클래스 */
  (name: string, from: JavaClass): Promise<JavaClass | undefined> | JavaClass | undefined;
}

export interface ToRequestOptions {
  /** server.servlet.context-path */
  contextPath?: string;
  resolve?: ResolveClass;
  /** 날짜 예시에 쓸 오늘 (테스트용) */
  today?: Date;
}

const ann = (list: Ann[] | undefined, ...names: string[]) => list?.find((a) => names.includes(a.name));

/** 어노테이션 인자에서 키의 값을 글로 (value 는 키 없이 적은 것도). 문자열이면 따옴표를 벗긴다 */
export function annArg(a: Ann | undefined, ...keys: string[]): string | undefined {
  if (!a) return undefined;
  const parts: string[] = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < a.args.length; i++) {
    const c = a.args[i];
    if (c === '\\' && inStr) { cur += c + (a.args[++i] ?? ''); continue; }
    if (c === '"') inStr = !inStr;
    if (!inStr && '({['.includes(c)) depth++;
    if (!inStr && ')}]'.includes(c)) depth--;
    if (c === ',' && depth === 0 && !inStr) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const kv = p.match(/^\s*(\w+)\s*=([\s\S]*)$/);
    const key = kv ? kv[1] : 'value';
    if (!keys.includes(key)) continue;
    const val = (kv ? kv[2] : p).trim();
    const str = val.match(/^"((?:[^"\\]|\\.)*)"$/);
    return str ? str[1].replace(/\\(.)/g, '$1') : val;
  }
  return undefined;
}

/** {id:[0-9]{3}} · {*rest} → {id} · {rest} (중괄호가 겹친 정규식도) */
export function plainPath(path: string): string {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== '{') { out += path[i]; continue; }
    let depth = 0, j = i;
    for (; j < path.length; j++) {
      if (path[j] === '{') depth++;
      else if (path[j] === '}' && --depth === 0) break;
    }
    const inner = path.slice(i + 1, j);
    const name = (inner.match(/^\*?([A-Za-z_][\w.-]*)/) ?? [])[1];
    out += name ? `{${name}}` : path.slice(i, j + 1);
    i = j;
  }
  return out;
}

/** 메서드 선언 바로 위에 붙은 설명 주석의 첫 줄 */
function docTitle(lines: string[], startLine: number): string | undefined {
  let i = startLine - 2; // startLine 은 1부터
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0 || !/\*\/\s*$/.test(lines[i])) return undefined;
  const body: string[] = [];
  for (; i >= 0; i--) {
    body.unshift(lines[i]);
    if (/\/\*/.test(lines[i])) break;
  }
  for (const raw of body) {
    const t = raw.replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '').replace(/^\s*\*+/, '').replace(/<[^>]+>/g, '').trim();
    if (t && !t.startsWith('@')) return t.length > 60 ? t.slice(0, 60) + '…' : t;
  }
  return undefined;
}

/** 소스 한 파일에서 매핑 메서드들을 읽는다 */
export function readEndpoints(source: string, file: string): Endpoint[] {
  if (!/Mapping\b/.test(source)) return [];
  const out: Endpoint[] = [];
  let lines: string[] | undefined;
  for (const cls of parseJava(source, file, { detail: true })) {
    const classMap = ann(cls.annotations, 'RequestMapping');
    const classArgs = classMap ? readMapping(classMap) : undefined;
    const base = classArgs?.paths[0] ?? '';
    const baseUnknown = !!classMap && !!classMap.args.trim() && !/"/.test(classMap.args) && !/^\s*(method|produces|consumes|params|headers)\s*=/.test(classMap.args);
    for (const m of cls.methods) {
      const map = m.annotations.find((a) => a.name in MAPPING_ANN);
      if (!map) continue;
      const { paths, methods } = readMapping(map);
      let http = MAPPING_ANN[map.name];
      if (http === 'ANY') http = methods[0] ?? classArgs?.methods[0] ?? (m.params.some((p) => ann(p.anns, 'RequestBody', 'RequestPart')) ? 'POST' : 'GET');
      // 경로 자리에 글자가 아닌 것(상수)이 있으면 읽지 못한 것
      const first = map.args.trim();
      const pathUnknown = baseUnknown || (!!first && !/"/.test(first) && !/^(method|produces|consumes|params|headers|name)\s*=/.test(first));
      const summary = annArg(ann(m.annotations, 'Operation'), 'summary') ?? annArg(ann(m.annotations, 'ApiOperation'), 'value');
      lines ??= source.split(/\r?\n/);
      out.push({
        cls,
        method: m,
        http,
        path: plainPath(joinMapping(base, paths[0])),
        title: summary?.trim() || docTitle(lines, m.startLine ?? m.line) || m.name,
        origin: `${cls.fqcn}#${m.name}(${m.params.map((p) => p.type).join(',')})`,
        pathUnknown,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 타입 → 예시 값 */

const STRINGS = new Set(['String', 'CharSequence', 'char', 'Character', 'UUID', 'URI', 'URL']);
const INTS = new Set(['int', 'long', 'short', 'byte', 'Integer', 'Long', 'Short', 'Byte', 'BigInteger', 'AtomicInteger', 'AtomicLong']);
const FLOATS = new Set(['double', 'float', 'Double', 'Float', 'BigDecimal', 'Number']);
const BOOLS = new Set(['boolean', 'Boolean']);
const LISTS = new Set(['List', 'ArrayList', 'LinkedList', 'Set', 'HashSet', 'LinkedHashSet', 'TreeSet', 'Collection', 'Iterable', 'Stream']);
const MAPS = new Set(['Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'MultiValueMap', 'Object', 'JsonNode', 'ObjectNode', 'JSONObject']);
const FILES = new Set(['MultipartFile', 'Part', 'FilePart']);
/** 요청 값이 아니라 Spring 이 넣어 주는 것 */
const FRAMEWORK = new Set([
  'HttpServletRequest', 'HttpServletResponse', 'ServletRequest', 'ServletResponse', 'HttpSession', 'WebRequest', 'NativeWebRequest', 'Model', 'ModelMap', 'ModelAndView',
  'RedirectAttributes', 'BindingResult', 'Errors', 'Principal', 'Authentication', 'Locale', 'TimeZone', 'ZoneId', 'InputStream', 'OutputStream', 'Reader', 'Writer',
  'HttpMethod', 'HttpEntity', 'RequestEntity', 'HttpHeaders', 'UriComponentsBuilder', 'SessionStatus', 'ServerWebExchange', 'ServerHttpRequest', 'ServerHttpResponse',
  'MultipartHttpServletRequest', 'UserDetails', 'Device',
]);
/** 값 판단에 영향이 없는 어노테이션 */
const NEUTRAL = new Set(['Valid', 'Validated', 'Nullable', 'NonNull', 'NotNull', 'NotBlank', 'NotEmpty', 'Parameter', 'ApiParam', 'ParameterObject', 'Schema', 'Size', 'Min', 'Max', 'Positive', 'PositiveOrZero', 'Pattern', 'Email', 'DateTimeFormat', 'JsonFormat']);

/** List<ItemDto> → { name: 'List', args: ['ItemDto'] } */
export function splitType(raw: string): { name: string; args: string[]; array: boolean } {
  let s = raw.replace(/@\w+(\([^)]*\))?\s*/g, '').replace(/\bfinal\b/g, '').trim();
  const array = /(\[\]|\.\.\.)\s*$/.test(s);
  s = s.replace(/(\[\]|\.\.\.)\s*$/, '').trim();
  const lt = s.indexOf('<');
  if (lt < 0) return { name: s, args: [], array };
  const inner = s.slice(lt + 1, s.lastIndexOf('>'));
  const args: string[] = [];
  let depth = 0, cur = '';
  for (const c of inner) {
    if (c === '<') depth++;
    if (c === '>') depth--;
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return { name: s.slice(0, lt).trim(), args: args.map((a) => a.replace(/^\?\s*(extends|super)\s+/, '').trim()), array };
}

const short = (name: string) => name.split('.').pop() ?? name;
const pad = (n: number) => String(n).padStart(2, '0');

function dateSample(type: string, today: Date): string | undefined {
  const d = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  switch (type) {
    case 'LocalDate': return d;
    case 'LocalDateTime': case 'Timestamp': return `${d}T00:00:00`;
    case 'LocalTime': return '00:00:00';
    case 'Date': case 'Instant': case 'OffsetDateTime': case 'ZonedDateTime': case 'Calendar': return `${d}T00:00:00Z`;
    case 'YearMonth': return d.slice(0, 7);
    default: return undefined;
  }
}

interface Ctx {
  resolve?: ResolveClass;
  today: Date;
  /** 읽지 못한 타입 이름 (메모에 적는다) */
  unknown: Set<string>;
}

/** 필드 목록 (부모 클래스의 것이 앞). static · @JsonIgnore 는 뺀다. 이름은 @JsonProperty 가 있으면 그것 */
async function fieldsOf(cls: JavaClass, ctx: Ctx, seen: Set<string>): Promise<{ name: string; raw: string; from: JavaClass }[]> {
  const out: { name: string; raw: string; from: JavaClass }[] = [];
  const parent = cls.kind === 'class' ? cls.extends[0] : undefined;
  if (parent && !seen.has(parent) && ctx.resolve) {
    const p = await ctx.resolve(parent, cls);
    if (p) out.push(...(await fieldsOf(p, ctx, new Set(seen).add(parent))));
  }
  for (const f of cls.fields) {
    if (f.isStatic || ann(f.anns, 'JsonIgnore', 'Transient')) continue;
    const name = annArg(ann(f.anns, 'JsonProperty'), 'value') || f.name;
    const at = out.findIndex((x) => x.name === name);
    if (at >= 0) out.splice(at, 1);
    out.push({ name, raw: f.raw ?? f.type, from: cls });
  }
  return out;
}

/** 타입에 맞는 예시 값 (JSON 으로 쓸 수 있는 것) */
export async function sampleOf(raw: string, from: JavaClass, ctx: Ctx, depth = 0, seen = new Set<string>()): Promise<unknown> {
  const t = splitType(raw);
  const name = short(t.name);
  if (t.array) return FILES.has(name) || name === 'byte' ? null : [await sampleOf(t.name + (t.args.length ? `<${t.args.join(',')}>` : ''), from, ctx, depth + 1, seen)];
  if (STRINGS.has(name)) return '';
  if (INTS.has(name) || FLOATS.has(name)) return 0;
  if (BOOLS.has(name)) return false;
  const date = dateSample(name, ctx.today);
  if (date !== undefined) return date;
  if (name === 'Optional' || name === 'AtomicReference') return t.args[0] ? sampleOf(t.args[0], from, ctx, depth, seen) : null;
  if (LISTS.has(name)) return t.args[0] ? [await sampleOf(t.args[0], from, ctx, depth + 1, seen)] : [];
  if (MAPS.has(name)) return {};
  if (FILES.has(name)) return null;
  if (depth > 5 || seen.has(t.name)) return null; // 자기를 다시 가리키는 타입
  const cls = ctx.resolve ? await ctx.resolve(t.name, from) : undefined;
  if (!cls) {
    // T · E 같은 타입 인자는 알 수 없는 것이 당연하다
    if (!/^[A-Z]\d?$/.test(name)) ctx.unknown.add(name);
    return depth === 0 ? {} : null;
  }
  if (cls.kind === 'enum') return cls.enumConstants?.[0] ?? '';
  const obj: Record<string, unknown> = {};
  const inner = new Set(seen).add(t.name);
  for (const f of await fieldsOf(cls, ctx, new Set([cls.name]))) obj[f.name] = await sampleOf(f.raw, f.from, ctx, depth + 1, inner);
  return obj;
}

const isSimple = (name: string) => STRINGS.has(name) || INTS.has(name) || FLOATS.has(name) || BOOLS.has(name) || dateSample(name, new Date(0)) !== undefined;
const sampleText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** 객체 파라미터(@ModelAttribute, 검색 조건 DTO)의 필드를 이름=값 줄로. 안쪽 객체는 a.b 로 편다 */
async function flatFields(raw: string, from: JavaClass, ctx: Ctx): Promise<{ key: string; value: string; file: boolean }[]> {
  const cls = ctx.resolve ? await ctx.resolve(splitType(raw).name, from) : undefined;
  if (!cls || cls.kind === 'enum') {
    if (!cls) ctx.unknown.add(short(splitType(raw).name));
    return [];
  }
  const rows: { key: string; value: string; file: boolean }[] = [];
  for (const f of await fieldsOf(cls, ctx, new Set([cls.name]))) {
    const t = splitType(f.raw);
    const name = short(t.name);
    const itemFile = FILES.has(name) || (LISTS.has(name) && FILES.has(short(t.args[0] ?? '')));
    if (itemFile) rows.push({ key: f.name, value: '', file: true });
    else if (isSimple(name) && !t.array) rows.push({ key: f.name, value: '', file: false });
    else if (LISTS.has(name) || t.array) rows.push({ key: f.name, value: '', file: false });
    else {
      const sub = await ctx.resolve?.(t.name, f.from);
      if (sub?.kind === 'enum') rows.push({ key: f.name, value: sub.enumConstants?.[0] ?? '', file: false });
      else if (sub && rows.length < 60) for (const x of await flatFields(f.raw, f.from, ctx)) rows.push({ ...x, key: `${f.name}.${x.key}` });
    }
  }
  return rows;
}

/** 매핑 메서드 하나 → 요청 */
export async function toRequest(ep: Endpoint, opts: ToRequestOptions = {}): Promise<ApiRequest> {
  const ctx: Ctx = { resolve: opts.resolve, today: opts.today ?? new Date(), unknown: new Set() };
  const req = emptyRequest(ep.title);
  req.method = ep.http;
  req.origin = ep.origin;
  const context = (opts.contextPath ?? '').replace(/\/+$/, '');
  req.url = '{{baseUrl}}' + joinMapping(context, ep.path).replace(/^\/$/, '');
  const pathVars: KeyValue[] = [];
  const formRows: KeyValue[] = [];
  let hasFile = false;
  const bodyless = ep.http === 'GET' || ep.http === 'DELETE' || ep.http === 'HEAD';
  const consumes = annArg(ep.method.annotations.find((a) => a.name in MAPPING_ANN), 'consumes') ?? '';

  for (const p of ep.method.params) {
    const raw = p.raw ?? p.type;
    const t = splitType(raw);
    const name = short(t.name);
    const anns = (p.anns ?? []).filter((a) => !NEUTRAL.has(a.name));
    const a = anns[0];
    const argName = (x: Ann) => annArg(x, 'value', 'name') || p.name;
    const optional = (x: Ann) => annArg(x, 'required') === 'false' || annArg(x, 'defaultValue') !== undefined || name === 'Optional';
    const fileType = FILES.has(name) || ((LISTS.has(name) || t.array) && FILES.has(short(t.args[0] ?? name)));

    if (a?.name === 'PathVariable') {
      pathVars.push({ key: argName(a), value: INTS.has(name) ? '1' : '', enabled: true });
    } else if (a?.name === 'RequestParam') {
      if (fileType) {
        formRows.push({ key: argName(a), value: '', enabled: true, file: true });
        hasFile = true;
      } else if (MAPS.has(name) && !annArg(a, 'value', 'name')) {
        // @RequestParam Map<String, String> 은 "모든 파라미터" — 이름을 알 수 없다
      } else {
        req.params.push({ key: argName(a), value: annArg(a, 'defaultValue') ?? '', enabled: !optional(a) });
      }
    } else if (a?.name === 'RequestHeader') {
      if (!MAPS.has(name) && name !== 'HttpHeaders') req.headers.push({ key: argName(a), value: annArg(a, 'defaultValue') ?? '', enabled: !optional(a) });
    } else if (a?.name === 'RequestBody') {
      if (STRINGS.has(name)) {
        req.bodyMode = 'text';
      } else {
        req.bodyMode = 'json';
        req.bodyText = JSON.stringify(await sampleOf(raw, ep.cls, ctx), null, 2);
      }
    } else if (a?.name === 'RequestPart') {
      hasFile = true;
      if (fileType) formRows.push({ key: argName(a), value: '', enabled: true, file: true });
      else formRows.push({ key: argName(a), value: sampleText(await sampleOf(raw, ep.cls, ctx)), enabled: true });
    } else if (a && a.name !== 'ModelAttribute') {
      // @AuthenticationPrincipal · @CookieValue · @SessionAttribute … : 요청에 적을 값이 아니다
    } else if (FRAMEWORK.has(name)) {
      // Spring 이 넣어 주는 것
    } else if (name === 'Pageable' || name === 'PageRequest') {
      req.params.push({ key: 'page', value: '0', enabled: true }, { key: 'size', value: '20', enabled: true }, { key: 'sort', value: '', enabled: false });
    } else if (fileType) {
      formRows.push({ key: p.name, value: '', enabled: true, file: true });
      hasFile = true;
    } else if (isSimple(name) || LISTS.has(name) || t.array) {
      // 어노테이션 없는 단순 타입은 선택 파라미터
      req.params.push({ key: p.name, value: '', enabled: false });
    } else if (!MAPS.has(name)) {
      // 객체 파라미터: 필드가 파라미터(GET) 나 form(POST) 으로 온다
      const rows = await flatFields(raw, ep.cls, ctx);
      if (rows.some((r) => r.file)) hasFile = true;
      if (bodyless) req.params.push(...rows.filter((r) => !r.file).map((r) => ({ key: r.key, value: r.value, enabled: false })));
      else formRows.push(...rows.map((r) => ({ key: r.key, value: r.value, enabled: r.file, ...(r.file ? { file: true } : {}) })));
    }
  }

  if (pathVars.length) req.pathVars = pathVars;
  if (formRows.length && req.bodyMode === 'none') {
    if (bodyless) req.params.push(...formRows.filter((r) => !r.file));
    else {
      req.bodyMode = hasFile || /multipart/i.test(consumes) ? 'multipart' : 'form';
      req.bodyForm = formRows;
    }
  }
  const notes = [`${ep.cls.name}.${ep.method.name}()`];
  if (ep.pathUnknown) notes.push('경로가 상수로 적혀 있어 읽지 못했습니다. 주소를 확인하세요.');
  if (ctx.unknown.size) notes.push(`읽지 못한 타입: ${[...ctx.unknown].join(', ')} — 본문·파라미터를 확인하세요.`);
  req.note = notes.join('\n');
  return req;
}

