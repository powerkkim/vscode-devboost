import * as vscode from 'vscode';
import { Feature } from '../../core/feature';
import { OracleBridge } from '../../core/oracleBridge';
import { SchemaStore } from './schemaStore';
import { SchemaPanel } from './ui/schemaPanel';

/**
 * DB 스키마 — DB 에 직접 접속하지 않고, 수집 SQL 결과를 가져와 .devboost/schema/*.json 으로 저장한다.
 * 저장한 스키마로 테이블 정의서(Excel: 목차 + 테이블별 시트)를 만든다. 규격: docs/SPEC-db-schema-v8-2026-10-26.md
 */
export const dbSchema: Feature = {
  id: 'dbSchema',
  name: 'DB 스키마',
  start(context) {
    const oracle = new OracleBridge();
    const deps = { store: new SchemaStore(), oracle };
    const open = vscode.commands.registerCommand('devBoost.dbSchema.open', () => SchemaPanel.show(context, deps));
    return [open, oracle, { dispose: () => SchemaPanel.closeAll() }];
  },
};
