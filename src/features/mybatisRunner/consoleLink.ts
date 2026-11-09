import * as vscode from 'vscode';
import { MapperDoc, MapperStatement } from './mapper/mapperDoc';
import { buildConsoleRun, ConsoleParam, PanelSpec, panelSpecs } from './mapper/consoleSql';
import { ParamInput } from './mapper/values';
import { MapperIndex } from './mapperIndex';
import { RunnerStore } from './store';

/**
 * MyBatis mapper ↔ DevBoost DB 콘솔.
 *  - sendToConsole: 쿼리를 콘솔 끝에 "-- 네임스페이스.id" 머리 주석과 함께 넣고 실행
 *  - consolePanel: 콘솔이 그 머리 주석 아래 문장을 고르면 왼쪽 패널에 보일 파라미터·조건 상태와,
 *    값이 바뀌었을 때 다시 푼 SQL·:이름 값을 돌려준다 (명령 devBoost.mybatisRunner.consolePanel)
 * 동적 태그(if/choose/foreach)는 패널 값으로 풀고, #{} 는 :이름 파라미터로 남긴다.
 */
export interface Deps {
  store: RunnerStore;
  index: MapperIndex;
}

export type ConsolePanelReply =
  | {
      ok: true;
      ns: string;
      id: string;
      specs: (PanelSpec & { input: ParamInput })[];
      /** 콘솔 문장 자리에 넣을 SQL (머리 주석 제외) */
      sql: string;
      /** :이름 → 값 (콘솔 파라미터) */
      params: Record<string, ConsoleParam>;
      warnings: string[];
    }
  | { ok: false; ns: string; id: string; why: string };

function render(deps: Deps, doc: MapperDoc, st: MapperStatement) {
  return deps.store.prepare(doc, st, deps.index.resolver(), 'bind', { ignoreOverrides: true });
}

/** 쿼리를 콘솔로 보내 실행. 보낼 SQL 이 비어 있으면 false */
export async function sendToConsole(deps: Deps, doc: MapperDoc, st: MapperStatement): Promise<boolean> {
  const p = render(deps, doc, st);
  if (!p.result.sql.trim()) return false;
  const run = buildConsoleRun(p.result.sql, p.result.binds, `${doc.namespace}.${st.id}`);
  await vscode.commands.executeCommand('devBoost.dbConsole.runSql', run.text, { params: run.params });
  return true;
}

/** 콘솔 패널: (ns, id) 의 파라미터와 SQL. set 이 있으면 그 값을 먼저 저장한다 */
export async function consolePanel(deps: Deps, ns: string, id: string, set?: { path: string; input: ParamInput }): Promise<ConsolePanelReply> {
  await deps.index.ensureBuilt();
  const doc = deps.index.docFor(ns);
  if (!doc) return { ok: false, ns, id, why: `mapper ${ns} 를 찾지 못했습니다` };
  const st = doc.statements.find((s) => s.id === id);
  if (!st) return { ok: false, ns, id, why: `${ns} 에 ${id} 쿼리가 없습니다` };
  if (set && typeof set.path === 'string') {
    deps.store.setInput(`${doc.namespace || doc.file}.${st.id}`, set.path, { type: set.input?.type ?? 'auto', value: String(set.input?.value ?? '') });
  }
  const p = render(deps, doc, st);
  const run = buildConsoleRun(p.result.sql, p.result.binds, '');
  const specs = panelSpecs(p.specs, p.result.branches).map((s) => {
    const i = p.inputs[s.path];
    return { ...s, input: { type: i?.type ?? 'auto', value: i?.value ?? '' } };
  });
  return { ok: true, ns, id, specs, sql: p.result.sql.trim(), params: run.params, warnings: p.result.warnings };
}
