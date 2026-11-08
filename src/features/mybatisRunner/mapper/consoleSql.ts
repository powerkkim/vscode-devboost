/**
 * mapper 쿼리 → DevBoost DB 콘솔로 보낼 SQL 과 파라미터 값 (vscode 의존 없음).
 *
 * - 동적 태그(if/choose/foreach/…)는 마지막 입력값으로 풀고, #{} 는 :이름 바인드 변수로 남긴다 (바인드 변수 모드 결과)
 * - 각 바인드의 값은 콘솔의 파라미터 칸에 미리 채운다 → 콘솔에서 값을 확인·수정하고 실행
 *   (콘솔의 "실행할 때마다 값 확인"이 켜져 있으면 실행 전에 값 칸으로 간다)
 * - 콘솔 파라미터 타입: NUMBER / VARCHAR2. 날짜는 SQL 이 TO_DATE(:이름, '형식') 으로 감싸므로 글자 값
 */
import type { BindVar } from './render';

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
