/**
 * 설정 이름이 바뀐 것들과, 적어 둔 값을 새 이름으로 옮기는 일. vscode 모듈에 의존하지 않는다 (단독 테스트 가능).
 *
 * 기능을 묶음(DB 콘솔 · 코드 도구)으로 정리하면서 설정도 묶음 아래로 옮겼다.
 * 옛 이름은 package.json 에 "이전 설정 이름"으로 남겨 두고(설정 화면에는 보이지 않음), 처음 켤 때 값을 옮긴 뒤 지운다.
 */

/** 옛 설정 → 새 설정 (`devBoost.` 뒤) */
export const RENAMED_SETTINGS: Readonly<Record<string, string>> = {
  'mybatisRunner.enabled': 'dbConsole.mybatis.enabled',
  'mybatisRunner.codeLens': 'dbConsole.mybatis.codeLens',
  'dbSchema.enabled': 'dbConsole.schema.enabled',
  'sqlLog.enabled': 'dbConsole.sqlLog.enabled',
  'sqlLog.autoDetect': 'dbConsole.sqlLog.autoDetect',
  'sqlLog.loggers': 'dbConsole.sqlLog.loggers',
  'sqlLog.maxQueries': 'dbConsole.sqlLog.maxRequests',
  // 0.34.0: 최근 쿼리 n개 → 최근 요청 n개
  'dbConsole.sqlLog.maxQueries': 'dbConsole.sqlLog.maxRequests',
  'importJump.enabled': 'codeTools.importJump.enabled',
  'importJump.aliases': 'codeTools.importJump.aliases',
  'importJump.hover': 'codeTools.importJump.hover',
  'caseConverter.enabled': 'codeTools.caseConverter.enabled',
  'caseConverter.output': 'codeTools.caseConverter.output',
  'caseConverter.java.dateType': 'codeTools.caseConverter.java.dateType',
  'caseConverter.ts.optional': 'codeTools.caseConverter.ts.optional',
  'caseConverter.ts.dateType': 'codeTools.caseConverter.ts.dateType',
  'caseConverter.ts.objectType': 'codeTools.caseConverter.ts.objectType',
  'caseConverter.mybatis.columnCase': 'codeTools.caseConverter.mybatis.columnCase',
  'caseConverter.mybatis.mapUnderscoreToCamelCase': 'codeTools.caseConverter.mybatis.mapUnderscoreToCamelCase',
  'caseConverter.mybatis.tablePrefix': 'codeTools.caseConverter.mybatis.tablePrefix',
};

/** 값을 적어 둘 수 있는 자리 (vscode.ConfigurationTarget 의 Global · Workspace) */
export type SettingScope = 'global' | 'workspace';

/** vscode.WorkspaceConfiguration 중 여기서 쓰는 부분 */
export interface SettingsLike {
  /** 그 자리에 직접 적어 둔 값 (기본값은 치지 않는다). 없으면 undefined */
  explicit(key: string, scope: SettingScope): unknown;
  /** 값을 적는다. undefined 면 지운다 */
  write(key: string, value: unknown, scope: SettingScope): Promise<void>;
}

/**
 * 옛 이름에 적어 둔 값을 새 이름으로 옮긴다. 새 이름에 이미 값이 있으면 그 값을 두고 옛 것만 지운다.
 * 옮긴 설정 이름(새 이름)들을 돌려준다. 한 항목이 실패해도(작업 영역이 없어 쓸 수 없는 경우 등) 나머지는 계속한다
 */
export async function migrateSettings(settings: SettingsLike, renamed: Readonly<Record<string, string>> = RENAMED_SETTINGS): Promise<string[]> {
  const moved: string[] = [];
  for (const [oldKey, newKey] of Object.entries(renamed)) {
    for (const scope of ['global', 'workspace'] as const) {
      try {
        const value = settings.explicit(oldKey, scope);
        if (value === undefined) continue;
        if (settings.explicit(newKey, scope) === undefined) {
          await settings.write(newKey, value, scope);
          moved.push(newKey);
        }
        await settings.write(oldKey, undefined, scope);
      } catch {
        // 이 항목은 그대로 둔다 (다음에 켤 때 다시 시도)
      }
    }
  }
  return moved;
}
