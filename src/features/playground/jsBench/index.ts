import * as vscode from 'vscode';
import { Feature } from '../../../core/feature';
import { closeJsBench, openJsBench } from './panel';

/**
 * JavaScript 작업대 (Code Playground 묶음) — 예제 데이터와 함께 JS · TS 를 바로 돌려 보는 화면.
 * 실무 예제에서 고르기, 칸을 골라 배열 가공 코드 만들기, 입력 데이터 바꾸기(엑셀 표 → JSON, JSON → TS 타입 …).
 * 명령을 실행할 때만 화면과 예제를 읽는다 (미리 읽거나 계속 돌아가는 것 없음).
 */
const TS_LANGS = new Set(['typescript', 'typescriptreact']);

export const jsBench: Feature = {
  id: 'playground.jsBench',
  name: 'JavaScript 작업대',
  switches: ['playground.enabled', 'playground.jsBench.enabled'],

  start(context) {
    const open = vscode.commands.registerCommand('devBoost.jsBench.open', () => {
      // 편집기에서 글을 골라 두었으면 그 코드로 연다
      const editor = vscode.window.activeTextEditor;
      const code = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      openJsBench(context, code.trim() ? { code, typescript: TS_LANGS.has(editor!.document.languageId) } : undefined);
    });
    return [open, { dispose: closeJsBench }];
  },
};
