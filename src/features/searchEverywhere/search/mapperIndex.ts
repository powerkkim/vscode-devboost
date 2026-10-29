import * as path from 'path';
import { FileIndex } from './fileIndex';

/**
 * MyBatis mapper 색인 (vscode 모듈에 의존하지 않아 단독 테스트 가능).
 *
 * - mapper XML: 폴더 이름이 아니라 내용에 `<mapper namespace="…">` 가 있는 XML 만 (pom.xml, 스프링 설정, logback.xml 은 빠짐)
 * - SQL id: 그 XML 안의 `<select|insert|update|delete|sql id="…">`
 * - Java mapper: `@Mapper` 가 붙은 Java 파일, 또는 mapper XML 의 namespace 와 같은 이름의 Java 인터페이스
 *   (뒤의 것은 클래스 색인으로 맞춰 보므로 여기서는 namespace 목록만 넘긴다)
 * 처음 한 번 전체를 훑고, 이후에는 저장·생성·삭제된 파일만 다시 읽는다 (공통 틀 FileIndex)
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
 *  $1 = mapper namespace, $2 = 문장 종류, $3 = SQL id, $4 = `<!DOCTYPE mapper` 표시
 * 속성은 태그와 같은 줄에 있는 경우만 (MyBatis mapper 는 거의 모두 이렇게 씀). 따옴표는 " ' 둘 다.
 * namespace 가 다음 줄에 있어도 MyBatis DOCTYPE 이 있으면 mapper XML 로 본다
 */
export const MAPPER_XML_PATTERN =
  `<mapper\\b[^>]*?\\bnamespace\\s*=\\s*["']([^"']+)["']` +
  `|<(select|insert|update|delete|sql)\\b[^>]*?\\bid\\s*=\\s*["']([^"']+)["']` +
  `|<!DOCTYPE\\s+(mapper)\\b`;

export function buildMapperXmlArgs(roots: string[], excludeGlobs: string[]): string[] {
  const args = ['--no-config', '--no-heading', '--with-filename', '--line-number', '--null', '--only-matching', '--max-filesize', '1M', '--max-columns', '0', '-r', '$1\t$2\t$3\t$4', '--iglob', '*.xml'];
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
  const byFile = new Map<string, { ns?: { name: string; line: number }; doctype?: number; stmts: MapperEntry[] }>();
  for (const raw of out.split('\n')) {
    const z = raw.indexOf('\0');
    if (z < 0) continue;
    const file = path.normalize(raw.slice(0, z));
    const rest = raw.slice(z + 1).replace(/\r$/, '');
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const line = Number(rest.slice(0, colon)) - 1;
    const [ns, stmt, id, doctype] = rest.slice(colon + 1).split('\t');
    const f = byFile.get(file) ?? { stmts: [] };
    byFile.set(file, f);
    if (ns) {
      if (!f.ns) f.ns = { name: ns, line };
    } else if (doctype) {
      f.doctype ??= line;
    } else if (stmt && id) {
      f.stmts.push({ kind: 'statement', name: id, file, line, namespace: '', statement: stmt });
    }
  }
  const out2: MapperEntry[] = [];
  for (const [file, f] of byFile) {
    // <mapper namespace> 도 MyBatis DOCTYPE 도 없으면 mapper 가 아님 (select 태그만 우연히 있는 XML 등)
    if (!f.ns && f.doctype === undefined) continue;
    const ns = f.ns?.name ?? '';
    out2.push({ kind: 'xml', name: path.basename(file), file, line: f.ns?.line ?? f.doctype ?? 0, namespace: ns });
    for (const s of f.stmts) out2.push({ ...s, namespace: ns });
  }
  return out2;
}

function parseFileList(out: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const l of out.split('\n')) {
    const f = l.replace(/\r$/, '');
    if (f) m.set(path.normalize(f), [f]);
  }
  return m;
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

/**
 * mapper 색인 = mapper XML 색인 + @Mapper Java 목록. 둘 다 공통 틀(FileIndex)을 쓴다:
 * 처음 한 번 전체를 훑고, 이후에는 저장·생성·삭제된 파일만 다시 읽는다.
 */
export class MapperIndex {
  private readonly xml: FileIndex<MapperEntry>;
  private readonly java: FileIndex<string>;
  private cache: { entries: MapperEntry[]; namespaces: Set<string> } | undefined;
  lastBuildMs = 0;
  /** 기록용 (출력 패널) */
  onLog: ((msg: string) => void) | undefined;

  /** 테스트에서 묶는 시간을 줄일 때 (FileIndex.BATCH_MS 와 같음) */
  static get BATCH_MS() {
    return FileIndex.BATCH_MS;
  }

  constructor(rgPath: string) {
    this.xml = new FileIndex(rgPath, {
      name: 'mapper XML',
      accepts: (f) => /\.xml$/i.test(f),
      args: buildMapperXmlArgs,
      parse: (out) => groupByFile(parseMapperXmlOutput(out)),
    });
    this.java = new FileIndex(rgPath, {
      name: '@Mapper Java',
      accepts: (f) => /\.java$/i.test(f),
      args: buildMapperJavaArgs,
      parse: parseFileList,
    });
    for (const idx of [this.xml, this.java]) {
      idx.onChange = () => (this.cache = undefined);
      idx.onLog = (m) => this.onLog?.(m);
    }
  }

  get ready(): boolean {
    return this.xml.ready && this.java.ready;
  }

  /** 색인이 준비될 때까지 기다린다. 루트·제외 설정이 바뀌었으면 새로 만든다 */
  async ensure(roots: string[], excludeGlobs: string[]): Promise<void> {
    const wasReady = this.ready;
    const started = Date.now();
    await Promise.all([this.xml.ensure(roots, excludeGlobs), this.java.ensure(roots, excludeGlobs)]);
    if (!wasReady && this.ready) {
      this.lastBuildMs = Date.now() - started;
      const stmts = this.xml.entries().filter((e) => e.kind === 'statement').length;
      this.onLog?.(`[색인] mapper XML ${this.xml.fileCount}개 · SQL id ${stmts}개 · @Mapper Java ${this.java.fileCount}개 ${this.lastBuildMs}ms`);
    }
  }

  /** XML·Java 파일이 저장·생성되면 그 파일만 다시 읽는다 (모아서 처리) */
  queueUpdate(file: string) {
    this.xml.queueUpdate(file);
    this.java.queueUpdate(file);
  }

  removeFile(file: string) {
    this.xml.removeFile(file);
    this.java.removeFile(file);
  }

  /** 예약된 갱신 처리 (테스트에서 직접 부를 수 있음) */
  async flush(): Promise<void> {
    const started = Date.now();
    const done = [...(await this.xml.flush()), ...(await this.java.flush())];
    if (done.length) this.onLog?.(`[색인] mapper 갱신 ${[...new Set(done.map((f) => path.basename(f)))].join(', ')} ${Date.now() - started}ms`);
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
    return this.java.has(file);
  }

  private data() {
    if (!this.cache) {
      const entries = this.xml.entries();
      this.cache = { entries, namespaces: new Set(entries.filter((e) => e.kind === 'xml').map((e) => e.namespace)) };
    }
    return this.cache;
  }
}
