import { defineComponent, h, PropType } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import type { AtlasNode } from './types';
import { cardRows } from './layout';

export const KIND_LABEL: Record<string, string> = {
  component: '컴포넌트', composable: 'composable', store: 'store', 'api-call': 'API', external: '외부 패키지', route: '라우트',
  controller: 'Controller', service: 'Service', mapper: 'SQL', table: '테이블',
};

/** 노드 하나 = 포스트잇 한 장. kind 별 색 띠 + 핵심 줄 */
export default defineComponent({
  name: 'AtlasNodeCard',
  props: { data: { type: Object as PropType<{ node: AtlasNode; isRoot: boolean }>, required: true }, selected: Boolean },
  setup(props) {
    return () => {
      const n = props.data.node;
      const rows = cardRows(n);
      return h('div', { class: ['card', `k-${n.kind}`, { selected: props.selected, root: props.data.isRoot, guess: n.warnings?.length }] }, [
        h(Handle, { type: 'target', position: Position.Left }),
        h('div', { class: 'card-head' }, [
          props.data.node.meta?.relation === 'ancestor' ? h('span', { class: 'up', title: '상위(이 화면을 사용하는 쪽)' }, '↑') : null,
          h('span', { class: 'badge' }, KIND_LABEL[n.kind] ?? n.kind),
          h('span', { class: 'title', title: n.id }, n.label),
          n.warnings?.length ? h('span', { class: 'warn', title: n.warnings.join('\n') }, '⚠') : null,
        ]),
        ...rows.map((r) => h('div', { class: 'row', title: r }, r)),
        h(Handle, { type: 'source', position: Position.Right }),
      ]);
    };
  },
});
