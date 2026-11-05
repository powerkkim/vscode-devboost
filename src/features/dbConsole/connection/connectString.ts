/**
 * DB 연결 정보와 연결 문자열 (vscode·oracledb 모듈에 의존하지 않아 단독 테스트 가능).
 */

/** 접속 대상을 적는 방식: 서비스 이름 / SID / 연결 문자열 전체(TNS 설명자·EZConnect) */
export type TargetKind = 'service' | 'sid' | 'raw';

export interface DbConnectionConfig {
  id: string;
  /** 목록에 보이는 이름 */
  name: string;
  /** targetKind 가 'raw' 면 쓰지 않는다 */
  host: string;
  port: number;
  targetKind: TargetKind;
  /** 서비스 이름 / SID / 연결 문자열 전체 */
  target: string;
  user: string;
  /** 읽기 전용으로 쓸 연결 (변경 쿼리를 막는 데 쓴다) */
  readOnly: boolean;
  /** 운영 DB 표시 (목록에서 빨간색) */
  production: boolean;
  /** 비밀번호를 저장해 두는지. false 면 접속할 때 묻는다 */
  savePassword: boolean;
}

export const DEFAULT_PORT = 1521;

/** node-oracledb 에 넘길 연결 문자열 */
export function buildConnectString(c: Pick<DbConnectionConfig, 'host' | 'port' | 'targetKind' | 'target'>): string {
  const target = c.target.trim();
  if (c.targetKind === 'raw') return target;
  const host = c.host.trim();
  if (c.targetKind === 'sid') {
    // EZConnect 는 SID 를 쓸 수 없어 설명자로 적는다
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${c.port}))(CONNECT_DATA=(SID=${target})))`;
  }
  // IPv6 주소는 대괄호로 감싼다
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${h}:${c.port}/${target}`;
}

/** 목록에 보여 줄 한 줄: user@host:port/service */
export function describeConnection(c: DbConnectionConfig): string {
  if (c.targetKind === 'raw') {
    const t = c.target.trim().replace(/\s+/g, ' ');
    return `${c.user}@${t.length > 60 ? t.slice(0, 60) + '…' : t}`;
  }
  return `${c.user}@${c.host}:${c.port}${c.targetKind === 'sid' ? ':' : '/'}${c.target}`;
}

// ───────── 입력값 확인 (틀리면 이유, 맞으면 undefined) ─────────

export function checkName(v: string): string | undefined {
  return v.trim() ? undefined : '이름을 넣으세요';
}

export function checkHost(v: string): string | undefined {
  const t = v.trim();
  if (!t) return '호스트(서버 주소)를 넣으세요';
  if (/\s/.test(t)) return '호스트에 공백이 있습니다';
  if (/[()=/]/.test(t)) return '호스트에 쓸 수 없는 글자가 있습니다 (괄호, =, /)';
  return undefined;
}

/** 호스트 칸에 넣은 글에서 읽어 낸 것. 호스트만 썼으면 host 만 있다 */
export interface HostInput {
  host: string;
  port?: number;
  targetKind?: TargetKind;
  target?: string;
  user?: string;
}

/**
 * 호스트 칸의 입력을 읽는다. 주소만 쓰지 않고 한꺼번에 붙여 넣는 경우를 받아 준다. 읽을 수 없으면 undefined
 *  - JDBC URL (jdbc:oracle:thin:@…)                    → 전부
 *  - TNS 설명자 ((DESCRIPTION=…))                       → 연결 문자열 그대로
 *  - host:1521/service , host/service , host:1521:SID  → 전부
 *  - host:1522                                         → 호스트와 포트
 *  - host , IPv6 주소(fe80::1, [fe80::1])               → 호스트만
 */
export function parseHostInput(text: string): HostInput | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^jdbc:/i.test(t)) return parseJdbcUrl(t);
  if (t.startsWith('(')) return { host: '', targetKind: 'raw', target: t };
  // 대괄호 없는 IPv6 주소: 16진수·콜론·점만 있고 "::" 가 있거나 콜론이 셋 이상 → 통째로 호스트 (host:port:sid 는 콜론 둘)
  if (/^[0-9a-f:.]+$/i.test(t) && (t.includes('::') || t.split(':').length > 3)) return { host: t };
  const a = HOST_TARGET.exec(t);
  if (!a || a[0].length !== t.length) return undefined;
  if (a[3] === ':' && !a[2]) return undefined; // host:SID 모양은 없다 (SID 는 host:port:SID)
  const host = a[1].replace(/^\[|\]$/g, '');
  const port = a[2] ? Number(a[2]) : undefined;
  if (!a[4]) return { host, port };
  return { host, port: port ?? DEFAULT_PORT, targetKind: a[3] === ':' ? 'sid' : 'service', target: a[4] };
}

/** 호스트 칸 확인: 읽을 수 있는 모양이고 호스트·포트·대상이 각각 맞아야 한다 */
export function checkHostInput(v: string): string | undefined {
  if (!v.trim()) return '호스트(서버 주소)를 넣으세요';
  const p = parseHostInput(v);
  if (!p) return /^\s*jdbc:/i.test(v) ? 'JDBC URL 을 읽지 못했습니다 (jdbc:oracle:thin:@//host:1521/service 모양)' : '주소를 읽지 못했습니다 (예: 10.0.0.5 , db.example.com:1521/service)';
  if (p.targetKind === 'raw') return undefined;
  return checkHost(p.host) ?? (p.port !== undefined ? checkPort(String(p.port)) : undefined) ?? (p.targetKind && p.target !== undefined ? checkTarget(p.targetKind, p.target) : undefined);
}

/** [//]host[:port][/service | :sid] — host 는 이름·IPv4 또는 [IPv6] */
const HOST_TARGET = /^(?:\/\/)?(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?(?:([:/])([^\s?]+))?/;

export function checkPort(v: string): string | undefined {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return '포트는 숫자입니다 (보통 1521)';
  const n = Number(t);
  return n >= 1 && n <= 65535 ? undefined : '포트는 1~65535 사이입니다';
}

export function checkTarget(kind: TargetKind, v: string): string | undefined {
  const t = v.trim();
  if (!t) return kind === 'service' ? '서비스 이름을 넣으세요' : kind === 'sid' ? 'SID 를 넣으세요' : '연결 문자열을 넣으세요';
  if (kind !== 'raw' && /[\s()=/]/.test(t)) return '이름에 쓸 수 없는 글자가 있습니다 (공백, 괄호, =, /)';
  return undefined;
}

export function checkUser(v: string): string | undefined {
  return v.trim() ? undefined : '사용자 이름을 넣으세요';
}

/**
 * JDBC URL → 접속 대상. application.yml 의 URL 을 그대로 붙여 넣을 수 있게 한다. JDBC URL 이 아니면 undefined
 *  - jdbc:oracle:thin:@//host:1521/service , jdbc:oracle:thin:@host:1521/service → 서비스 이름
 *  - jdbc:oracle:thin:@host:1521:SID                                             → SID
 *  - jdbc:oracle:thin:@(DESCRIPTION=…)                                           → 연결 문자열 그대로
 * 앞에 user/password 가 있으면(jdbc:oracle:thin:scott/tiger@…) 사용자 이름만 가져온다
 */
export function parseJdbcUrl(text: string): { host: string; port: number; targetKind: TargetKind; target: string; user?: string } | undefined {
  const m = /^\s*jdbc:oracle:thin:([^@]*)@\s*([\s\S]+?)\s*$/i.exec(text);
  if (!m) return undefined;
  const user = m[1].split('/')[0].trim() || undefined;
  const rest = m[2];
  if (rest.startsWith('(')) return { host: '', port: DEFAULT_PORT, targetKind: 'raw', target: rest, user };
  // 뒤에 ?옵션 이 붙을 수 있어 끝까지 맞추지는 않는다
  const a = HOST_TARGET.exec(rest);
  if (!a || !a[4]) return undefined;
  return {
    host: a[1].replace(/^\[|\]$/g, ''),
    port: a[2] ? Number(a[2]) : DEFAULT_PORT,
    targetKind: a[3] === ':' ? 'sid' : 'service',
    target: a[4],
    user,
  };
}
