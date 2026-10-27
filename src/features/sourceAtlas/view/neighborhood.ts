import type { AtlasEdge, AtlasNode } from '../analyzer/types';

// 화면(webview)과 테스트가 같이 쓰는 순수 함수. vscode·DOM 의존 없음

/** API 뒤의 서버 쪽 종류 (깊이 필터에서 "서버 흐름 함께" 를 켜면 깊이와 상관없이 따라감) */
export const SERVER_KINDS = new Set(['controller', 'service', 'mapper', 'table']);

export interface NeighborhoodOptions {
  /** 표시하지 않을 종류 (거리 계산에는 쓰고, 결과·숨은 이웃 수에서는 뺀다) */
  hiddenKinds?: Set<string>;
  /** 종류가 숨겨져도 항상 표시할 노드 (루트·중심) */
  alwaysShow?: Set<string>;
}

export interface Neighborhood {
  /** 표시할 노드 id → 중심에서의 거리 (서버 흐름으로 붙은 것은 -1) */
  dist: Map<string, number>;
  /** 표시 노드마다 "깊이 밖이라 숨겨진 이웃" 수 */
  hiddenNeighbors: Map<string, number>;
}

/**
 * 중심 노드에서 선(방향 무시)을 따라 depth 단계 안에 있는 노드만 고른다.
 * 예) depth 2, 중심 = 컴포넌트 → 부모·조부모(위로 2), 자식·자식의 API(아래로 2)
 * withServer 면, 고른 API 노드에서 Controller → Service → SQL → 테이블 로 이어지는 서버 흐름은 깊이와 상관없이 붙인다.
 */
export function neighborhood(
  nodes: AtlasNode[],
  edges: AtlasEdge[],
  center: string,
  depth: number,
  withServer: boolean,
  opts: NeighborhoodOptions = {},
): Neighborhood {
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (!kindOf.has(a) || !kindOf.has(b) || a === b) return;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const dist = new Map<string, number>();
  if (!kindOf.has(center)) return { dist, hiddenNeighbors: new Map() };
  dist.set(center, 0);
  let frontier = [center];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!dist.has(nb)) {
          dist.set(nb, d);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  if (withServer) {
    // API(또는 이미 포함된 서버 노드)에서 나가는 방향으로만 서버 종류를 따라간다
    const out = new Map<string, string[]>();
    for (const e of edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    const stack = [...dist.keys()].filter((id) => kindOf.get(id) === 'api-call' || SERVER_KINDS.has(kindOf.get(id)!));
    while (stack.length) {
      const id = stack.pop()!;
      for (const nb of out.get(id) ?? []) {
        if (!dist.has(nb) && SERVER_KINDS.has(kindOf.get(nb) ?? '')) {
          dist.set(nb, -1);
          stack.push(nb);
        }
      }
    }
  }
  // 거리는 종류 필터와 상관없이 전체 그래프로 쟀다 (composable 등을 숨겨도 그 너머가 끊기지 않게). 표시에서만 뺀다
  const shown = (id: string) => !opts.hiddenKinds?.has(kindOf.get(id) ?? '') || !!opts.alwaysShow?.has(id);
  for (const id of [...dist.keys()]) if (!shown(id)) dist.delete(id);
  const hiddenNeighbors = new Map<string, number>();
  for (const id of dist.keys()) {
    const hiddenCount = new Set((adj.get(id) ?? []).filter((nb) => !dist.has(nb) && shown(nb))).size;
    if (hiddenCount) hiddenNeighbors.set(id, hiddenCount);
  }
  return { dist, hiddenNeighbors };
}
