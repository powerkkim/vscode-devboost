import type { Cell, Column, Page, RowCursor } from './driver/types';
import { toCsv } from '../dbSchema/schema/csv';

/**
 * 조회 결과 전체를 CSV 로 흘려 쓴다: 한 번에 batch 행씩 받아 바로 쓰고 버린다 (메모리에 다 싣지 않는다).
 * 화면의 최대 행 수와 관계없이 끝까지. vscode 모듈에 의존하지 않는다 — 쓰기·진행 알림·취소를 받는다
 */
export interface CsvSink {
  write(text: string): Promise<void>;
}

export interface StreamOptions {
  batch: number;
  /** 지금까지 쓴 행 수 */
  progress?(rows: number): void;
  /** true 면 멈춘다 (커서를 닫고 지금까지 쓴 것만 남는다) */
  cancelled?(): boolean;
}

export interface StreamResult {
  rows: number;
  /** 끝까지 썼는가 (취소하면 false) */
  complete: boolean;
}

/** BOM 은 첫 조각에만 (엑셀이 UTF-8 로 읽게). NULL 은 빈 칸 */
const chunk = (rows: Cell[][], first: boolean) => {
  const text = toCsv(rows.map((r) => r.map((v) => v ?? '')));
  return first ? text : text.slice(1);
};

export async function streamCsv(columns: Column[], first: Page, cursor: RowCursor | undefined, sink: CsvSink, opts: StreamOptions): Promise<StreamResult> {
  await sink.write(chunk([columns.map((c) => c.name)], true));
  let rows = 0;
  let page = first;
  try {
    for (;;) {
      if (page.rows.length) {
        await sink.write(chunk(page.rows, false));
        rows += page.rows.length;
        opts.progress?.(rows);
      }
      if (page.done || !cursor) return { rows, complete: true };
      if (opts.cancelled?.()) return { rows, complete: false };
      page = await cursor.next(opts.batch);
    }
  } finally {
    // 끝까지 받았으면 드라이버가 이미 닫았다. 중간에 멈췄거나 실패했으면 여기서
    if (!page.done) await cursor?.close().catch(() => undefined);
  }
}
