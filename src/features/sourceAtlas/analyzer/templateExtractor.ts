/** template AST 에서 "어떤 태그를 썼는가" 만 뽑는다. (컴파일러 AST 의 필요한 부분만 any 로 다룸) */

export interface TemplateInfo {
  /** 사용된 모든 요소 태그 (원문 그대로) */
  tags: Set<string>;
  /** <component :is="변수"> 처럼 정적으로 알 수 없는 동적 컴포넌트가 있는가 */
  dynamicComponent: boolean;
  /** <component is="Foo"> 처럼 문자열로 지정된 컴포넌트 이름 */
  staticIs: string[];
  slots: string[];
  /** "tag:Foo" / "slots:footer" → 파일 기준 위치 (template AST 의 loc 는 .vue 파일 기준) */
  locs: Record<string, { line: number; col: number }>;
}

const ELEMENT = 1;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

export function extractTemplate(ast: any): TemplateInfo {
  const info: TemplateInfo = { tags: new Set(), dynamicComponent: false, staticIs: [], slots: [], locs: {} };
  const mark = (k: string, n: any) => {
    if (n?.loc?.start && !info.locs[k]) info.locs[k] = { line: n.loc.start.line, col: n.loc.start.column };
  };
  if (!ast) {
    return info;
  }
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (node.type === ELEMENT) {
      info.tags.add(node.tag);
      mark(`tag:${node.tag}`, node);
      const props: any[] = node.props ?? [];
      if (node.tag === 'component') {
        for (const p of props) {
          if (p.type === ATTRIBUTE && p.name === 'is' && p.value?.content) {
            info.staticIs.push(p.value.content);
          } else if (p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'is') {
            info.dynamicComponent = true;
          }
        }
      }
      if (node.tag === 'slot') {
        const nameAttr = props.find((p) => p.type === ATTRIBUTE && p.name === 'name');
        const sn = nameAttr?.value?.content ?? 'default';
        info.slots.push(sn);
        mark(`slots:${sn}`, node);
      }
    }
    (node.children ?? []).forEach(visit);
  };
  visit(ast);
  return info;
}

/** 'order-list' / 'OrderList' / 'orderList' 를 같은 이름으로 비교하기 위한 정규화 */
export function normalizeName(name: string): string {
  return name.replace(/-/g, '').toLowerCase();
}

/** Vue 가 기본 제공하는 태그(전역 등록 추정 목록에서 제외) */
const BUILT_IN = new Set([
  'component', 'slot', 'template', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense',
  'router-view', 'router-link', 'routerview', 'routerlink', 'transitiongroup', 'keepalive',
]);

/** 네이티브 HTML 이 아니면서 컴포넌트처럼 보이는 태그인가 */
export function looksLikeComponent(tag: string): boolean {
  if (BUILT_IN.has(tag) || BUILT_IN.has(normalizeName(tag))) {
    return false;
  }
  return tag.includes('-') || /^[A-Z]/.test(tag);
}
