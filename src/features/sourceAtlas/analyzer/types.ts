// Source Atlas 분석 결과 스키마 (v1). vscode 의존 없음.
export type NodeKind =
  | 'component'
  | 'composable'
  | 'store'
  | 'api-call'
  | 'route'
  | 'external'
  // 백엔드(Spring/MyBatis)
  | 'controller'
  | 'service'
  | 'mapper'
  | 'table';

export type EdgeType = 'uses' | 'imports' | 'emits' | 'calls' | 'provides' | 'handles' | 'reads' | 'writes';
export type Certainty = 'sure' | 'guess';

export interface AtlasNode {
  /** 고유값. 파일은 워크스페이스 상대경로, 그 외는 "api:GET /orders" 형태 */
  id: string;
  kind: NodeKind | (string & {}); // 다른 분석기가 kind를 추가해도 수용
  label: string;
  file?: string;
  line?: number;
  meta: Record<string, unknown>;
  warnings?: string[];
}

export interface AtlasEdge {
  from: string;
  to: string;
  type: EdgeType | (string & {});
  certainty: Certainty;
  label?: string;
  /** calls 엣지: 진입 함수들 (간접 호출 표시용) */
  via?: string[];
  /** calls 엣지: composable/store 노드를 거쳐 가는 간접 호출 (그 노드 → API 선이 따로 있음) */
  indirect?: boolean;
}

export interface AtlasGraph {
  version: 1;
  root: string;
  analyzer: string; // 'vue3' 등
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  /** 분석 환경 정보 (Vite 프록시 등) */
  meta?: Record<string, unknown>;
}
