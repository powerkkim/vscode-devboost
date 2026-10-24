import * as vscode from 'vscode';
import { MapperDoc, MapperStatement } from './mapper/mapperDoc';
import { BranchOverride, buildBindScript, collectParams, FragmentResolver, ParamSpec, renderStatement, RenderResult } from './mapper/render';
import { buildParamObject, ParamInput, ParamType } from './mapper/values';

/** statement 하나에 대해 기억하는 것 */
interface StmtState {
  inputs: Record<string, ParamInput>;
  overrides: Record<string, BranchOverride>;
}

interface Saved {
  stmts: Record<string, StmtState>;
  /** 파라미터 이름별 마지막 값: 다른 쿼리에서 같은 이름이 나오면 채워 준다 (loginUser.deptCd 같은 공통 값) */
  byName: Record<string, ParamInput>;
  mode: 'literal' | 'bind';
}

const KEY = 'devBoost.mybatisRunner.state';
const MAX_STMTS = 500;

export const stmtKey = (doc: MapperDoc, st: MapperStatement) => `${doc.namespace || doc.file}.${st.id}`;

export function suggestType(spec: ParamSpec): ParamType {
  const jt = (spec.jdbcType ?? '').toUpperCase();
  if (jt === 'DATE' || jt === 'TIMESTAMP') return 'date';
  if (spec.uses.includes('collection')) return 'list';
  return 'auto';
}

export interface Prepared {
  key: string;
  specs: ParamSpec[];
  inputs: Record<string, ParamInput & { remembered?: 'stmt' | 'name' }>;
  result: RenderResult;
  mode: 'literal' | 'bind';
  /** 화면에 보이고 워크시트로 보내는 글: 값 넣기면 SQL, 바인드 변수면 VARIABLE/EXEC 가 붙은 스크립트 */
  text: string;
}

/** 입력값·분기 지정을 workspaceState 에 저장 (프로젝트별) */
export class RunnerStore {
  constructor(private readonly memento: vscode.Memento) {}

  private load(): Saved {
    const s = this.memento.get<Saved>(KEY);
    return { stmts: s?.stmts ?? {}, byName: s?.byName ?? {}, mode: s?.mode ?? 'literal' };
  }

  private save(s: Saved) {
    const keys = Object.keys(s.stmts);
    if (keys.length > MAX_STMTS) {
      for (const k of keys.slice(0, keys.length - MAX_STMTS)) delete s.stmts[k];
    }
    void this.memento.update(KEY, s);
  }

  private stmt(s: Saved, key: string): StmtState {
    let st = s.stmts[key];
    if (!st) {
      st = { inputs: {}, overrides: {} };
    } else {
      // 최근 사용한 것이 뒤로 가도록 (오래된 것부터 정리)
      delete s.stmts[key];
    }
    s.stmts[key] = st;
    return st;
  }

  get mode(): 'literal' | 'bind' {
    return this.load().mode;
  }

  setMode(mode: 'literal' | 'bind') {
    const s = this.load();
    s.mode = mode;
    this.save(s);
  }

  setInput(key: string, path: string, input: ParamInput) {
    const s = this.load();
    this.stmt(s, key).inputs[path] = input;
    if (input.value !== '' || input.type === 'null' || input.type === 'empty') s.byName[path] = input;
    this.save(s);
  }

  clearInputs(key: string) {
    const s = this.load();
    const st = this.stmt(s, key);
    // 비운 값은 이름별 기억으로 다시 채워지지 않도록 빈 값으로 남긴다
    for (const p of Object.keys(st.inputs)) st.inputs[p] = { type: st.inputs[p].type, value: '' };
    this.save(s);
  }

  /** 분기 지정. state 가 undefined 면 자동으로 되돌림 */
  setOverride(key: string, branchKey: string, state: BranchOverride | undefined) {
    const s = this.load();
    const st = this.stmt(s, key);
    if (state) st.overrides[branchKey] = state;
    else delete st.overrides[branchKey];
    this.save(s);
  }

  setOverrides(key: string, overrides: Record<string, BranchOverride>) {
    const s = this.load();
    this.stmt(s, key).overrides = overrides;
    this.save(s);
  }

  prepare(doc: MapperDoc, st: MapperStatement, resolveFragment: FragmentResolver, modeOverride?: 'literal' | 'bind'): Prepared {
    const s = this.load();
    const key = stmtKey(doc, st);
    const saved = s.stmts[key] ?? { inputs: {}, overrides: {} };
    const specs = collectParams(doc, st, resolveFragment);
    const inputs: Prepared['inputs'] = {};
    for (const spec of specs) {
      const own = saved.inputs[spec.path];
      const byName = s.byName[spec.path];
      inputs[spec.path] = own
        ? { ...own, remembered: 'stmt' }
        : byName
          ? { ...byName, remembered: 'name' }
          : { type: suggestType(spec), value: '' };
    }
    const mode = modeOverride ?? s.mode;
    const params = buildParamObject(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, { type: v.type, value: v.value }])));
    const result = renderStatement(doc, st, params, { mode, overrides: saved.overrides, resolveFragment });
    const text = mode === 'bind' ? buildBindScript(result.sql, result.binds, `${doc.namespace.split('.').pop() || doc.file}.${st.id} (바인드 변수)`) : result.sql;
    return { key, specs, inputs, result, mode, text };
  }
}
