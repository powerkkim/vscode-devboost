import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { DbConnectionConfig, describeConnection } from './connection/connectString';
import { testConnection, explainError, errorCode } from './connection/oracleClient';
import { SchemaObjects, TableColumn, loadObjects, loadColumns } from './connection/schema';
import { ConnectionStore } from './connectionStore';
import { Sessions } from './sessions';
import { ConnectionItem, ConnectionTree, CONNECTIONS_VIEW_ID } from './ui/connectionTree';
import { ResultView, RESULTS_VIEW_ID } from './ui/resultView';
import { FormActions } from './ui/formDialog';
import { DbConsole } from './console';

/**
 * DB 콘솔 — Oracle 에 직접 접속해 쿼리를 실행한다 (node-oracledb Thin 모드, Oracle Client 설치 불필요, 12.1 이상).
 *  - 사이드바 DevBoost → "DB 연결": 연결 목록과 테이블·뷰·칸
 *  - 콘솔 탭: 실행 도구 줄 · 파라미터 줄 · SQL 편집기. 연결 추가·수정 팝업도 여기에 뜬다
 *  - 하단 패널 "DB 결과": 결과 표 · 실행계획 · 메시지
 */
export const dbConsole: Feature = {
  id: 'dbConsole',
  name: 'DB 콘솔',
  start(context) {
    const store = new ConnectionStore(context);
    const sessions = new Sessions();
    /** 저장하지 않는 비밀번호: VS Code 를 닫을 때까지만 기억 (접속할 때마다 다시 묻지 않게) */
    const typed = new Map<string, string>();
    /** 연결별 테이블·뷰·칸 (접속해 있는 동안 기억. 새로 고침이나 접속이 닫히면 비운다) */
    const schemaCache = new Map<string, { objects?: Promise<SchemaObjects>; names: string[]; columns: Map<string, Promise<TableColumn[]>> }>();
    const cacheOf = (id: string) => {
      let c = schemaCache.get(id);
      if (!c) schemaCache.set(id, (c = { names: [], columns: new Map() }));
      return c;
    };
    /** 접속을 써서 무언가 읽는다. 쿼리를 실행하는 중이면 기다리지 않고 알린다 (접속 하나는 한 번에 한 가지만 한다) */
    const withSession = <T>(id: string, run: (c: import('oracledb').Connection) => Promise<T>): Promise<T> => {
      const s = sessions.get(id);
      if (!s) return Promise.reject(new Error('접속돼 있지 않습니다'));
      if (s.busy) return Promise.reject(new Error('쿼리를 실행하는 중입니다. 끝난 뒤에 새로 고침하세요'));
      return s.use(run);
    };

    const tree = new ConnectionTree(store, sessions, {
      objects: (id) => {
        const c = cacheOf(id);
        if (!c.objects) {
          c.objects = withSession(id, loadObjects);
          c.objects.then(
            (o) => {
              c.names = [...o.tables, ...o.views];
              queryConsole.sendTables(id); // 콘솔의 자동 완성에 테이블 이름
            },
            () => (c.objects = undefined) // 실패하면 다음에 다시
          );
        }
        return c.objects;
      },
      columns: (id, table) => {
        const c = cacheOf(id);
        let p = c.columns.get(table);
        if (!p) {
          p = withSession(id, (conn) => loadColumns(conn, table));
          c.columns.set(table, p);
          p.catch(() => c.columns.delete(table));
        }
        return p;
      },
    });

    /** 트리에서 누른 항목, 없으면(명령 팔레트) 목록에서 고른다 */
    const pick = async (item: ConnectionItem | undefined, title: string): Promise<DbConnectionConfig | undefined> => {
      if (item?.config) return store.get(item.config.id);
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
    // 접속이 닫힌 연결의 테이블 목록은 버린다 (다시 접속하면 새로 읽는다)
    const cacheWatcher = sessions.onDidChange(() => {
      for (const id of [...schemaCache.keys()]) if (!sessions.isConnected(id)) schemaCache.delete(id);
    });

    /** 연결 추가·수정 팝업이 요청하는 일 */
    const formActions: FormActions = {
      // 화면에 넣은 비밀번호 → 저장된 것 → 이번에 입력해 둔 것 순서로 쓴다
      test: async (config, password) => {
        const pw = password ?? (await store.password(config.id)) ?? typed.get(config.id);
        if (pw === undefined) return { ok: false, message: '비밀번호를 넣으세요' };
        try {
          const info = await testConnection(config, pw);
          return { ok: true, message: `접속 성공 — Oracle ${info.version} · DB ${info.dbName} · 스키마 ${info.schema} (${info.ms}ms)` };
        } catch (e) {
          return { ok: false, message: explainError(e) };
        }
      },
      save: async (config, password) => {
        await sessions.disconnect(config.id); // 주소·계정이 바뀌었을 수 있으니 접속은 끊는다
        typed.delete(config.id);
        await store.save(config, password);
        // 저장하지 않기로 한 비밀번호는 VS Code 를 닫을 때까지만 기억 (바로 접속할 때 다시 묻지 않게)
        if (!config.savePassword && password !== undefined) typed.set(config.id, password);
        vscode.window.setStatusBarMessage(`DB 연결 "${config.name}" 저장됨`, 4000);
      },
    };

    const results = new ResultView(context);
    const queryConsole = new DbConsole({
      context,
      store,
      sessions,
      results,
      formActions,
      ensureSession: async (cfg) => {
        if (!sessions.isConnected(cfg.id)) await connect(cfg);
        return sessions.get(cfg.id);
      },
      pickConnection: (title) => pick(undefined, title),
      tableNames: (id) => schemaCache.get(id)?.names ?? [],
    });

    const cmd = (name: string, run: (...args: any[]) => unknown) => vscode.commands.registerCommand(`devBoost.dbConsole.${name}`, run);

    return [
      store,
      { dispose: () => sessions.dispose() },
      tree,
      configWatcher,
      lostWatcher,
      cacheWatcher,
      results,
      queryConsole,
      vscode.window.registerTreeDataProvider(CONNECTIONS_VIEW_ID, tree),
      vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, { webviewOptions: { retainContextWhenHidden: true } }),

      // ── 연결 ──
      cmd('addConnection', () => queryConsole.showAddDialog()),

      cmd('editConnection', async (item?: ConnectionItem) => {
        const cfg = await pick(item, '수정할 DB 연결');
        if (!cfg) return;
        const hasSaved = cfg.savePassword && (await store.password(cfg.id)) !== undefined;
        queryConsole.showEditDialog(cfg, hasSaved);
      }),

      cmd('removeConnection', async (item?: ConnectionItem) => {
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

      cmd('testConnection', async (item?: ConnectionItem) => {
        const cfg = await pick(item, '접속을 테스트할 DB 연결');
        if (cfg) await test(cfg);
      }),

      cmd('connect', async (item?: ConnectionItem) => {
        const cfg = await pick(item, '접속할 DB 연결');
        if (cfg) await connect(cfg);
      }),

      cmd('disconnect', async (item?: ConnectionItem) => {
        const cfg = await pick(item, '접속을 끊을 DB 연결');
        if (!cfg) return;
        if (queryConsole.isDirty(cfg.id)) {
          // 접속을 닫으면 커밋하지 않은 변경은 롤백된다
          const go = '롤백하고 끊기';
          const answer = await vscode.window.showWarningMessage(
            `${cfg.name} 에 커밋하지 않은 변경이 있습니다. 접속을 끊으면 롤백됩니다.`,
            { modal: true },
            go
          );
          if (answer !== go) return;
        }
        await sessions.disconnect(cfg.id);
      }),

      cmd('refreshSchema', (item?: ConnectionItem) => {
        // 테이블·뷰·칸 목록을 다시 읽는다 (트리가 다시 그리면서 읽어 온다)
        if (item?.config) schemaCache.delete(item.config.id);
        else schemaCache.clear();
        tree.refresh();
      }),

      // ── 콘솔 ──
      cmd('openConsole', async (item?: ConnectionItem) => {
        const cfg = await pick(item, '콘솔을 열 DB 연결');
        if (cfg) queryConsole.open(cfg);
      }),
      cmd('run', () => queryConsole.trigger('run')),
      cmd('explain', () => queryConsole.trigger('explain')),
      cmd('commit', () => queryConsole.commit()),
      cmd('rollback', () => queryConsole.rollback()),
      cmd('insertName', (connectionId: string, name: string) => queryConsole.insertText(connectionId, name)),
    ];
  },
};
