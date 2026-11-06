import type { DbConnectionConfig, TargetKind } from '../../connection/config';
import type { ConnectInfo, HostInput } from '../../driver/types';

/**
 * PostgreSQL 접속 주소 (vscode·pg 모듈에 의존하지 않는다).
 *  - 데이터베이스 이름 → host:port/db
 *  - 연결 URL 직접 입력 (postgres://user@host:5432/db?sslmode=require)
 *  - JDBC URL (jdbc:postgresql://host:5432/db?…) 붙여 넣기
 */
export const DEFAULT_PORT = 5432;

type Target = Pick<DbConnectionConfig, 'host' | 'port' | 'targetKind' | 'target'>;

export function describeTarget(c: Target): string {
  if (c.targetKind === 'raw') return c.target.replace(/\/\/[^@/]*@/, '//').slice(0, 60);
  return `${c.host}:${c.port}/${c.target}`;
}

export function connectString(c: Target): string {
  if (c.targetKind === 'raw') return c.target.trim();
  const h = c.host.includes(':') && !c.host.startsWith('[') ? `[${c.host.trim()}]` : c.host.trim();
  return `postgresql://${h}:${c.port}/${encodeURIComponent(c.target.trim())}`;
}

export function checkTarget(kind: TargetKind, v: string): string | undefined {
  const t = v.trim();
  if (!t) return kind === 'raw' ? '연결 URL 을 넣으세요' : '데이터베이스 이름을 넣으세요';
  if (kind === 'raw' && !/^postgres(?:ql)?:\/\//i.test(t)) return 'postgresql:// 로 시작해야 합니다';
  if (kind !== 'raw' && /[\s/]/.test(t)) return '데이터베이스 이름에 공백이나 / 가 있습니다';
  return undefined;
}

/** jdbc:postgresql://host[:port]/db[?…] → 접속 대상. 아니면 undefined */
export function parseJdbcUrl(text: string): HostInput | undefined {
  const m = /^\s*jdbc:postgresql:\/\/(\[[^\]]+\]|[^:/?\s]+)(?::(\d+))?\/([^?\s]+)(?:\?(\S*))?\s*$/i.exec(text);
  if (!m) return undefined;
  const user = /(?:^|&)user=([^&]+)/.exec(m[4] ?? '')?.[1];
  return { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : DEFAULT_PORT, targetKind: 'service', target: decodeURIComponent(m[3]), user: user && decodeURIComponent(user) };
}

/** 호스트 칸에 넣은 것: JDBC URL, postgresql:// URL, host:port/db, host:port, host */
export function parseHostInput(text: string): HostInput | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^jdbc:/i.test(t)) return parseJdbcUrl(t);
  if (/^postgres(?:ql)?:\/\//i.test(t)) return { host: '', targetKind: 'raw', target: t };
  const m = /^(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?(?:\/([^\s/?]+))?$/.exec(t);
  if (!m) return undefined;
  const host = m[1].replace(/^\[|\]$/g, '');
  if (!m[3]) return { host, port: m[2] ? Number(m[2]) : undefined };
  return { host, port: m[2] ? Number(m[2]) : DEFAULT_PORT, targetKind: 'service', target: m[3] };
}

export const postgresConnect: ConnectInfo = {
  defaultPort: DEFAULT_PORT,
  targetKinds: [
    { value: 'service', label: '데이터베이스' },
    { value: 'raw', label: '연결 URL' },
  ],
  jdbcExample: 'jdbc:postgresql://host:5432/database',
  describeTarget,
  connectString,
  checkTarget,
  parseHostInput,
};
