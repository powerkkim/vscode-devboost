import type { DbConnectionConfig, TargetKind } from '../../connection/config';
import type { ConnectInfo, HostInput } from '../../driver/types';

/**
 * MySQL·MariaDB 접속 주소 (vscode·mysql2 모듈에 의존하지 않는다).
 *  - 데이터베이스 이름 → host:port/db
 *  - 연결 URL 직접 입력 (mysql://host:3306/db?…)
 *  - JDBC URL (jdbc:mysql://… , jdbc:mariadb://…) 붙여 넣기
 */
export const DEFAULT_PORT = 3306;

type Target = Pick<DbConnectionConfig, 'host' | 'port' | 'targetKind' | 'target'>;

export function describeTarget(c: Target): string {
  if (c.targetKind === 'raw') return c.target.replace(/\/\/[^@/]*@/, '//').slice(0, 60);
  return `${c.host}:${c.port}/${c.target}`;
}

export function connectString(c: Target): string {
  if (c.targetKind === 'raw') return c.target.trim();
  return `mysql://${c.host.trim()}:${c.port}/${encodeURIComponent(c.target.trim())}`;
}

export function checkTarget(kind: TargetKind, v: string): string | undefined {
  const t = v.trim();
  if (!t) return kind === 'raw' ? '연결 URL 을 넣으세요' : '데이터베이스 이름을 넣으세요';
  if (kind === 'raw' && !/^(mysql|mariadb):\/\//i.test(t)) return 'mysql:// 로 시작해야 합니다';
  if (kind !== 'raw' && /[\s/]/.test(t)) return '데이터베이스 이름에 공백이나 / 가 있습니다';
  return undefined;
}

/** jdbc:mysql://host[:port]/db[?…] (jdbc:mariadb:// 도) → 접속 대상 */
export function parseJdbcUrl(text: string): HostInput | undefined {
  const m = /^\s*jdbc:(?:mysql|mariadb):\/\/(?:([^:@/]+)(?::[^@/]*)?@)?(\[[^\]]+\]|[^:/?,\s]+)(?::(\d+))?\/([^?\s]+)(?:\?(\S*))?\s*$/i.exec(text);
  if (!m) return undefined;
  const user = m[1] ?? /(?:^|&)user=([^&]+)/.exec(m[5] ?? '')?.[1];
  return { host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : DEFAULT_PORT, targetKind: 'service', target: decodeURIComponent(m[4]), user: user && decodeURIComponent(user) };
}

export function parseHostInput(text: string): HostInput | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^jdbc:/i.test(t)) return parseJdbcUrl(t);
  if (/^(mysql|mariadb):\/\//i.test(t)) return { host: '', targetKind: 'raw', target: t };
  const m = /^(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?(?:\/([^\s/?]+))?$/.exec(t);
  if (!m) return undefined;
  const host = m[1].replace(/^\[|\]$/g, '');
  if (!m[3]) return { host, port: m[2] ? Number(m[2]) : undefined };
  return { host, port: m[2] ? Number(m[2]) : DEFAULT_PORT, targetKind: 'service', target: m[3] };
}

export const mysqlConnect: ConnectInfo = {
  defaultPort: DEFAULT_PORT,
  targetKinds: [
    { value: 'service', label: '데이터베이스' },
    { value: 'raw', label: '연결 URL' },
  ],
  jdbcExample: 'jdbc:mysql://host:3306/database',
  describeTarget,
  connectString,
  checkTarget,
  parseHostInput,
};
