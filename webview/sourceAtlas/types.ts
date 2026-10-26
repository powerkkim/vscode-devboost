// 확장(analyzer/types.ts)과 같은 모양. 화면은 이 JSON 만 알면 된다.
export interface AtlasNode {
  id: string;
  kind: string;
  label: string;
  file?: string;
  line?: number;
  meta: Record<string, any>;
  warnings?: string[];
}
export interface AtlasEdge {
  from: string;
  to: string;
  type: string;
  certainty: 'sure' | 'guess';
  label?: string;
  via?: string[];
  indirect?: boolean;
}
export interface AtlasGraph {
  version: number;
  root: string;
  analyzer: string;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  meta?: Record<string, any>;
}
