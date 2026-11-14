import * as vscode from 'vscode';

/**
 * DevBoost의 기능 하나.
 * Spring의 @ConditionalOnProperty 빈처럼, 설정 스위치가 모두 true일 때만 start()된다.
 *
 * 기능은 묶음으로 나뉜다 — 묶음 스위치와 그 안의 기능 스위치가 둘 다 켜져야 동작한다.
 *   DB 콘솔(dbConsole)   : 연결·콘솔, Mapper 쿼리 실행(mybatis), SQL 로그(sqlLog), 스키마(schema)
 *   코드 도구(codeTools) : import 따라가기(importJump), 케이스 변환(caseConverter)
 *   Search Everywhere · API 콘솔 · Source Atlas 는 묶음 하나에 기능 하나
 */
export interface Feature {
  /** 기능을 가리키는 이름 (실행 상태를 기억하는 열쇠). 예: dbConsole.sqlLog */
  readonly id: string;
  /** 사용자에게 보이는 이름 */
  readonly name: string;
  /**
   * 켜져 있어야 하는 설정들 (`devBoost.` 뒤). 묶음 스위치부터 적는다.
   * 예: ['dbConsole.enabled', 'dbConsole.sqlLog.enabled']
   */
  readonly switches: readonly string[];
  /** 기능을 켠다. 반환한 Disposable들은 기능을 끌 때 모두 dispose된다. */
  start(context: vscode.ExtensionContext): vscode.Disposable[];
}
