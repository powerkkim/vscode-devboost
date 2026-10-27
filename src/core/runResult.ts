/**
 * Oracle 워크시트 실행 결과를 한 줄로 정리 (vscode 의존 없음 — 테스트용으로 따로 둠).
 *
 * Oracle SQL Developer for VS Code(26.3) 확장 API 의 worksheets().onDidExecuteCommand 가 주는 result:
 *  - 성공: { data: { items: [ { error?: { message, errorCode } , … } ] }, error: null }
 *      → SQL 오류(ORA-…)는 실패가 아니라 items[i].error 로 들어온다
 *  - 실패·취소: { error: Error, data: null }  (바인드 입력 창에서 취소하면 error.name === 'CancelError')
 */

export type RunOutcome = 'ok' | 'sqlError' | 'cancel' | 'fail' | 'unknown';

export interface RunSummary {
  outcome: RunOutcome;
  /** 실행한 문장 수 (알 수 있을 때) */
  statements?: number;
  /** 오류가 난 문장 수 */
  errors?: number;
  /** 첫 오류 메시지 (한 줄) */
  message?: string;
}

const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

export function summarizeRunResult(result: unknown): RunSummary {
  if (!result || typeof result !== 'object') return { outcome: 'unknown' };
  const r = result as { error?: { name?: string; message?: string } | null; data?: { items?: unknown } | null };
  if (r.error) {
    if (r.error.name === 'CancelError') return { outcome: 'cancel' };
    return { outcome: 'fail', message: oneLine(r.error.message ?? r.error) };
  }
  const items = r.data && Array.isArray(r.data.items) ? (r.data.items as { error?: { message?: string; errorCode?: string } }[]) : undefined;
  if (!items) return { outcome: 'ok' };
  const bad = items.filter((i) => i && i.error);
  if (!bad.length) return { outcome: 'ok', statements: items.length };
  const e = bad[0].error!;
  return { outcome: 'sqlError', statements: items.length, errors: bad.length, message: oneLine(e.message ?? e.errorCode) };
}

/** 경과 시간 표시: 0.4초 / 12.3초 / 2분 05초 */
export function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}초`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
}

/** 실행 끝 알림 한 줄 */
export function describeRunEnd(s: RunSummary, ms: number): { text: string; kind: 'info' | 'warn' } {
  const t = fmtElapsed(ms);
  switch (s.outcome) {
    case 'ok':
      return { text: `실행 끝 (${t}). 결과는 Oracle 결과 창에서 확인하세요.`, kind: 'info' };
    case 'sqlError':
      return {
        text: `실행 끝 (${t}) — ${s.statements && s.statements > 1 ? `${s.statements}개 중 ` : ''}오류 ${s.errors}건: ${s.message}`,
        kind: 'warn',
      };
    case 'cancel':
      return { text: '실행을 취소했습니다.', kind: 'warn' };
    case 'fail':
      return { text: `실행하지 못했습니다 (${t}): ${s.message}`, kind: 'warn' };
    default:
      return { text: `실행 끝 (${t}).`, kind: 'info' };
  }
}
