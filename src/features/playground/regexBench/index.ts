import * as vscode from 'vscode';
import { Feature } from '../../../core/feature';
import { closeRegexBench, flavorOf, openRegexBench } from './panel';

/**
 * 정규식 작업대 (Code Playground 묶음) — 정규식을 만들고 시험 글에 맞춰 보는 화면.
 * 자주 쓰는 정규식 · 질문 따라가기 · 예시로 만들기 · 직접 만들기, 그룹 표 · 바꾸기, JavaScript · Java 코드로 복사.
 * 명령을 실행할 때만 화면을 연다 (미리 읽거나 계속 돌아가는 것 없음).
 */
export const regexBench: Feature = {
  id: 'playground.regexBench',
  name: '정규식 작업대',
  switches: ['playground.enabled', 'playground.regexBench.enabled'],

  start(context) {
    const open = vscode.commands.registerCommand('devBoost.regexBench.open', () => {
      // 편집기에서 글을 골라 두었으면 시험 글로, 코드는 그 파일의 언어(JavaScript · Java)로
      const editor = vscode.window.activeTextEditor;
      const sample = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
      openRegexBench(context, editor ? { sample, flavor: flavorOf(editor.document.languageId) } : undefined);
    });
    return [open, { dispose: closeRegexBench }];
  },
};
