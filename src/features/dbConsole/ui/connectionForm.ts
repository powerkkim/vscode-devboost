import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import {
  DbConnectionConfig,
  TargetKind,
  DEFAULT_PORT,
  checkName,
  checkHostInput,
  checkPort,
  checkTarget,
  checkUser,
  parseHostInput,
} from '../connection/connectString';

/** 입력 결과. password: 문자열 = 새 비밀번호, undefined = 저장된 것을 그대로 (고칠 때 비워 둠) */
export interface FormResult {
  config: DbConnectionConfig;
  password: string | undefined;
}

/**
 * 연결 추가·수정: 항목을 하나씩 묻는다 (Esc 를 누르면 전체 취소).
 * 호스트 칸에 host:1521/service 나 JDBC URL(jdbc:oracle:thin:@…)을 붙여 넣으면 포트·서비스 이름까지 한 번에 채운다.
 */
export async function askConnection(existing?: DbConnectionConfig): Promise<FormResult | undefined> {
  const what = existing ? `DB 연결 수정: ${existing.name}` : 'DB 연결 추가';
  const ask = (step: string, o: vscode.InputBoxOptions) =>
    vscode.window.showInputBox({ title: `${what} — ${step}`, ignoreFocusOut: true, ...o });

  const name = await ask('이름', {
    prompt: '목록에 보일 이름 (예: 개발 DB)',
    value: existing?.name ?? '',
    validateInput: checkName,
  });
  if (name === undefined) return undefined;

  let host = existing?.host ?? '';
  let port = existing?.port ?? DEFAULT_PORT;
  let targetKind: TargetKind = existing?.targetKind ?? 'service';
  let target = existing?.target ?? '';
  let userDefault = existing?.user ?? '';

  const hostIn = await ask('호스트', {
    prompt: '서버 주소 (예: 10.0.0.5, db.example.com). host:1521/service 나 JDBC URL 을 붙여 넣어도 됩니다',
    placeHolder: 'jdbc:oracle:thin:@//host:1521/service 도 가능',
    value: existing ? (existing.targetKind === 'raw' ? existing.target : existing.host) : '',
    validateInput: checkHostInput,
  });
  if (hostIn === undefined) return undefined;

  // 주소만 썼으면 포트·접속 대상을 이어서 묻고, 한꺼번에 붙여 넣었으면 읽어 낸 만큼 건너뛴다
  const parsed = parseHostInput(hostIn);
  if (!parsed) return undefined; // validateInput 을 통과했으므로 오지 않는다
  host = parsed.host;
  if (parsed.user && !userDefault) userDefault = parsed.user;
  if (parsed.targetKind && parsed.target !== undefined) {
    targetKind = parsed.targetKind;
    target = parsed.target;
    if (parsed.port !== undefined) port = parsed.port;
  } else {
    if (parsed.port !== undefined) {
      port = parsed.port; // host:1522 처럼 포트까지 썼음
    } else {
      const portIn = await ask('포트', { prompt: '리스너 포트', value: String(port), validateInput: checkPort });
      if (portIn === undefined) return undefined;
      port = Number(portIn.trim());
    }

    const kinds: (vscode.QuickPickItem & { kind2: TargetKind })[] = [
      { label: '서비스 이름', description: '보통 이쪽 (JDBC URL 이 …:1521/이름 모양)', kind2: 'service' },
      { label: 'SID', description: 'JDBC URL 이 …:1521:이름 모양', kind2: 'sid' },
    ];
    if (targetKind === 'sid') kinds.reverse();
    const kind = await vscode.window.showQuickPick(kinds, { title: `${what} — 접속 대상`, ignoreFocusOut: true });
    if (!kind) return undefined;
    const prev = targetKind === kind.kind2 ? target : '';
    targetKind = kind.kind2;
    const targetIn = await ask(kind.label, {
      prompt: targetKind === 'service' ? '서비스 이름 (예: ORCLPDB1)' : 'SID (예: ORCL)',
      value: prev,
      validateInput: (v) => checkTarget(targetKind, v),
    });
    if (targetIn === undefined) return undefined;
    target = targetIn.trim();
  }

  const user = await ask('사용자', { prompt: 'DB 사용자 이름', value: userDefault, validateInput: checkUser });
  if (user === undefined) return undefined;

  const hadSaved = !!existing?.savePassword;
  const passwordIn = await ask('비밀번호', {
    password: true,
    prompt: hadSaved
      ? '비밀번호 (비워 두면 저장된 비밀번호를 그대로 씁니다)'
      : '비밀번호 (비워 두면 저장하지 않고 접속할 때마다 묻습니다)',
  });
  if (passwordIn === undefined) return undefined;

  const flags: (vscode.QuickPickItem & { key: 'readOnly' | 'production' })[] = [
    { label: '읽기 전용', description: '조회만 할 연결', key: 'readOnly', picked: existing?.readOnly ?? false },
    { label: '운영 DB', description: '목록에서 빨간색으로 표시', key: 'production', picked: existing?.production ?? false },
  ];
  const picked = await vscode.window.showQuickPick(flags, {
    title: `${what} — 옵션 (해당하는 것을 체크, 없으면 그냥 Enter)`,
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;

  return {
    config: {
      id: existing?.id ?? randomUUID(),
      name: name.trim(),
      host,
      port,
      targetKind,
      target,
      user: user.trim(),
      readOnly: picked.some((p) => p.key === 'readOnly'),
      production: picked.some((p) => p.key === 'production'),
      savePassword: passwordIn !== '' || hadSaved,
    },
    password: passwordIn !== '' ? passwordIn : undefined,
  };
}
