import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { VueFlow, MarkerType } from '@vue-flow/core';
import { Controls } from '@vue-flow/controls';
import { Background } from '@vue-flow/background';
import NodeCard, { KIND_LABEL } from './NodeCard';
import { layout } from './layout';
import { neighborhood } from '../../src/features/sourceAtlas/view/neighborhood';
import type { AtlasGraph, AtlasNode } from './types';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

/** 노드가 이 수를 넘으면 처음부터 깊이 2 로 보여 준다 */
const AUTO_DEPTH_NODES = 60;
const DEPTHS = [1, 2, 3, 4, 5];

let state: { depth?: number | 'all'; withServer?: boolean } = {};
try {
  state = JSON.parse(localStorage.getItem('devboost.atlas.view') ?? '{}');
} catch {
  state = {};
}
const saveState = () => {
  try {
    localStorage.setItem('devboost.atlas.view', JSON.stringify(state));
  } catch {
    /* 저장 못 해도 동작에는 지장 없음 */
  }
};

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
    // ── 분석 진행 표시
    const step = ref<{ index: number; total: number; label: string }>({ index: 0, total: 0, label: '분석 준비 중' });
    const loadingFile = ref('');
    const loadStarted = ref(0);
    const now = ref(Date.now());
    let ticker: ReturnType<typeof setInterval> | undefined;
    const stopTicker = () => {
      if (ticker) clearInterval(ticker);
      ticker = undefined;
    };
    // ── 깊이 필터: 중심 노드에서 몇 단계까지 보일지
    const focusId = ref<string | null>(null);
    const depth = ref<number | 'all'>('all');
    const withServer = ref<boolean>(state.withServer ?? false);
    watch(withServer, (v) => {
      state.withServer = v;
      saveState();
    });

    onMounted(() => {
      window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (m.type === 'graph') {
          graph.value = m.graph;
          stats.value = m.stats ?? '';
          error.value = '';
          loading.value = false;
          stopTicker();
          selectedId.value = m.graph.root;
          focusId.value = m.graph.root;
          // 큰 그래프는 처음부터 주변만 (사용자가 고른 깊이가 있으면 그것)
          depth.value = state.depth ?? (m.graph.nodes.length > AUTO_DEPTH_NODES ? 2 : 'all');
        } else if (m.type === 'error') {
          error.value = m.message;
          loading.value = false;
          stopTicker();
        } else if (m.type === 'loading') {
          if (!loading.value || !ticker) {
            loadStarted.value = Date.now() - (m.elapsedMs ?? 0);
            stopTicker();
            ticker = setInterval(() => (now.value = Date.now()), 200);
          }
          loading.value = true;
          if (m.step) step.value = m.step;
          if (m.file) loadingFile.value = m.file;
        }
      });
      vscode.postMessage({ type: 'ready' });
    });
    onBeforeUnmount(stopTicker);
    const elapsed = computed(() => Math.max(0, (now.value - loadStarted.value) / 1000).toFixed(1));
    const setDepth = (d: number | 'all') => {
      depth.value = d;
      state.depth = d;
      saveState();
    };
    /** 노드를 고른다. 깊이 필터 밖에 있으면 그 노드를 중심으로 다시 보여 준다 */
    const select = (id: string) => {
      selectedId.value = id;
      if (!visible.value.nodes.some((n) => n.id === id)) focusId.value = id;
    };

    const kinds = computed(() => {
      const c = new Map<string, number>();
      graph.value?.nodes.forEach((n) => c.set(n.kind, (c.get(n.kind) ?? 0) + 1));
      const order = ['route', 'component', 'composable', 'store', 'api-call', 'controller', 'service', 'mapper', 'table', 'external'];
      return [...c.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    });
    /** 종류 체크박스로 거른 것 (깊이 필터 전) */
    const byKind = computed(() => {
      const g = graph.value;
      if (!g) return { nodes: [] as AtlasNode[], edges: [] as AtlasGraph['edges'] };
      const keep = new Set([g.root, focusId.value]);
      const nodes = g.nodes.filter((n) => keep.has(n.id) || !hidden.value.has(n.kind));
      const ids = new Set(nodes.map((n) => n.id));
      return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    });
    /** 깊이 필터까지 적용한 것 (화면에 그리는 것) */
    const visible = computed(() => {
      const { nodes, edges } = byKind.value;
      const g = graph.value;
      if (!g || depth.value === 'all') return { nodes, edges, hiddenNeighbors: new Map<string, number>(), dist: new Map<string, number>() };
      const center = focusId.value && nodes.some((n) => n.id === focusId.value) ? focusId.value : g.root;
      const nb = neighborhood(nodes, edges, center, depth.value, withServer.value);
      const keepNodes = nodes.filter((n) => nb.dist.has(n.id));
      return {
        nodes: keepNodes,
        edges: edges.filter((e) => nb.dist.has(e.from) && nb.dist.has(e.to)),
        hiddenNeighbors: nb.hiddenNeighbors,
        dist: nb.dist,
      };
    });
    const focusNode = computed(() => graph.value?.nodes.find((n) => n.id === focusId.value) ?? null);
    const flow = computed(() => {
      const { nodes, edges } = visible.value;
      const pos = layout(nodes, edges);
      return {
        nodes: nodes.map((n) => ({
          id: n.id, type: 'card', position: pos.get(n.id)!,
          data: {
            node: n, isRoot: n.id === graph.value!.root,
            isFocus: depth.value !== 'all' && n.id === focusId.value,
            more: visible.value.hiddenNeighbors.get(n.id) ?? 0,
          },
        })),
        edges: edges.map((e, i) => ({
          id: `e${i}`, source: e.from, target: e.to,
          label: e.label && e.type !== 'uses' ? e.label : e.type === 'writes' ? '쓰기' : e.type === 'reads' ? '읽기' : undefined,
          // 간접 호출(composable/store 노드를 거쳐 가는 것, 그 노드 → API 선이 따로 있음)은 가늘고 연하게
          style: {
            stroke: EDGE_COLOR[e.type] ?? 'var(--edge-uses)',
            strokeDasharray: e.certainty === 'guess' ? '6 4' : e.indirect ? '2 4' : undefined,
            strokeWidth: e.indirect ? 1.1 : 1.6, opacity: e.indirect ? 0.55 : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-arrow)' },
          animated: false,
          class: [e.certainty, e.indirect ? 'indirect' : ''].join(' '),
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

    /** 경유 체인: 각 단계 클릭 → 그 위치로 이동 */
    const viaChain = (via: { file: string; fn: string; line: number; col: number }[]) =>
      h('div', { class: 'via' }, [
        h('span', { class: 'dim' }, '경유 '),
        ...via.flatMap((v, i) => [
          i ? h('span', { class: 'dim' }, ' → ') : null,
          h('a', { href: '#', class: 'sym', title: `${v.file}:${v.line}`, onClick: (ev: Event) => { ev.preventDefault(); openAt(v.file, v.line, v.col); } }, `${v.file.split('/').pop()?.replace(/\.(vue|ts|js)$/, '')}.${v.fn}`),
        ]),
      ]);
    /** 컴포넌트·composable·store 가 부르는 API 표 (간접 호출 포함) */
    const apiTable = (rows: any[]) => {
      const byFn = new Map<string, any[]>();
      rows.forEach((r) => byFn.set(r.fn, [...(byFn.get(r.fn) ?? []), r]));
      return [
        h('h4', `API 호출 (${rows.length})`),
        ...[...byFn.entries()].map(([fn, rs]) => h('div', { class: 'api-group' }, [
          h('div', { class: 'api-fn' }, fn === '<setup>' ? '(setup)' : fn === '<module>' ? '(모듈)' : `${fn}()`),
          h('ul', rs.map((r) => h('li', [
            h('a', { href: '#', class: 'sym', title: `${r.method} ${r.url}`, onClick: (ev: Event) => { ev.preventDefault(); select(`api:${r.method} ${r.url}`); } }, `${r.method} ${r.url}`),
            r.certainty === 'guess' ? h('span', { class: 'warn' }, ' 추정') : null,
            r.via?.length ? viaChain(r.via) : null,
          ]))),
        ])),
      ];
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
          ? [h('h4', title), h('ul', list.map((x) => h('li', [h('a', { class: 'sym', href: '#', onClick: (ev: Event) => { ev.preventDefault(); select(x.id); } }, x.text)])))]
          : [];
      const outgoing = graph.value!.edges.filter((e) => e.from === n.id);
      const incoming = graph.value!.edges.filter((e) => e.to === n.id);
      const nameOf = (id: string) => graph.value!.nodes.find((x) => x.id === id)?.label ?? id;
      return h('div', { class: 'detail' }, [
        h('div', { class: 'd-head' }, [h('span', { class: ['badge', `k-${n.kind}`] }, KIND_LABEL[n.kind] ?? n.kind), h('b', n.label)]),
        n.file ? h('div', { class: 'path' }, n.file) : null,
        h('div', { class: 'd-actions' }, [
          n.file ? h('button', { onClick: () => open(n) }, '파일 열기') : null,
          focusId.value !== n.id
            ? h('button', { class: 'secondary', title: '이 노드를 중심으로 주변 몇 단계만 보기', onClick: () => { focusId.value = n.id; if (depth.value === 'all') setDepth(2); } }, '여기를 중심으로')
            : null,
        ]),
        depth.value !== 'all' && visible.value.hiddenNeighbors.get(n.id)
          ? h('div', { class: 'dim' }, `깊이 밖에 연결이 ${visible.value.hiddenNeighbors.get(n.id)}개 더 있습니다.`)
          : null,
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
              h('li', [
                h('a', { href: '#', title: `${c.file}:${c.line}`, onClick: (ev: Event) => { ev.preventDefault(); openAt(c.file, c.line, c.col); } },
                  [c.fn && c.fn !== '<setup>' && c.fn !== '<module>' ? h('b', `${c.fn}()`) : h('i', c.fn === '<setup>' ? '(setup)' : '(최상위)'), h('span', { class: 'dim' }, `  ${c.from}:${c.line}`)]),
                ...(c.via?.length ? [viaChain(c.via)] : []),
              ])))]
          : []),
        ...(m.url ? [
          h('h4', '요청'), h('div', `${m.method} ${m.url}`),
          h('div', { class: 'dim' }, m.via && !String(m.via).includes('추정') && !String(m.via).includes('(') ? `끝점 ${m.via} (코드로 확인)` : `끝점 ${m.via ?? '?'}`),
          ...(m.proxied ? [h('div', { class: 'dim' }, `개발 서버 프록시 → ${m.proxied}`)] : []),
          ...(m.unknowns?.length ? [h('div', { class: 'warns' }, ['확정 못 한 부분: ', ...m.unknowns.map((u: string, i: number) => h('span', (i ? ' · ' : '') + u))])] : []),
        ] : []),
        ...(m.apiCalls?.length ? apiTable(m.apiCalls) : []),
        ...(m.unresolvedCalls?.length ? [h('h4', `해석 못 한 호출 (${m.unresolvedCalls.length})`), h('ul', { class: 'warns' }, m.unresolvedCalls.map((u: string) => h('li', u)))] : []),
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
          h('button', { disabled: loading.value, onClick: () => vscode.postMessage({ type: 'refresh' }) }, loading.value ? '분석 중…' : '다시 분석'),
        ]),
        g ? h('div', { class: 'toolbar' }, [
          h('span', { class: 'dim' }, '깊이'),
          h('div', { class: 'seg' }, [
            ...DEPTHS.map((d) => h('button', { class: { on: depth.value === d }, title: `중심에서 ${d}단계까지`, onClick: () => setDepth(d) }, String(d))),
            h('button', { class: { on: depth.value === 'all' }, title: '전체 보기', onClick: () => setDepth('all') }, '전체'),
          ]),
          depth.value !== 'all' ? h('span', { class: 'focus' }, [
            h('span', { class: 'dim' }, '중심 '),
            h('b', { title: focusNode.value?.id }, focusNode.value?.label ?? '?'),
            focusId.value !== g.root ? h('a', { href: '#', class: 'sym', title: '열어 둔 파일을 다시 중심으로', onClick: (ev: Event) => { ev.preventDefault(); focusId.value = g.root; } }, ' ↺ 처음 파일로') : null,
          ]) : null,
          depth.value !== 'all' ? h('label', { class: 'chk', title: '깊이 안에 들어온 API 의 Controller → Service → SQL → 테이블 흐름은 깊이와 상관없이 보기' }, [
            h('input', { type: 'checkbox', checked: withServer.value, onChange: (ev: Event) => (withServer.value = (ev.target as HTMLInputElement).checked) }),
            'API 뒤 서버 흐름 함께',
          ]) : null,
          h('span', { class: 'spacer' }),
          h('span', { class: 'dim' }, depth.value === 'all'
            ? `노드 ${byKind.value.nodes.length}개`
            : `표시 ${visible.value.nodes.length} / ${byKind.value.nodes.length}개`),
        ]) : null,
        h('main', [
          h('section', { class: ['canvas', { busy: loading.value }] }, [
            loading.value ? h('div', { class: 'loading' }, [
              h('div', { class: 'bar' }, [
                h('div', { class: 'fill', style: { width: step.value.total ? `${Math.round((Math.max(step.value.index - 1, 0) / step.value.total) * 100)}%` : '0%' } }),
                h('div', { class: 'shimmer' }),
              ]),
              h('div', { class: 'loading-box' }, [
                h('div', { class: 'spinner' }),
                h('div', [
                  h('div', { class: 'loading-title' }, step.value.total ? `${step.value.index}/${step.value.total} · ${step.value.label}` : step.value.label),
                  h('div', { class: 'dim' }, `${loadingFile.value}  ·  ${elapsed.value}초`),
                  g ? h('div', { class: 'dim' }, '끝나면 화면이 새 결과로 바뀝니다.') : null,
                ]),
              ]),
            ]) : null,
            error.value ? h('div', { class: 'msg err' }, error.value)
              : !g ? (loading.value ? null : h('div', { class: 'msg' }, '분석 결과 없음'))
              : h(VueFlow, {
                  key: JSON.stringify(visible.value.nodes.map((n) => n.id)),
                  nodes: flow.value.nodes, edges: flow.value.edges,
                  fitViewOnInit: true, minZoom: 0.2, maxZoom: 1.6,
                  nodesDraggable: true, nodesConnectable: false, elementsSelectable: true,
                  onNodeClick: ({ node }: any) => (selectedId.value = node.id),
                  onNodeDoubleClick: ({ node }: any) => open(graph.value!.nodes.find((n) => n.id === node.id) ?? null),
                  onPaneClick: () => (selectedId.value = null),
                }, {
                  'node-card': (p: any) => h(NodeCard, {
                    data: p.data, selected: p.id === selectedId.value,
                    onMore: () => { selectedId.value = p.id; focusId.value = p.id; },
                  }),
                  default: () => [h(Background, { gap: 22 }), h(Controls, { showInteractive: false })],
                }),
          ]),
          h('aside', selected.value ? [detail(selected.value)] : [h('div', { class: 'dim pad' }, '노드를 클릭하면 상세가 보입니다.\n더블클릭하면 파일이 열립니다.\n카드의 "+N" 을 누르면 그 노드를 중심으로 다시 보여 줍니다.')]),
        ]),
        h('footer', { class: 'legend' }, [
          h('span', '── 확실'), h('span', '- - 추정'), h('span', { class: 'calls' }, '── API 호출/서버 호출'), h('span', { class: 'rd' }, '── 읽기'), h('span', { class: 'wr' }, '── 쓰기'), h('span', '·· 간접 호출(composable/store 경유)'), h('span', '↑ 상위'), h('span', '⚠ 경고'),
        ]),
      ]);
    };
  },
});
