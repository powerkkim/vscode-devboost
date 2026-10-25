import * as dagre from '@dagrejs/dagre';
import type { AtlasEdge, AtlasNode } from './types';

export const NODE_W = 270;

/** 카드 높이: 종류별로 보여 주는 줄 수가 정해져 있어 계산 가능 (dagre 배치용) */
export function cardRows(n: AtlasNode): string[] {
  const m = n.meta ?? {};
  const list = (a?: any[]) => (a ?? []).map((x) => (typeof x === 'string' ? x : x.name));
  const rows: string[] = [];
  if (n.kind === 'component') {
    const props = list(m.props), emits = list(m.emits);
    if (props.length) rows.push(`props  ${props.join(', ')}`);
    if (emits.length) rows.push(`emits  ${emits.join(', ')}`);
    const state = [m.refs?.length && `ref ${m.refs.length}`, m.computed?.length && `computed ${m.computed.length}`, m.watchers?.length && `watch ${m.watchers.length}`]
      .filter(Boolean);
    if (state.length) rows.push(`state  ${state.join(' · ')}`);
    if (m.unresolvedTags?.length) rows.push(`전역 추정  ${m.unresolvedTags.join(', ')}`);
    if (m.apiCalls?.length) rows.push(`api  ${new Set(m.apiCalls.map((r: any) => `${r.method} ${r.url}`)).size}개 (간접 포함)`);
  } else if (n.kind === 'controller') {
    if (m.httpMethod) rows.push(`${m.httpMethod} ${m.path}`);
  } else if (n.kind === 'service') {
    if (m.interface) rows.push(`impl of ${m.interface}`);
  } else if (n.kind === 'mapper') {
    const t = m.tables ?? { read: [], write: [] };
    rows.push(`${String(m.sqlType ?? '?').toUpperCase()}${t.read?.length ? `  ← ${t.read.join(', ')}` : ''}${t.write?.length ? `  → ${t.write.join(', ')}` : ''}`);
  } else if (n.kind === 'route') {
    rows.push('화면 진입 경로');
  } else if (n.kind === 'api-call') {
    const c = (m.callers ?? []) as { file: string; line: number; fn?: string; from: string; via?: { fn: string }[] }[];
    const fnLabel = (f?: string) => (!f || f === '<setup>' ? '' : f === '<module>' ? '' : `${f}() · `);
    if (c.length === 1) rows.push(`← ${fnLabel(c[0].fn)}${c[0].from}:${c[0].line}${c[0].via?.length ? ` (경유 ${c[0].via.length})` : ''}`);
    else if (c.length > 1) rows.push(`← 호출 ${c.length}곳`);
    if (m.proxied) rows.push(`→ ${String(m.proxied).replace(/^https?:\/\//, '')}`);
    if (m.backend === 'unmatched') rows.push('백엔드 매칭 없음');
  } else if (n.kind === 'store') {
    rows.push(`store  ${m.storeId ?? '?'}`);
  } else if (n.kind === 'composable') {
    const s = [m.refs?.length && `ref ${m.refs.length}`, m.computed?.length && `computed ${m.computed.length}`, m.watchers?.length && `watch ${m.watchers.length}`].filter(Boolean);
    if (s.length) rows.push(`state  ${s.join(' · ')}`);
  }
  if (m.truncated) rows.push('… 깊이 제한으로 펼치지 않음');
  return rows;
}

export function nodeHeight(n: AtlasNode): number {
  return 38 + cardRows(n).length * 20 + (n.warnings?.length ? 22 : 0) + 8;
}

/** 왼쪽 → 오른쪽 계층 배치. 반환: id → 좌상단 좌표 */
export function layout(nodes: AtlasNode[], edges: AtlasEdge[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: nodeHeight(n) }));
  edges.forEach((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to && g.setEdge(e.from, e.to));
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  nodes.forEach((n) => {
    const p = g.node(n.id);
    out.set(n.id, { x: p.x - NODE_W / 2, y: p.y - nodeHeight(n) / 2 });
  });
  return out;
}
