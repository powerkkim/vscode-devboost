import * as vscode from 'vscode';

/**
 * DevBoost의 기능 하나.
 * Spring의 @ConditionalOnProperty 빈처럼, 설정 `devBoost.<id>.enabled` 가 true일 때만 start()된다.
 */
export interface Feature {
  /** 설정 키와 커맨드 접두어에 쓰이는 ID. 예: searchEverywhere → devBoost.searchEverywhere.enabled */
  readonly id: string;
  /** 사용자에게 보이는 이름 */
  readonly name: string;
  /** 기능을 켠다. 반환한 Disposable들은 기능을 끌 때 모두 dispose된다. */
  start(context: vscode.ExtensionContext): vscode.Disposable[];
}
