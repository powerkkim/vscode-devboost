import { spawn } from 'child_process';
import * as path from 'path';
import { rgCwd } from './ripgrep';

/**
 * MyBatis mapper 색인 (vscode 모듈에 의존하지 않아 단독 테스트 가능).
 *
 * - mapper XML: 폴더 이름이 아니라 내용에 `<mapper namespace="…">` 가 있는 XML 만 (pom.xml, 스프링 설정, logback.xml 은 빠짐)
 * - SQL id: 그 XML 안의 `<select|insert|update|delete|sql id="…">`
 * - Java mapper: `@Mapper` 가 붙은 Java 파일, 또는 mapper XML 의 namespace 와 같은 이름의 Java 인터페이스
 *   (뒤의 것은 클래스 색인으로 맞춰 보므로 여기서는 namespace 목록만 넘긴다)
 * 처음 한 번 전체를 훑고, 이후에는 저장·생성·삭제된 파일만 다시 읽는다
 */

export type MapperEntryKind = 'xml' | 'statement' | 'java';

export interface MapperEntry {
  kind: MapperEntryKind;
  /** xml: 파일 이름, statement: SQL id, java: 인터페이스 이름 */
  name: string;
  file: string;
  /** 0부터 */
  line: number;
  /** mapper namespace (statement·xml), java 는 패키지 포함 이름 */
  namespace: string;
  /** statement 의 종류: select·insert·update·delete·sql */
  statement?: string;
}

/**
 * rg 정규식 (Rust 문법).
 *  $1 = mapper namespace, $2 = 문장 종류, $3 = SQL id
 * id 속성이 태그와 같은 줄에 있는 경우만 (MyBatis mapper 는 거의 모두 이렇게 씀)
 */
export const MAPPER_XML_PATTERN =
  `<mapper\\s+namespace\\s*=\\s*"([^"]+)"` +
  `|<(select|insert|update|delete|sql)\\b[^>]*?\\bid\\s*=\\s*"([^"]+)"`;

export function buildMapperXmlArgs(roots: string[], excludeGlobs: string[]): string[] {
  const args = ['--no-config', '--no-heading', '--with-filename', '--line-number', '--null', '--only-matching', '--max-filesize', '1M', '--max-columns', '0', '-r', '$1\t$2\t$3', '--iglob', '*.xml'];
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  args.push('-e', MAPPER_XML_PATTERN, '--', ...roots);
  return args;
}

/** @Mapper 가 붙은 Java 파일 목록 (파일마다 첫 줄만 보면 되므로 -l) */
export function buildMapperJavaArgs(roots: string[], excludeGlobs: string[]): string[] {
  const args = ['--no-config', '--files-with-matches', '--max-filesize', '1M', '--iglob', '*.java'];
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  args.push('-e', '^\\s*@(?:org\\.apache\\.ibatis\\.annotations\\.)?Mapper\\b', '--', ...roots);
  return args;
}

/** rg 출력 → mapper XML 항목. namespace 가 있는 파일의 문장만 남긴다 */
export function parseMapperXmlOutput(out: string): MapperEntry[] {
  const byFile = new Map<string, { ns?: { name: string; line: number }; stmts: MapperEntry[] }>();
  for (const raw of out.split('\n')) {
    const z = raw.indexOf('\0');
    if (z < 0) continue;
    const file = path.normalize(raw.slice(0, z));
    const rest = raw.slice(z + 1).replace(/\r$/, '');
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const line = Number(rest.slice(0, colon)) - 1;
    const [ns, stmt, id] = rest.slice(colon + 1).split('\t');
    const f = byFile.get(file) ?? { stmts: [] };
    byFile.set(file, f);
    if (ns) {
      if (!f.ns) f.ns = { name: ns, line };
    } else if (stmt && id) {
      f.stmts.push({ kind: 'statement', name: id, file, line, namespace: '', statement: stmt });
    }
  }
  const out2: MapperEntry[] = [];
  for (const [file, f] of byFile) {
    if (!f.ns) continue; // <mapper namespace> 가 없으면 MyBatis mapper 가 아님 (select 태그만 우연히 있는 XML 등)
    out2.push({ kind: 'xml', name: path.basename(file), file, line: f.ns.line, namespace: f.ns.name });
    for (const s of f.stmts) out2.push({ ...s, namespace: f.ns.name });
  }
  return out2;
}

function runRg(rgPath: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'], cwd });
    const chunks: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => resolve(chunks.join('')));
  });
}

function parseFileList(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((l) => path.normalize(l));
}

/**
 * mapper 색인. 처음 한 번 전체를 훑고(XML 전체 + Java 의 @Mapper), 이후에는 저장·생성·삭제된 파일만 다시 읽는다.
 */
export class MapperIndex {
  /** mapper XML 파일 → 그 파일 항목 (xml 1개 + SQL id 들) */
  private xmlByFile = new Map<string, MapperEntry[]>();
  /** @Mapper 가 붙은 Java 파일 */
  private annotated = new Set<string>();
  private key = '';
  private building: Promise<void> | undefined;
  private buildId = 0;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private cache: { entries: MapperEntry[]; namespaces: Set<string> } | undefined;
  ready = false;
  lastBuildMs = 0;
  /** 기록용 (출력 패널) */
  onLog: ((msg: string) => void) | undefined;

  static BATCH_MS = 300;

  constructor(private readonly rgPath: string) {}

  /** 색인이 준비될 때까지 기다린다. 루트·제외 설정이 바뀌었으면 새로 만든다 */
  ensure(roots: string[], excludeGlobs: string[]): Promise<void> {
    const key = JSON.stringify([roots, excludeGlobs]);
    if (key !== this.key) {
      this.key = key;
      this.ready = false;
      const id = ++this.buildId;
      const started = Date.now();
      const p = Promise.all([
        runRg(this.rgPath, buildMapperXmlArgs(roots, excludeGlobs), rgCwd(roots)),
        runRg(this.rgPath, buildMapperJavaArgs(roots, excludeGlobs), rgCwd(roots)),
      ]).then(([xmlOut, javaOut]) => {
        if (this.buildId !== id) return;
        this.xmlByFile = groupByFile(parseMapperXmlOutput(xmlOut));
        this.annotated = new Set(parseFileList(javaOut));
        this.cache = undefined;
        this.ready = true;
        this.lastBuildMs = Date.now() - started;
        this.onLog?.(`[색인] mapper XML ${this.xmlByFile.size}개 · SQL id ${this.statementCount()}개 · @Mapper Java ${this.annotated.size}개 ${this.lastBuildMs}ms`);
        if (this.pending.size) this.schedule();
      });
      this.building = p;
      p.catch((e) => {
        if (this.buildId === id) this.key = ''; // 실패하면 다음에 다시
        this.onLog?.(`[경고] mapper 색인 실패: ${e}`);
      });
    }
    return this.building!;
  }

  private statementCount(): number {
    let n = 0;
    for (const list of this.xmlByFile.values()) n += list.length - 1;
    return n;
  }

  /** XML·Java 파일이 저장·생성되면 그 파일만 다시 읽는다 (모아서 처리) */
  queueUpdate(file: string) {
    if (!/\.(xml|java)$/i.test(file)) return;
    this.pending.add(path.normalize(file));
    this.schedule();
  }

  removeFile(file: string) {
    file = path.normalize(file);
    const prefix = file.endsWith(path.sep) ? file : file + path.sep;
    let changed = this.xmlByFile.delete(file) || this.annotated.delete(file);
    for (const f of [...this.xmlByFile.keys()]) if (f.startsWith(prefix)) changed = this.xmlByFile.delete(f) || changed;
    for (const f of [...this.annotated]) if (f.startsWith(prefix)) changed = this.annotated.delete(f) || changed;
    this.pending.delete(file);
    if (changed) this.cache = undefined;
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, MapperIndex.BATCH_MS);
  }

  /** 예약된 갱신 처리 (테스트에서 직접 부를 수 있음) */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing.catch(() => undefined);
    if (!this.ready || !this.pending.size) return;
    const p = this.flushPending();
    this.flushing = p;
    try {
      await p;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushPending(): Promise<void> {
    const files = [...this.pending];
    this.pending.clear();
    const id = this.buildId;
    const started = Date.now();
    const xml = files.filter((f) => /\.xml$/i.test(f));
    const java = files.filter((f) => /\.java$/i.test(f));
    // 경로를 직접 넘긴다 (호출하는 쪽에서 제외 폴더는 이미 걸렀음)
    const [xmlOut, javaOut] = await Promise.all([
      xml.length ? runRg(this.rgPath, buildMapperXmlArgs(xml, [])) : Promise.resolve(''),
      java.length ? runRg(this.rgPath, buildMapperJavaArgs(java, [])) : Promise.resolve(''),
    ]);
    if (this.buildId !== id || !this.ready) return;
    const foundXml = groupByFile(parseMapperXmlOutput(xmlOut));
    const foundJava = new Set(parseFileList(javaOut));
    for (const f of xml) {
      const list = foundXml.get(f);
      if (list) this.xmlByFile.set(f, list);
      else this.xmlByFile.delete(f); // namespace 가 없어졌거나 mapper 가 아닌 XML
    }
    for (const f of java) {
      if (foundJava.has(f)) this.annotated.add(f);
      else this.annotated.delete(f);
    }
    this.cache = undefined;
    this.onLog?.(`[색인] mapper 갱신 ${files.map((f) => path.basename(f)).join(', ')} ${Date.now() - started}ms`);
  }

  /** 모든 mapper XML 항목 (파일 + SQL id) */
  entries(): MapperEntry[] {
    return this.data().entries;
  }

  /** mapper XML 의 namespace 들 (이 이름의 Java 인터페이스도 mapper) */
  namespaces(): Set<string> {
    return this.data().namespaces;
  }

  isAnnotated(file: string): boolean {
    return this.annotated.has(file);
  }

  private data() {
    if (!this.cache) {
      const entries = [...this.xmlByFile.values()].flat();
      this.cache = { entries, namespaces: new Set(entries.filter((e) => e.kind === 'xml').map((e) => e.namespace)) };
    }
    return this.cache;
  }
}

function groupByFile(list: MapperEntry[]): Map<string, MapperEntry[]> {
  const m = new Map<string, MapperEntry[]>();
  for (const e of list) {
    const l = m.get(e.file) ?? [];
    l.push(e);
    m.set(e.file, l);
  }
  return m;
}
