import * as vscode from 'vscode';
import { Feature } from './core/feature';
import { searchEverywhere } from './features/searchEverywhere';
import { sourceAtlas } from './features/sourceAtlas';
import { mybatisRunner } from './features/mybatisRunner';
import { dbSchema } from './features/dbSchema';
import { caseConverter } from './features/caseConverter';

/**
 * 새 기능을 추가할 때는
 *  1) src/features/<기능>/index.ts 에 Feature 구현
 *  2) 아래 배열에 추가
 *  3) package.json 에 devBoost.<기능>.enabled 설정과 커맨드(when 조건 포함) 추가
 */
const FEATURES: Feature[] = [searchEverywhere, sourceAtlas, mybatisRunner, dbSchema, caseConverter];

/** 현재 켜져 있는 기능 → 그 기능이 등록한 Disposable 목록 */
const running = new Map<string, vscode.Disposable[]>();

function isEnabled(f: Feature): boolean {
  return vscode.workspace.getConfiguration('devBoost').get<boolean>(`${f.id}.enabled`, true);
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

export function activate(context: vscode.ExtensionContext) {
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

export function deactivate() {}
