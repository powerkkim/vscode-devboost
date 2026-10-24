import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { SearchService, TabId } from './search/searchService';
import { SearchEverywherePanel } from './ui/webviewPanel';
import { SearchEverywhereView, PANEL_VIEW_ID } from './ui/panelView';
import { openQuickPick } from './ui/quickPick';

/**
 * Search Everywhere 기능.
 * start()가 돌려준 Disposable들을 dispose하면 커맨드 등록·파일 감시가 모두 해제된다 (기능 OFF).
 */
export const searchEverywhere: Feature = {
  id: 'searchEverywhere',
  name: 'Search Everywhere',
  start(context) {
    const service = new SearchService(context);
    const panelView = new SearchEverywhereView(context, service);

    // 왼쪽 Activity Bar 아이콘은 ui 설정이 'panel'일 때만. 설정이 바뀌면 즉시 반영되도록 context key로 관리
    const uiSetting = () => vscode.workspace.getConfiguration('devBoost.searchEverywhere').get<string>('ui', 'popup');
    const syncContext = () =>
      void vscode.commands.executeCommand('setContext', 'devBoost.searchEverywhere.panelUi', uiSetting() === 'panel');
    syncContext();
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devBoost.searchEverywhere.ui')) {
        syncContext();
      }
    });
    const cmd = (command: string, tab: TabId) =>
      vscode.commands.registerCommand(`devBoost.searchEverywhere.${command}`, () => {
        // 설정 devBoost.searchEverywhere.ui:
        //   "popup"(기본: 에디터 탭) | "panel"(Activity Bar 사이드바) | "window"(별도 창) | "quickPick"(VS Code 기본 목록)
        const ui = uiSetting();
        if (ui === 'quickPick') {
          openQuickPick(service, tab);
        } else if (ui === 'popup' || ui === 'window') {
          SearchEverywherePanel.show(context, service, tab, ui);
        } else {
          void panelView.show(tab);
        }
      });
    return [
      configWatcher,
      { dispose: () => void vscode.commands.executeCommand('setContext', 'devBoost.searchEverywhere.panelUi', false) },
      vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panelView, {
        webviewOptions: { retainContextWhenHidden: true }, // 접었다 펴도 화면을 다시 만들지 않음 (빠름)
      }),
      cmd('open', 'all'),
      cmd('classes', 'classes'),
      cmd('files', 'files'),
      cmd('symbols', 'symbols'),
      cmd('actions', 'actions'),
      cmd('text', 'text'),
      service,
    ];
  },
};
