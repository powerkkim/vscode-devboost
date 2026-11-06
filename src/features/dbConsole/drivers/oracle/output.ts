import type { Connection } from 'oracledb';
import type { ServerOutput } from '../../driver/types';

/**
 * Oracle 서버 출력 (DBMS_OUTPUT.PUT_LINE 으로 쌓인 줄). vscode 모듈에 의존하지 않는다.
 * 켜면 이 접속에서 DBMS_OUTPUT.ENABLE 을 부르고, 문장을 실행할 때마다 쌓인 줄을 꺼낸다.
 */

/** 한 번에 꺼내는 최대 줄 수 (줄마다 서버에 다녀오므로 끝없이 꺼내지 않는다) */
export const MAX_OUTPUT_LINES = 2000;

export function oracleServerOutput(connection: Connection): ServerOutput {
  let enabled = false;
  return {
    get enabled() {
      return enabled;
    },
    async setEnabled(on: boolean) {
      // NULL = 크기 제한 없음 (10.2 이상)
      await connection.execute(on ? 'BEGIN DBMS_OUTPUT.ENABLE(NULL); END;' : 'BEGIN DBMS_OUTPUT.DISABLE; END;');
      enabled = on;
    },
    async read() {
      if (!enabled) return [];
      const oracledb = require('oracledb') as typeof import('oracledb');
      const lines: string[] = [];
      while (lines.length < MAX_OUTPUT_LINES) {
        const r = await connection.execute('BEGIN DBMS_OUTPUT.GET_LINE(:ln, :st); END;', {
          ln: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 },
          st: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        });
        // st: 0 = 한 줄 꺼냄, 1 = 더 없음
        if (Number(r.outBinds?.st) !== 0) return lines;
        lines.push(r.outBinds?.ln == null ? '' : String(r.outBinds.ln));
      }
      lines.push(`… ${MAX_OUTPUT_LINES.toLocaleString('en-US')}줄까지만 꺼냈습니다`);
      return lines;
    },
  };
}
