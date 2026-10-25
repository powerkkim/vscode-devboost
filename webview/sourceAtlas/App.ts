import { computed, defineComponent, h, onMounted, ref } from 'vue';
import { VueFlow, MarkerType } from '@vue-flow/core';
import { Controls } from '@vue-flow/controls';
import { Background } from '@vue-flow/background';
import NodeCard, { KIND_LABEL } from './NodeCard';
import { layout } from './layout';
import type { AtlasGraph, AtlasNode } from './types';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

const EDGE_COLOR: Record<string, string> = {
  uses: 'var(--edge-uses)', imports: 'var(--edge-uses)', calls: 'var(--edge-calls)', handles: 'var(--edge-calls)',
  reads: 'var(--edge-read)', writes: 'var(--edge-write)',
};

export default defineComponent({
  name: 'AtlasApp',
  setup() {
    const graph = ref<AtlasGraph | null>(null);
    const error = ref('');
    const loading = ref(true);
    const selectedId = ref<string | null>(null);
    const hidden = ref<Set<string>>(new Set(['external']));
    const stats = ref('');

    onMounted(() => {
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m.type === 'graph') {
          graph.value = m.graph;
          stats.value = m.stats ?? '';
          error.value = '';
          loading.value = false;
          selectedId.value = m.graph.root;
        } else if (m.type === 'error') {
          error.value = m.message;
          loading.value = false;
        } else if (m.type === 'loading') {
          loading.value = true;
        }
      });
      vscode.postMessage({ type: 'ready' });
    });

    const kinds = computed(() => {
      const c = new Map<string, number>();
      graph.value?.nodes.forEach((n) => c.set(n.kind, (c.get(n.kind) ?? 0) + 1));
      const order = ['route', 'component', 'composable', 'store', 'api-call', 'controller', 'service', 'mapper', 'table', 'external'];
      return [...c.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    });
    const visible = computed(() => {
      const g = graph.value;
      if (!g) return { nodes: [] as AtlasNode[], edges: [] as AtlasGraph['edges'] };
      const nodes = g.nodes.filter((n) => n.id === g.root || !hidden.value.has(n.kind));
      const ids = new Set(nodes.map((n) => n.id));
      return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    });
    const flow = computed(() => {
      const { nodes, edges } = visible.value;
      const pos = layout(nodes, edges);
      return {
        nodes: nodes.map((n) => ({ id: n.id, type: 'card', position: pos.get(n.id)!, data: { node: n, isRoot: n.id === graph.value!.root } })),
        edges: edges.map((e, i) => ({
          id: `e${i}`, source: e.from, target: e.to,
          label: e.label && e.type !== 'uses' ? e.label : e.type === 'writes' ? '쓰기' : e.type === 'reads' ? '읽기' : undefined,
          style: { stroke: EDGE_COLOR[e.type] ?? 'var(--edge-uses)', strokeDasharray: e.certainty === 'guess' ? '6 4' : undefined, strokeWidth: 1.6 },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-arrow)' },
          animated: false,
          class: e.certainty,
        })),
      };
    });
    const selected = computed(() => graph.value?.nodes.find((n) => n.id === selectedId.value) ?? null);

    const open = (n: AtlasNode | null) => n?.file && vscode.postMessage({ type: 'open', file: n.file, line: n.line });
    const openAt = (file: string, line: number, col?: number) => vscode.postMessage({ type: 'open', file, line, col });
    const toggle = (k: string) => {
      const s = new Set(hidden.value);
      s.has(k) ? s.delete(k) : s.add(k);
      hidden.value = s;
    };

    const detail = (n: AtlasNode) => {
      const m = n.meta ?? {};
      // key 가 있으면 meta.locs["key:이름"] 위치로 클릭 이동
      const sec = (title: string, items?: any[], key?: string) =>
        items && items.length
          ? [h('h4', title), h('ul', items.map((x) => {
              const name = typeof x === 'string' ? x : x.name;
              const body = typeof x === 'string' ? [x] : [x.name, x.type ? h('span', { class: 'dim' }, `: ${x.type}`) : null, x.required ? h('span', { class: 'req' }, ' *') : null];
              const loc = key && n.file ? m.locs?.[`${key}:${name}`] : undefined;
              return h('li', loc
                ? [h('a', { class: 'sym', href: '#', title: `${n.file}:${loc.line}`, onClick: (ev: Event) => { ev.preventDefault(); openAt(n.file!, loc.line, loc.col); } }, body), h('span', { class: 'ln' }, ` :${loc.line}`)]
                : body);
            }))]
          : [];
      // 연결된 노드 목록: 클릭하면 그 노드를 선택
      const linkSec = (title: string, list: { id: string; text: string }[]) =>
        list.length
          ? [h('h4', title), h('ul', list.map((x) => h('li', [h('a', { class: 'sym', href: '#', onClick: (ev: Event) => { ev.preventDefault(); selectedId.value = x.id; } }, x.text)])))]
          : [];
      const outgoing = graph.value!.edges.filter((e) => e.from === n.id);
      const incoming = graph.value!.edges.filter((e) => e.to === n.id);
      const nameOf = (id: string) => graph.value!.nodes.find((x) => x.id === id)?.label ?? id;
      return h('div', { class: 'detail' }, [
        h('div', { class: 'd-head' }, [h('span', { class: ['badge', `k-${n.kind}`] }, KIND_LABEL[n.kind] ?? n.kind), h('b', n.label)]),
        n.file ? h('div', { class: 'path' }, n.file) : null,
        n.file ? h('button', { onClick: () => open(n) }, '파일 열기') : null,
        m.style ? h('div', { class: 'dim' }, `${m.style} · ${m.lang}`) : null,
        ...(n.warnings?.length ? [h('h4', '경고'), h('ul', { class: 'warns' }, n.warnings.map((w) => h('li', w)))] : []),
        ...sec('props', m.props, 'props'), ...sec('emits', m.emits, 'emits'), ...sec('slots', m.slots, 'slots'),
        ...sec('ref / reactive', m.refs, 'refs'), ...sec('computed', m.computed, 'computed'), ...sec('watch', m.watchers, 'watchers'),
        ...sec('전역 등록 추정 태그', m.unresolvedTags, 'unresolvedTags'),
        ...(m.storeId ? [h('h4', 'store id'), h('div', m.storeId)] : []),
        ...(m.sql ? [h('h4', `SQL (${m.sqlType})`), h('pre', { class: 'sql' }, m.sql)] : []),
        ...(m.tables ? [...sec('읽는 테이블', m.tables.read), ...sec('쓰는 테이블', m.tables.write)] : []),
        ...(m.httpMethod ? [h('h4', '엔드포인트'), h('div', `${m.httpMethod} ${m.path}`)] : []),
        ...sec('파라미터', m.params), ...(m.returns && n.kind !== 'mapper' && n.kind !== 'component' ? [h('h4', '반환'), h('div', m.returns)] : []),
        ...(m.interface ? [h('div', { class: 'dim' }, `인터페이스 ${m.interface} 의 구현체`)] : []),
        ...(m.confirmedBy === 'backend' ? [h('div', { class: 'ok' }, '✔ 서버 엔드포인트와 정확히 일치 (실제 HTTP 호출로 확인)')] : []),
        ...(m.backend === 'unmatched' ? [h('div', { class: 'warns' }, '워크스페이스의 컨트롤러에서 일치하는 엔드포인트를 찾지 못했습니다.')] : []),
        ...(m.relation === 'ancestor' ? [h('div', { class: 'dim' }, '↑ 상위: 선택한 파일을 사용하는 쪽')] : []),
        ...(m.callers?.length
          ? [h('h4', `호출 위치 (${m.callers.length})`), h('ul', { class: 'callers' }, m.callers.map((c: any) =>
              h('li', [h('a', { href: '#', title: `${c.file}:${c.line}`, onClick: (ev: Event) => { ev.preventDefault(); openAt(c.file, c.line, c.col); } },
                [c.fn ? h('b', `${c.fn}()`) : h('i', '(최상위)'), h('span', { class: 'dim' }, `  ${c.from}:${c.line}`)])])))]
          : []),
        ...(m.url ? [h('h4', '요청'), h('div', `${m.method} ${m.url}`), h('div', { class: 'dim' }, `via ${m.via}`)] : []),
        ...linkSec('이 노드가 사용', outgoing.map((e) => ({ id: e.to, text: `${nameOf(e.to)}  (${e.type}${e.certainty === 'guess' ? ', 추정' : ''})` }))),
        ...linkSec('이 노드를 사용', incoming.map((e) => ({ id: e.from, text: `${nameOf(e.from)}  (${e.type}${e.certainty === 'guess' ? ', 추정' : ''})` }))),
      ]);
    };

    return () => {
      const g = graph.value;
      return h('div', { class: 'app' }, [
        h('header', [
          h('b', 'Source Atlas'),
          g ? h('span', { class: 'root', title: g.root }, g.root) : null,
          h('span', { class: 'dim' }, stats.value),
          h('span', { class: 'spacer' }),
          ...kinds.value.map(([k, c]) =>
            h('label', { class: ['chip', `k-${k}`] }, [
              h('input', { type: 'checkbox', checked: !hidden.value.has(k) || k === 'component', disabled: k === 'component', onChange: () => toggle(k) }),
              `${KIND_LABEL[k] ?? k} ${c}`,
            ])),
          h('button', { onClick: () => vscode.postMessage({ type: 'refresh' }) }, '다시 분석'),
        ]),
        h('main', [
          h('section', { class: 'canvas' }, [
            error.value ? h('div', { class: 'msg err' }, error.value)
              : loading.value && !g ? h('div', { class: 'msg' }, '분석 중…')
              : h(VueFlow, {
                  key: JSON.stringify(visible.value.nodes.map((n) => n.id)),
                  nodes: flow.value.nodes, edges: flow.value.edges,
                  fitViewOnInit: true, minZoom: 0.2, maxZoom: 1.6,
                  nodesDraggable: true, nodesConnectable: false, elementsSelectable: true,
                  onNodeClick: ({ node }: any) => (selectedId.value = node.id),
                  onNodeDoubleClick: ({ node }: any) => open(graph.value!.nodes.find((n) => n.id === node.id) ?? null),
                  onPaneClick: () => (selectedId.value = null),
                }, {
                  'node-card': (p: any) => h(NodeCard, { data: p.data, selected: p.id === selectedId.value }),
                  default: () => [h(Background, { gap: 22 }), h(Controls, { showInteractive: false })],
                }),
          ]),
          h('aside', selected.value ? [detail(selected.value)] : [h('div', { class: 'dim pad' }, '노드를 클릭하면 상세가 보입니다.\n더블클릭하면 파일이 열립니다.')]),
        ]),
        h('footer', { class: 'legend' }, [
          h('span', '── 확실'), h('span', '- - 추정'), h('span', { class: 'calls' }, '── API 호출/서버 호출'), h('span', { class: 'rd' }, '── 읽기'), h('span', { class: 'wr' }, '── 쓰기'), h('span', '↑ 상위'), h('span', '⚠ 경고'),
        ]),
      ]);
    };
  },
});
