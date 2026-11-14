import * as vscode from 'vscode';
import type * as Pipeline from './pipeline';
import type { PipelineOptions } from './pipeline';

/**
 * 분석기는 처음 분석할 때 읽는다.
 * 분석기에는 Vue 컴파일러와 Babel 이 들어 있어, 미리 읽으면 Atlas 를 한 번도 열지 않아도 메모리와 시작 시간을 쓴다.
 * 그래서 다른 곳에서는 './pipeline' 을 바로 import 하지 않고 이 파일을 거친다 (타입만 가져오는 것은 괜찮다).
 */
let loaded: typeof Pipeline | undefined;

export async function loadPipeline(): Promise<typeof Pipeline> {
  return (loaded ??= await import('./pipeline'));
}

/** 분석기가 들고 있는 색인을 놓는다 (분석기를 읽은 적이 없으면 할 일이 없다) */
export function clearAtlasCaches() {
  loaded?.clearAtlasCaches();
}

/** 설정(devBoost.sourceAtlas.*)을 분석 옵션으로 */
export function atlasOptions(workspaceRoot: string, fresh: boolean): PipelineOptions {
  const cfg = vscode.workspace.getConfiguration('devBoost.sourceAtlas');
  return {
    workspaceRoot,
    maxDepth: cfg.get<number>('maxDepth', 3),
    maxUp: cfg.get<number>('maxUpDepth', 3),
    backend: cfg.get<boolean>('backend.enabled', true),
    backendDepth: cfg.get<number>('backend.maxDepth', 6),
    vite: cfg.get<boolean>('vite.enabled', true) ? {} : false,
    contextPath: cfg.get<string>('backend.contextPath', '') || undefined,
    aliases: cfg.get<Record<string, string>>('aliases', {}),
    fresh,
  };
}
