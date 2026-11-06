import { DbConnectionConfig, TargetKind, checkName, checkHost, checkPort, checkUser } from './config';
import type { DbKind } from '../driver/types';
import { driverOf } from '../driver/registry';

/**
 * 연결 입력 화면(한 화면에 모든 항목)의 값과 확인 (vscode 모듈에 의존하지 않아 단독 테스트 가능).
 * 화면(Webview)은 글자만 주고받고, 값이 맞는지·연결 문자열이 무엇인지는 여기서 정한다.
 */

/** 화면의 입력값 (모두 화면에 적힌 그대로) */
export interface ConnectionForm {
  /** DB 종류 (없으면 Oracle) */
  kind?: DbKind;
  name: string;
  host: string;
  port: string;
  targetKind: TargetKind;
  /** 서비스 이름 / SID / 연결 문자열 전체 */
  target: string;
  user: string;
  /** 비어 있으면: 고칠 때는 저장된 비밀번호를 그대로, 새로 만들 때는 비밀번호 없음 */
  password: string;
  savePassword: boolean;
  readOnly: boolean;
  production: boolean;
}

export type FormField = 'name' | 'host' | 'port' | 'target' | 'user' | 'password';
export type FormErrors = Partial<Record<FormField, string>>;

/** 새 연결의 빈 화면 */
export function emptyForm(kind: DbKind = 'oracle'): ConnectionForm {
  return { kind, name: '', host: '', port: String(driverOf(kind).connect.defaultPort), targetKind: 'service', target: '', user: '', password: '', savePassword: true, readOnly: false, production: false };
}

/** 저장된 연결 → 화면 (비밀번호는 화면으로 보내지 않는다) */
export function formFromConfig(c: DbConnectionConfig): ConnectionForm {
  return {
    kind: c.kind ?? 'oracle',
    name: c.name,
    host: c.host,
    port: String(c.port),
    targetKind: c.targetKind,
    target: c.target,
    user: c.user,
    password: '',
    savePassword: c.savePassword,
    readOnly: c.readOnly,
    production: c.production,
  };
}

/**
 * 입력값 확인. hasSavedPassword: 고치는 연결에 이미 저장된 비밀번호가 있는지 (있으면 비밀번호 칸을 비워도 된다).
 * 틀린 칸 → 이유. 다 맞으면 빈 객체
 */
export function validateForm(f: ConnectionForm, hasSavedPassword: boolean): FormErrors {
  const e: FormErrors = {};
  const put = (field: FormField, msg: string | undefined) => {
    if (msg) e[field] = msg;
  };
  put('name', checkName(f.name));
  if (f.targetKind !== 'raw') {
    put('host', checkHost(f.host));
    put('port', checkPort(f.port));
  }
  put('target', driverOf(f.kind).connect.checkTarget(f.targetKind, f.target));
  put('user', checkUser(f.user));
  if (f.savePassword && !f.password && !hasSavedPassword) put('password', '비밀번호를 넣거나 "비밀번호 저장"을 끄세요 (끄면 접속할 때 묻습니다)');
  return e;
}

/** 화면 → 저장할 연결. validateForm 을 통과한 값으로 부른다 */
export function formToConfig(f: ConnectionForm, id: string): DbConnectionConfig {
  const raw = f.targetKind === 'raw';
  const kind = f.kind ?? 'oracle';
  return {
    id,
    kind,
    name: f.name.trim(),
    host: raw ? '' : f.host.trim(),
    port: raw ? driverOf(kind).connect.defaultPort : Number(f.port.trim()),
    targetKind: f.targetKind,
    target: f.target.trim(),
    user: f.user.trim(),
    readOnly: f.readOnly,
    production: f.production,
    savePassword: f.savePassword,
  };
}

/** 화면 아래에 보여 줄 연결 문자열 (아직 다 채우지 않았으면 '') */
export function previewConnectString(f: ConnectionForm): string {
  if (!f.target.trim()) return '';
  if (f.targetKind === 'raw') return f.target.trim();
  if (checkHost(f.host) || checkPort(f.port)) return '';
  return driverOf(f.kind).connect.connectString({ host: f.host, port: Number(f.port.trim()), targetKind: f.targetKind, target: f.target });
}

/**
 * 호스트 칸에 주소만이 아니라 한꺼번에 붙여 넣었을 때(JDBC URL, host:1521/service, host:1522, TNS 설명자) 다른 칸에 나눠 채운다.
 * 나눠 채울 것이 없으면(주소만 썼거나 읽을 수 없으면) undefined
 */
export function fillFromHostInput(f: ConnectionForm): ConnectionForm | undefined {
  const p = driverOf(f.kind).connect.parseHostInput(f.host);
  if (!p) return undefined;
  const hasTarget = p.targetKind !== undefined && p.target !== undefined;
  if (!hasTarget && p.port === undefined) return undefined;
  const next = { ...f, host: p.host };
  if (p.port !== undefined) next.port = String(p.port);
  if (hasTarget) {
    next.targetKind = p.targetKind!;
    next.target = p.target!;
  }
  if (p.user && !f.user.trim()) next.user = p.user;
  return next;
}
