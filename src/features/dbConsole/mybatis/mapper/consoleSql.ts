/**
 * mapper 쿼리 → DevBoost DB 콘솔로 보낼 SQL 과 파라미터 값 (vscode 의존 없음).
 *
 * - 동적 태그(if/choose/foreach/…)는 마지막 입력값으로 풀고, #{} 는 :이름 바인드 변수로 남긴다 (바인드 변수 모드 결과)
 * - 각 바인드의 값은 콘솔의 파라미터 칸에 미리 채운다 → 콘솔에서 값을 확인·수정하고 실행
 *   (콘솔의 "실행할 때마다 값 확인"이 켜져 있으면 실행 전에 값 칸으로 간다)
 * - 콘솔 파라미터 타입: NUMBER / VARCHAR2. 날짜는 SQL 이 TO_DATE(:이름, '형식') 으로 감싸므로 글자 값
 */
import type { BindVar, BranchInfo, ParamSpec } from './render';

export interface ConsoleParam {
  value: string;
  type?: 'VARCHAR2' | 'NUMBER' | 'DATE';
}

/** EXEC :name := <assign>; 의 assign → 콘솔 칸에 넣을 값 */
export function bindToConsoleParam(b: Pick<BindVar, 'varType' | 'assign'>): ConsoleParam {
  const a = b.assign.trim();
  if (a.toUpperCase() === 'NULL') return { value: '', type: b.varType === 'NUMBER' ? 'NUMBER' : undefined };
  if (b.varType === 'NUMBER') return { value: a, type: 'NUMBER' };
  const m = /^'([\s\S]*)'$/.exec(a);
  return { value: m ? m[1].replace(/''/g, "'") : a, type: 'VARCHAR2' };
}

export function buildConsoleRun(
  sql: string,
  binds: Pick<BindVar, 'name' | 'varType' | 'assign'>[],
  title: string
): { text: string; params: Record<string, ConsoleParam>; empty: string[] } {
  const params: Record<string, ConsoleParam> = {};
  const empty: string[] = [];
  for (const b of binds) {
    const p = bindToConsoleParam(b);
    params[b.name] = p;
    if (p.value === '') empty.push(b.name);
  }
  return { text: `-- ${title}\n${sql.trim()}`, params, empty };
}

// ───────── 콘솔 왼쪽 파라미터 패널 ─────────

export interface PanelSpec {
  path: string;
  /** base: 늘 들어가는 값 / cond: <if>·<when> 조건이나 <foreach> 목록에 쓰이는 값 */
  group: 'base' | 'cond';
  /** 조건 상태 한 줄: "if 켜짐", "if 꺼짐", "foreach 3개", "foreach 꺼짐" */
  status?: string;
  on?: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 파라미터마다 그룹과 지금 조건 상태 */
export function panelSpecs(specs: Pick<ParamSpec, 'path' | 'uses'>[], branches: Pick<BranchInfo, 'tag' | 'expr' | 'on' | 'note'>[]): PanelSpec[] {
  return specs.map((s) => {
    const cond = s.uses.includes('test') || s.uses.includes('collection');
    if (!cond) return { path: s.path, group: 'base' };
    if (s.uses.includes('collection')) {
      const fe = branches.filter((b) => b.tag === 'foreach' && b.expr.trim() === s.path);
      if (fe.length) {
        const hit = fe.find((b) => b.on);
        return hit ? { path: s.path, group: 'cond', on: true, status: `foreach ${hit.note ?? ''}`.trim() } : { path: s.path, group: 'cond', on: false, status: 'foreach 꺼짐' };
      }
    }
    // test 식에 이 이름(또는 그 아래 경로)이 나오는 if·when
    const re = new RegExp(`(^|[^\\w.$])${esc(s.path)}(?![\\w$])`);
    const tests = branches.filter((b) => (b.tag === 'if' || b.tag === 'when') && re.test(b.expr));
    if (!tests.length) return { path: s.path, group: 'cond', on: false, status: s.uses.includes('collection') ? 'foreach 꺼짐' : '조건 꺼짐' };
    const on = tests.some((b) => b.on);
    // 목록 값인데 감싼 if 가 꺼져 foreach 까지 가지 못함
    if (!on && s.uses.includes('collection')) return { path: s.path, group: 'cond', on: false, status: 'foreach 꺼짐' };
    return { path: s.path, group: 'cond', on, status: on ? 'if 켜짐' : 'if 꺼짐' };
  });
}

/** 콘솔 문장 머리 주석 "-- 네임스페이스.쿼리id" → { ns, id } */
export function parseMapperHeader(line: string): { ns: string; id: string } | undefined {
  const m = /^\s*--\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*$/.exec(line);
  if (!m) return undefined;
  const at = m[1].lastIndexOf('.');
  return { ns: m[1].slice(0, at), id: m[1].slice(at + 1) };
}
