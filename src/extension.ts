import * as vscode from 'vscode';
import { Feature } from './core/feature';
import { migrateSettings, SettingScope } from './core/settings';
import { searchEverywhere } from './features/searchEverywhere';
import { dbConsole } from './features/dbConsole';
import { Sessions } from './features/dbConsole/sessions';
import { mybatisRunner } from './features/dbConsole/mybatis';
import { sqlLog } from './features/dbConsole/sqlLog';
import { dbSchema } from './features/dbConsole/schema';
import { apiConsole } from './features/apiConsole';
import { sourceAtlas } from './features/sourceAtlas';
import { importJump } from './features/codeTools/importJump';
import { caseConverter } from './features/codeTools/caseConverter';
import { jsBench } from './features/playground/jsBench';
import { regexBench } from './features/playground/regexBench';

/**
 * 기능 목록 — 묶음별로.
 * 새 기능을 추가할 때는
 *  1) src/features/<묶음>/<기능>/index.ts 에 Feature 구현 (switches: 묶음 스위치 + 기능 스위치)
 *  2) 아래 배열에 추가
 *  3) package.json 에 스위치 설정과 명령(when 조건에 두 스위치 모두) 추가 — test/core/manifest.test.js 가 맞는지 확인한다
 */
const FEATURES: Feature[] = [
  searchEverywhere,
  // DB 콘솔
  dbConsole,
  mybatisRunner,
  sqlLog,
  dbSchema,
  apiConsole,
  sourceAtlas,
  // 코드 도구
  importJump,
  caseConverter,
  // Code Playground
  jsBench,
  regexBench,
];

/** 현재 켜져 있는 기능 → 그 기능이 등록한 Disposable 목록 */
const running = new Map<string, vscode.Disposable[]>();

function isEnabled(f: Feature): boolean {
  const cfg = vscode.workspace.getConfiguration('devBoost');
  return f.switches.every((key) => cfg.get<boolean>(key, true));
}

/** 이름이 바뀐 설정에 적어 둔 값을 새 이름으로 옮긴다 (한 번 옮기면 옛 값은 지워져 다음부터는 할 일이 없다) */
async function moveRenamedSettings() {
  const cfg = vscode.workspace.getConfiguration('devBoost');
  const target = (scope: SettingScope) => (scope === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  await migrateSettings({
    explicit: (key, scope) => {
      const found = cfg.inspect(key);
      return scope === 'global' ? found?.globalValue : found?.workspaceValue;
    },
    write: (key, value, scope) => Promise.resolve(cfg.update(key, value, target(scope))),
  });
}

function startFeature(f: Feature, context: vscode.ExtensionContext) {
  if (running.has(f.id)) {
    return;
  }
  try {
    running.set(f.id, f.start(context));
  } catch (e) {
    vscode.window.showErrorMessage(`DevBoost: ${f.name} 시작 실패 - ${e}`);
  }
}

function stopFeature(f: Feature) {
  running.get(f.id)?.forEach((d) => d.dispose());
  running.delete(f.id);
}

/** 설정과 실제 상태를 맞춘다: 켜져야 하는데 꺼진 건 start, 반대는 stop */
function sync(context: vscode.ExtensionContext) {
  for (const f of FEATURES) {
    if (isEnabled(f)) {
      startFeature(f, context);
    } else {
      stopFeature(f);
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // 옛 이름의 스위치를 꺼 둔 사람은 새 이름에서도 꺼진 채로 시작해야 하므로, 기능을 켜기 전에 옮긴다
  await moveRenamedSettings().catch(() => undefined);
  sync(context);

  // 설정 화면에서 체크박스를 바꾸면 창을 다시 열지 않아도 즉시 반영
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devBoost')) {
        sync(context);
      }
    }),
    { dispose: () => FEATURES.forEach(stopFeature) }
  );
}

/** 끌 때: DB 접속을 모두 닫고 기다린다 (실행 중인 쿼리는 서버에서 멈춘 뒤) — 서버에 세션이 남지 않게 */
export function deactivate(): Promise<void> {
  return Sessions.closeAll();
}
