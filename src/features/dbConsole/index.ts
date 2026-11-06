import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { DbConnectionConfig } from './connection/config';
import type { SchemaObjects, TableColumn } from './driver/types';
import type { DbSession } from './driver/session';
import { driverFor, describeConnection } from './driver/registry';
import { ConnectionStore } from './connectionStore';
import { ConsoleStore } from './consoleStore';
import { HistoryStore } from './historyStore';
import { Sessions } from './sessions';
import { ConnectionItem, ConnectionTree, TableItem, TreeNode, CONNECTIONS_VIEW_ID } from './ui/connectionTree';
import { ResultView, RESULTS_VIEW_ID } from './ui/resultView';
import { FormActions } from './ui/formDialog';
import { TableInfoPanel } from './ui/tableInfo';
import { DbConsole } from './console';
import { parseNameFilter } from './sql/nameFilter';
import { JoinTable, buildCount, buildJoin, buildSelect } from './sql/joinBuilder';

/**
 * DB 콘솔 — DB 에 직접 접속해 쿼리를 실행한다. 지금은 Oracle (node-oracledb Thin 모드, Oracle Client 설치 불필요, 12.1 이상).
 * DB마다 다른 일은 drivers/<db>/ 가 하고, 여기와 콘솔·결과 화면은 driver/types.ts 의 약속만 본다.
 *  - 사이드바 DevBoost → "DB 연결": 연결 목록과 테이블·뷰·시노님·칸. 이름 필터, 스키마 바꾸기, 여러 개 골라 SELECT·JOIN 만들기
 *  - 콘솔 탭: 실행 도구 줄 · 파라미터 줄 · SQL 편집기. 결과는 실행한 문장 아래에도 나온다. 연결 추가·수정 팝업도 여기에 뜬다
 *  - 하단 패널 "DB 결과": 결과 표 · 실행계획 · 메시지
 */
export const dbConsole: Feature = {
  id: 'dbConsole',
  name: 'DB 콘솔',
  start(context) {
    const store = new ConnectionStore(context);
    const consoles = new ConsoleStore(context);
    const history = new HistoryStore(context);
    const sessions = new Sessions();
    /** 저장하지 않는 비밀번호: VS Code 를 닫을 때까지만 기억 (접속할 때마다 다시 묻지 않게) */
    const typed = new Map<string, string>();

    // ── 딕셔너리 캐시: 연결 → 스키마 → 테이블·뷰·칸 (접속해 있는 동안 기억. 새로 고침이나 접속이 닫히면 비운다) ──
    interface OwnerCache {
      objects?: Promise<SchemaObjects>;
      columns: Map<string, Promise<TableColumn[]>>;
      keys?: Promise<Record<string, string[]>>;
    }
    const cache = new Map<string, Map<string, OwnerCache>>();
    const ownerCache = (id: string, owner: string) => {
      let byOwner = cache.get(id);
      if (!byOwner) cache.set(id, (byOwner = new Map()));
      let c = byOwner.get(owner);
      if (!c) byOwner.set(owner, (c = { columns: new Map() }));
      return c;
    };
    /** 자동 완성에 넣을 이름 (지금 보는 스키마의 테이블·뷰·시노님) */
    const completion = new Map<string, string[]>();

    /** 접속을 써서 무언가 읽는다. 쿼리를 실행하는 중이면 끝난 뒤에 읽는다 (접속 하나는 한 번에 한 가지만 한다) */
    const withSession = <T>(id: string, run: (s: DbSession) => Promise<T>): Promise<T> => {
      const s = sessions.get(id);
      if (!s) return Promise.reject(new Error('접속돼 있지 않습니다'));
      return run(s);
    };
    /** 트리에서 보는 스키마: 바꿔 둔 것, 없으면 접속한 계정의 스키마 */
    const ownerOf = (id: string) => store.view(id).schema ?? sessions.get(id)?.info.schema;

    const objectsOf = (id: string, owner: string) => {
      const c = ownerCache(id, owner);
      if (!c.objects) {
        const p = withSession(id, (s) => s.use((conn) => conn.meta.objects(owner)));
        c.objects = p;
        p.then(
          (o) => {
            if (ownerOf(id) === owner) {
              completion.set(id, [...o.tables, ...o.views, ...o.synonyms.map((x) => x.name)]);
              queryConsole.sendTables(id); // 콘솔의 자동 완성에 테이블 이름
            }
          },
          () => (c.objects = undefined) // 실패하면 다음에 다시
        );
      }
      return c.objects;
    };
    const columnsOf = (id: string, owner: string, table: string) => {
      const c = ownerCache(id, owner);
      let p = c.columns.get(table);
      if (!p) {
        p = withSession(id, (s) => s.use((conn) => conn.meta.columns(owner, table)));
        c.columns.set(table, p);
        p.catch(() => c.columns.delete(table));
      }
      return p;
    };

    /**
     * 쿼리에 쓴 이름 → 실제 테이블 (스키마·이름). 대소문자를 가리지 않고 테이블·뷰·시노님에서 찾는다.
     * OWNER.이름 이면 그 스키마에서. 시노님이면 가리키는 테이블로
     */
    const resolveTable = async (id: string, name: string): Promise<{ owner: string; name: string } | undefined> => {
      const parts = name.replace(/"/g, '').split('.');
      const owner = parts.length > 1 ? parts[0] : ownerOf(id);
      const want = parts[parts.length - 1];
      if (!owner) return undefined;
      const findIn = async (o: string) => {
        const objs = await objectsOf(id, o).catch(() => undefined);
        if (!objs) return undefined;
        const eq = (n: string) => n.toUpperCase() === want.toUpperCase();
        const hit = [...objs.tables, ...objs.views].find(eq);
        if (hit) return { owner: o, name: hit };
        const syn = objs.synonyms.find((x) => eq(x.name));
        return syn ? { owner: syn.targetOwner, name: syn.targetName } : undefined;
      };
      // 대소문자를 DB가 저장한 대로 맞춘다 (Oracle 대문자, PostgreSQL 소문자)
      const owners = [owner, owner.toUpperCase(), owner.toLowerCase()].filter((o, i, a) => a.indexOf(o) === i);
      for (const o of owners) {
        const r = await findIn(o);
        if (r) return r;
      }
      return undefined;
    };

    const tree = new ConnectionTree(store, sessions, {
      owner: ownerOf,
      loginSchema: (id) => sessions.get(id)?.info.schema,
      objects: objectsOf,
      columns: columnsOf,
    });
    const treeView = vscode.window.createTreeView<TreeNode>(CONNECTIONS_VIEW_ID, { treeDataProvider: tree, canSelectMany: true, showCollapseAll: true });

    /** 트리에서 누른 항목, 없으면(명령 팔레트) 목록에서 고른다 */
    const pick = async (item: TreeNode | undefined, title: string): Promise<DbConnectionConfig | undefined> => {
      if (item instanceof ConnectionItem) return store.get(item.config.id);
      if (item instanceof TableItem) return store.get(item.connectionId);
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
      const errors = driverFor(cfg).errors;
      if (errors.isAuthFailure(e)) typed.delete(cfg.id);
      const edit = '연결 수정';
      void vscode.window.showErrorMessage(`${cfg.name} ${doing} 실패: ${errors.explain(e)}`, edit).then((b) => {
        if (b === edit) void vscode.commands.executeCommand('devBoost.dbConsole.editConnection', new ConnectionItem(cfg, 'disconnected'));
      });
    };

    /** 접속해 보고 바로 닫는다 */
    const tryOpen = async (cfg: DbConnectionConfig, password: string) => {
      const { connection, info } = await driverFor(cfg).open(cfg, password);
      await connection.close().catch(() => undefined);
      return info;
    };

    const test = async (cfg: DbConnectionConfig) => {
      const pw = await passwordFor(cfg);
      if (pw === undefined) return;
      try {
        const info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${cfg.name} 접속 테스트 중…` }, () =>
          tryOpen(cfg, pw.value)
        );
        if (!pw.saved) typed.set(cfg.id, pw.value);
        void vscode.window.showInformationMessage(`${cfg.name} 접속 성공 — ${info.product} ${info.version} · DB ${info.dbName} · 스키마 ${info.schema} (${info.ms}ms)`);
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
        vscode.window.setStatusBarMessage(`${cfg.name} 접속됨 — ${s.info.product} ${s.info.version} · 스키마 ${s.info.schema}`, 5000);
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
      for (const id of [...cache.keys()]) {
        if (!sessions.isConnected(id)) {
          cache.delete(id);
          completion.delete(id);
        }
      }
    });

    /** 연결 추가·수정 팝업이 요청하는 일 */
    const formActions: FormActions = {
      // 화면에 넣은 비밀번호 → 저장된 것 → 이번에 입력해 둔 것 순서로 쓴다
      test: async (config, password) => {
        const pw = password ?? (await store.password(config.id)) ?? typed.get(config.id);
        if (pw === undefined) return { ok: false, message: '비밀번호를 넣으세요' };
        try {
          const info = await tryOpen(config, pw);
          return { ok: true, message: `접속 성공 — ${info.product} ${info.version} · DB ${info.dbName} · 스키마 ${info.schema} (${info.ms}ms)` };
        } catch (e) {
          return { ok: false, message: driverFor(config).errors.explain(e) };
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
      consoles,
      history,
      sessions,
      results,
      formActions,
      ensureSession: async (cfg) => {
        if (!sessions.isConnected(cfg.id)) await connect(cfg);
        return sessions.get(cfg.id);
      },
      pickConnection: (title) => pick(undefined, title),
      tableNames: (id) => completion.get(id) ?? [],
      columnNames: async (id, name) => {
        const t = await resolveTable(id, name);
        return t ? (await columnsOf(id, t.owner, t.name)).map((c) => c.name) : [];
      },
    });

    // ── 트리에서 고른 테이블로 쿼리 만들기 ──

    /** 오른쪽 클릭한 항목과 함께 고른 테이블들 (같은 연결·같은 스키마만, 고른 순서대로) */
    const chosenTables = (item: TreeNode | undefined, items: TreeNode[] | undefined): TableItem[] => {
      const all = (items?.length ? items : item ? [item] : treeView.selection).filter((n): n is TableItem => n instanceof TableItem);
      const first = item instanceof TableItem ? item : all[0];
      if (!first) return [];
      const same = all.filter((t) => t.connectionId === first.connectionId && t.owner === first.owner);
      // 오른쪽 클릭한 테이블을 맨 앞에 (JOIN 의 기준)
      return [first, ...same.filter((t) => t !== first)];
    };

    /** 칸·기본 키를 읽어 쿼리 재료로 */
    const joinTables = async (tables: TableItem[]): Promise<JoinTable[]> => {
      const id = tables[0].connectionId;
      const targets = tables.map((t) => t.target);
      const owners = [...new Set(targets.map((t) => t.owner))];
      const keys: Record<string, string[]> = {};
      for (const owner of owners) {
        const names = targets.filter((t) => t.owner === owner).map((t) => t.name);
        const got = await withSession(id, (s) => s.use((c) => c.meta.primaryKeys(owner, names))).catch(() => ({}) as Record<string, string[]>);
        for (const [k, v] of Object.entries(got)) keys[`${owner}.${k}`] = v;
      }
      return Promise.all(
        tables.map(async (t) => ({
          name: t.target.name,
          qualified: t.qualified,
          columns: (await columnsOf(id, t.target.owner, t.target.name).catch(() => [] as TableColumn[])).map((c) => c.name),
          primaryKey: keys[`${t.target.owner}.${t.target.name}`] ?? [],
        }))
      );
    };

    const makeQuery = async (item: TreeNode | undefined, items: TreeNode[] | undefined, what: 'select' | 'join' | 'count', run: boolean) => {
      const tables = chosenTables(item, items);
      if (!tables.length) {
        void vscode.window.showInformationMessage('DB 연결 목록에서 테이블을 고르세요 (Ctrl·Shift 로 여러 개).');
        return;
      }
      if (what === 'join' && tables.length < 2) {
        void vscode.window.showInformationMessage('JOIN 은 테이블을 두 개 이상 골라야 합니다 (Ctrl·Shift 로 여러 개 고른 뒤 오른쪽 클릭).');
        return;
      }
      const id = tables[0].connectionId;
      const text = await vscode.window.withProgress({ location: { viewId: CONNECTIONS_VIEW_ID } }, async () => {
        const jt = await joinTables(tables);
        if (what === 'count') return jt.map(buildCount).join('\n');
        if (what === 'select') return jt.map(buildSelect).join('\n\n');
        // 참조 관계는 같은 스키마 안의 실제 테이블끼리만 (시노님은 가리키는 테이블로)
        const owner = tables[0].target.owner;
        const sameOwner = tables.filter((t) => t.target.owner === owner).map((t) => t.target.name);
        const relations = await withSession(id, (s) => s.use((c) => c.meta.relations(owner, sameOwner))).catch(() => []);
        const r = buildJoin(jt, relations);
        const notes = [
          r.guessed.length ? `칸 이름으로 짐작해 이었습니다: ${r.guessed.join(', ')}` : '',
          r.unresolved.length ? `잇는 칸을 찾지 못했습니다: ${r.unresolved.join(', ')}` : '',
        ].filter(Boolean);
        if (notes.length) vscode.window.setStatusBarMessage(notes.join(' · '), 8000);
        return r.sql;
      });
      queryConsole.insertText(id, text, { asBlock: true, run });
    };

    const cmd = (name: string, run: (...args: any[]) => unknown) => vscode.commands.registerCommand(`devBoost.dbConsole.${name}`, run);

    return [
      store,
      { dispose: () => sessions.dispose() },
      tree,
      treeView,
      configWatcher,
      lostWatcher,
      cacheWatcher,
      results,
      queryConsole,
      history,
      { dispose: () => TableInfoPanel.closeAll() },
      vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, { webviewOptions: { retainContextWhenHidden: true } }),

      // ── 연결 ──
      cmd('addConnection', () => queryConsole.showAddDialog()),

      cmd('editConnection', async (item?: TreeNode) => {
        const cfg = await pick(item, '수정할 DB 연결');
        if (!cfg) return;
        const hasSaved = cfg.savePassword && (await store.password(cfg.id)) !== undefined;
        queryConsole.showEditDialog(cfg, hasSaved);
      }),

      cmd('removeConnection', async (item?: TreeNode) => {
        const cfg = await pick(item, '삭제할 DB 연결');
        if (!cfg) return;
        const yes = '삭제';
        const answer = await vscode.window.showWarningMessage(`DB 연결 "${cfg.name}" 을 삭제할까요? 저장된 비밀번호도 지워집니다.`, { modal: true }, yes);
        if (answer !== yes) return;
        await sessions.disconnect(cfg.id);
        typed.delete(cfg.id);
        await store.remove(cfg.id);
        await consoles.remove(cfg.id);
        await history.remove(cfg.id);
      }),

      cmd('testConnection', async (item?: TreeNode) => {
        const cfg = await pick(item, '접속을 테스트할 DB 연결');
        if (cfg) await test(cfg);
      }),

      cmd('connect', async (item?: TreeNode) => {
        const cfg = await pick(item, '접속할 DB 연결');
        if (cfg) await connect(cfg);
      }),

      cmd('disconnect', async (item?: TreeNode) => {
        const cfg = await pick(item, '접속을 끊을 DB 연결');
        if (!cfg) return;
        if (queryConsole.isDirty(cfg.id)) {
          // 접속을 닫으면 커밋하지 않은 변경은 롤백된다
          const go = '롤백하고 끊기';
          const answer = await vscode.window.showWarningMessage(`${cfg.name} 에 커밋하지 않은 변경이 있습니다. 접속을 끊으면 롤백됩니다.`, { modal: true }, go);
          if (answer !== go) return;
        }
        await sessions.disconnect(cfg.id);
      }),

      cmd('refreshSchema', (item?: TreeNode) => {
        // 테이블·뷰·칸 목록을 다시 읽는다 (트리가 다시 그리면서 읽어 온다)
        if (item instanceof ConnectionItem) cache.delete(item.config.id);
        else cache.clear();
        tree.refresh();
      }),

      // ── 트리: 필터·스키마 ──
      cmd('setFilter', async (item?: TreeNode) => {
        const cfg = await pick(item, '테이블 필터를 걸 DB 연결');
        if (!cfg) return;
        const view = store.view(cfg.id);
        const text = await vscode.window.showInputBox({
          title: `${cfg.name} — 테이블 필터`,
          prompt: '앞부분(TB_PLM), 와일드카드(*_HIST, *PART*), 빼기(!*_BAK). 쉼표로 여러 개. 비우면 전부',
          value: view.filter ?? '',
          placeHolder: 'TB_PLM, TB_CM_*, !*_BAK',
        });
        if (text === undefined) return;
        await store.setView(cfg.id, { ...view, filter: parseNameFilter(text).text || undefined });
        tree.refresh();
      }),

      cmd('clearFilter', async (item?: TreeNode) => {
        const cfg = await pick(item, '필터를 지울 DB 연결');
        if (!cfg) return;
        await store.setView(cfg.id, { ...store.view(cfg.id), filter: undefined });
        tree.refresh();
      }),

      cmd('changeSchema', async (item?: TreeNode) => {
        const cfg = await pick(item, '스키마를 바꿀 DB 연결');
        if (!cfg) return;
        const s = sessions.get(cfg.id);
        if (!s) {
          void vscode.window.showInformationMessage(`${cfg.name} 에 먼저 접속하세요.`);
          return;
        }
        let list: string[] | undefined;
        try {
          list = await vscode.window.withProgress({ location: { viewId: CONNECTIONS_VIEW_ID } }, () => s.use((c) => c.meta.schemas()));
        } catch (e) {
          void vscode.window.showErrorMessage(`스키마 목록을 가져오지 못했습니다: ${s.driver.errors.explain(e)}`);
        }
        if (!list) return;
        const current = ownerOf(cfg.id);
        const names = [...new Set([s.info.schema, ...list])];
        const chosen = await vscode.window.showQuickPick(
          names.map((n) => ({ label: n, description: [n === s.info.schema ? '접속한 계정' : '', n === current ? '지금 보는 중' : ''].filter(Boolean).join(' · ') })),
          { title: `${cfg.name} — 트리에서 볼 스키마`, placeHolder: '권한이 있는 테이블·뷰만 보입니다' }
        );
        if (!chosen) return;
        await store.setView(cfg.id, { ...store.view(cfg.id), schema: chosen.label === s.info.schema ? undefined : chosen.label });
        completion.delete(cfg.id);
        tree.refresh();
      }),

      // ── 트리: 고른 테이블로 쿼리 ──
      cmd('selectQuery', (item?: TreeNode, items?: TreeNode[]) => makeQuery(item, items, 'select', false)),
      cmd('selectRun', (item?: TreeNode, items?: TreeNode[]) => makeQuery(item, items, 'select', true)),
      cmd('joinQuery', (item?: TreeNode, items?: TreeNode[]) => makeQuery(item, items, 'join', false)),
      cmd('joinRun', (item?: TreeNode, items?: TreeNode[]) => makeQuery(item, items, 'join', true)),
      cmd('countRun', (item?: TreeNode, items?: TreeNode[]) => makeQuery(item, items, 'count', true)),

      cmd('tableInfo', async (item?: TreeNode) => {
        if (!(item instanceof TableItem)) {
          void vscode.window.showInformationMessage('DB 연결 목록에서 테이블을 오른쪽 클릭하세요.');
          return;
        }
        const cfg = store.get(item.connectionId);
        const s = sessions.get(item.connectionId);
        if (!cfg || !s) return;
        const { owner, name } = item.target;
        try {
          const data = await vscode.window.withProgress({ location: { viewId: CONNECTIONS_VIEW_ID } }, async () => {
            const schema = await s.use((c) => c.meta.collect(owner, [name]));
            const referencedBy = await s.use((c) => c.meta.referencedBy(owner, name)).catch(() => []);
            const kind = schema.tables.find((t) => t.name === name)?.kind ?? (item.kind === 'views' ? 'view' : 'table');
            let ddl: string | undefined;
            let ddlError: string | undefined;
            const get = s.connection.meta.ddl;
            if (get) {
              try {
                ddl = await s.use((c) => c.meta.ddl!(owner, name, kind));
              } catch (e) {
                ddlError = `DDL 을 가져오지 못했습니다: ${s.driver.errors.explain(e)}`;
              }
            } else ddlError = '이 DB에서는 DDL 을 가져올 수 없습니다.';
            return { connectionName: cfg.name, owner, table: name, schema, referencedBy, ddl, ddlError };
          });
          TableInfoPanel.show(context, `${cfg.id}/${owner}/${name}`, data);
        } catch (e) {
          void vscode.window.showErrorMessage(`테이블 정보를 가져오지 못했습니다: ${s.driver.errors.explain(e)}`);
        }
      }),

      // ── 콘솔 ──
      cmd('openConsole', async (item?: TreeNode) => {
        const cfg = await pick(item, '콘솔을 열 DB 연결');
        if (cfg) queryConsole.open(cfg);
      }),
      cmd('run', () => queryConsole.trigger('run')),
      cmd('explain', () => queryConsole.trigger('explain')),
      cmd('selectStatement', () => queryConsole.trigger('selectStatement')),
      cmd('format', () => queryConsole.trigger('format')),
      cmd('history', (item?: TreeNode) => queryConsole.showHistory(item instanceof ConnectionItem ? store.get(item.config.id) : undefined)),
      cmd('commit', () => queryConsole.commit()),
      cmd('rollback', () => queryConsole.rollback()),
      cmd('insertName', (connectionId: string, name: string) => queryConsole.insertText(connectionId, name)),

      /**
       * 다른 기능(MyBatis SQL 실행 등)이 만든 SQL 을 콘솔에 넣고 실행한다.
       * 연결: 지난번에 고른 연결(작업 폴더마다 기억), 연결이 하나면 그것, 아니면 고르게 한다
       */
      cmd('runSql', async (sqlText: string, opts?: { run?: boolean; pick?: boolean }) => {
        if (!sqlText?.trim()) return;
        const list = store.list();
        if (!list.length) {
          await pick(undefined, '');
          return;
        }
        const KEY = 'devBoost.dbConsole.runSqlTarget';
        const last = context.workspaceState.get<string>(KEY);
        let cfg = !opts?.pick ? (store.get(last ?? '') ?? (list.length === 1 ? list[0] : undefined)) : undefined;
        if (!cfg) {
          cfg = await pick(undefined, 'SQL 을 실행할 DB 연결');
          if (!cfg) return;
        }
        await context.workspaceState.update(KEY, cfg.id);
        const text = /;\s*$/.test(sqlText.trim()) ? sqlText.trim() : sqlText.trim() + ';';
        queryConsole.insertText(cfg.id, text, { asBlock: true, run: opts?.run !== false });
      }),
    ];
  },
};
