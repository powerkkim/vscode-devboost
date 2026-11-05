import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { DbConnectionConfig, describeConnection } from './connection/connectString';
import { testConnection, explainError, errorCode } from './connection/oracleClient';
import { ConnectionStore } from './connectionStore';
import { Sessions } from './sessions';
import { askConnection } from './ui/connectionForm';
import { ConnectionItem, ConnectionTree, CONNECTIONS_VIEW_ID } from './ui/connectionTree';

/**
 * DB 콘솔 — Oracle 에 직접 접속한다 (node-oracledb Thin 모드, Oracle Client 설치 불필요, 12.1 이상).
 * 1단계: 연결 저장(비밀번호는 SecretStorage) · 접속 테스트 · 접속/끊기. 사이드바 DevBoost → "DB 연결".
 * 쿼리 실행·결과 그리드·스키마 트리는 이 접속(Sessions) 위에 붙인다.
 */
export const dbConsole: Feature = {
  id: 'dbConsole',
  name: 'DB 콘솔',
  start(context) {
    const store = new ConnectionStore(context);
    const sessions = new Sessions();
    const tree = new ConnectionTree(store, sessions);
    /** 저장하지 않는 비밀번호: VS Code 를 닫을 때까지만 기억 (접속할 때마다 다시 묻지 않게) */
    const typed = new Map<string, string>();

    /** 트리에서 누른 항목, 없으면(명령 팔레트) 목록에서 고른다 */
    const pick = async (item: ConnectionItem | undefined, title: string): Promise<DbConnectionConfig | undefined> => {
      if (item) return store.get(item.config.id);
      const list = store.list();
      if (!list.length) {
        const add = '연결 추가';
        if ((await vscode.window.showInformationMessage('저장한 DB 연결이 없습니다.', add)) === add) {
          await vscode.commands.executeCommand('devBoost.dbConsole.addConnection');
        }
        return undefined;
      }
      const chosen = await vscode.window.showQuickPick(
        list.map((c) => ({ label: c.name, description: describeConnection(c), config: c })),
        { title }
      );
      return chosen?.config;
    };

    /**
     * 저장된 비밀번호 → 이번에 입력한 비밀번호 → 묻기. 취소하면 undefined.
     * saved: 저장소에서 온 값 (이런 값은 typed 에 다시 넣지 않는다 — 평문을 메모리에 한 벌 더 두지 않게)
     */
    const passwordFor = async (cfg: DbConnectionConfig): Promise<{ value: string; saved: boolean } | undefined> => {
      const saved = cfg.savePassword ? await store.password(cfg.id) : undefined;
      if (saved !== undefined) return { value: saved, saved: true };
      const known = typed.get(cfg.id);
      if (known !== undefined) return { value: known, saved: false };
      const pw = await vscode.window.showInputBox({
        title: `${cfg.name} — 비밀번호`,
        prompt: `${describeConnection(cfg)} 의 비밀번호 (저장하지 않습니다)`,
        password: true,
        ignoreFocusOut: true,
      });
      return pw === undefined ? undefined : { value: pw, saved: false };
    };

    /** 실패 안내. 계정·비밀번호 문제면 기억한 입력값을 버린다 (다음에 다시 묻게). 네트워크 오류면 그대로 둔다 */
    const failed = (cfg: DbConnectionConfig, e: unknown, doing: string) => {
      if (['ORA-01017', 'ORA-28000', 'ORA-28001', 'NJS-116'].includes(errorCode(e) ?? '')) typed.delete(cfg.id);
      const edit = '연결 수정';
      void vscode.window.showErrorMessage(`${cfg.name} ${doing} 실패: ${explainError(e)}`, edit).then((b) => {
        if (b === edit) void vscode.commands.executeCommand('devBoost.dbConsole.editConnection', new ConnectionItem(cfg, 'disconnected'));
      });
    };

    const test = async (cfg: DbConnectionConfig) => {
      const pw = await passwordFor(cfg);
      if (pw === undefined) return;
      try {
        const info = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `${cfg.name} 접속 테스트 중…` },
          () => testConnection(cfg, pw.value)
        );
        if (!pw.saved) typed.set(cfg.id, pw.value);
        void vscode.window.showInformationMessage(
          `${cfg.name} 접속 성공 — Oracle ${info.version} · DB ${info.dbName} · 스키마 ${info.schema} (${info.ms}ms)`
        );
      } catch (e) {
        failed(cfg, e, '접속 테스트');
      }
    };

    const connect = async (cfg: DbConnectionConfig) => {
      if (sessions.isConnected(cfg.id)) return;
      const pw = await passwordFor(cfg);
      if (pw === undefined) return;
      try {
        const s = await vscode.window.withProgress({ location: { viewId: CONNECTIONS_VIEW_ID } }, () => sessions.connect(cfg, pw.value));
        if (!pw.saved) typed.set(cfg.id, pw.value);
        vscode.window.setStatusBarMessage(`${cfg.name} 접속됨 — Oracle ${s.info.version} · 스키마 ${s.info.schema}`, 5000);
      } catch (e) {
        failed(cfg, e, '접속');
      }
    };

    // 끊김 감지: 서버에 다녀와 확인하는 간격은 설정에서 (기본 5분, 0 = 서버에는 다녀오지 않음).
    // 끊긴 것을 알아채면 알리고 다시 접속할 수 있게 한다
    const applyCheckInterval = () => {
      const sec = vscode.workspace.getConfiguration('devBoost.dbConsole').get<number>('checkConnectionSeconds', 300);
      sessions.setCheckInterval(sec > 0 ? Math.max(30, sec) * 1000 : 0);
    };
    applyCheckInterval();
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devBoost.dbConsole.checkConnectionSeconds')) applyCheckInterval();
    });
    const lostWatcher = sessions.onDidLose(({ id, reason }) => {
      const cfg = store.get(id);
      if (!cfg) return;
      const again = '다시 접속';
      void vscode.window.showWarningMessage(`${cfg.name} 접속이 끊겼습니다: ${reason}`, again).then((b) => {
        if (b === again) void connect(cfg);
      });
    });

    const cmd = (name: string, run: (item?: ConnectionItem) => unknown) =>
      vscode.commands.registerCommand(`devBoost.dbConsole.${name}`, run);

    return [
      store,
      sessions,
      tree,
      configWatcher,
      lostWatcher,
      vscode.window.registerTreeDataProvider(CONNECTIONS_VIEW_ID, tree),

      cmd('addConnection', async () => {
        const r = await askConnection();
        if (!r) return;
        await store.save(r.config, r.password);
        await test(r.config); // 저장한 김에 바로 붙여 본다
      }),

      cmd('editConnection', async (item) => {
        const cfg = await pick(item, '수정할 DB 연결');
        if (!cfg) return;
        const r = await askConnection(cfg);
        if (!r) return;
        await sessions.disconnect(cfg.id); // 주소·계정이 바뀌었을 수 있으니 접속은 끊는다
        typed.delete(cfg.id);
        await store.save(r.config, r.password);
        await test(r.config);
      }),

      cmd('removeConnection', async (item) => {
        const cfg = await pick(item, '삭제할 DB 연결');
        if (!cfg) return;
        const yes = '삭제';
        const answer = await vscode.window.showWarningMessage(
          `DB 연결 "${cfg.name}" 을 삭제할까요? 저장된 비밀번호도 지워집니다.`,
          { modal: true },
          yes
        );
        if (answer !== yes) return;
        await sessions.disconnect(cfg.id);
        typed.delete(cfg.id);
        await store.remove(cfg.id);
      }),

      cmd('testConnection', async (item) => {
        const cfg = await pick(item, '접속을 테스트할 DB 연결');
        if (cfg) await test(cfg);
      }),

      cmd('connect', async (item) => {
        const cfg = await pick(item, '접속할 DB 연결');
        if (cfg) await connect(cfg);
      }),

      cmd('disconnect', async (item) => {
        const cfg = await pick(item, '접속을 끊을 DB 연결');
        if (cfg) await sessions.disconnect(cfg.id);
      }),
    ];
  },
};
