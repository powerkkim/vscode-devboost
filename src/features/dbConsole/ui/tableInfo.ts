import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { CollectedSchema } from '../driver/types';

/** 테이블 정보 화면에 넣을 것 */
export interface TableInfoData {
  connectionName: string;
  owner: string;
  table: string;
  schema: CollectedSchema;
  referencedBy: { table: string; constraint: string; columns: string[] }[];
  /** DDL. 못 가져왔으면 그 이유 */
  ddl?: string;
  ddlError?: string;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 테이블 정보 HTML (vscode 를 쓰지 않는 부분 — 단독 테스트 가능) */
export function tableInfoHtml(d: TableInfoData, opts: { cspSource: string; nonce: string; css: string }): string {
  const s = d.schema;
  const t = s.tables.find((x) => x.name === d.table);
  const cols = s.columns.filter((c) => c.table === d.table).sort((a, b) => a.position - b.position);
  const cons = s.constraints.filter((c) => c.table === d.table);
  const pk = new Set(cons.find((c) => c.kind === 'primary')?.columns ?? []);
  const fkCols = new Map<string, string>();
  for (const c of cons.filter((x) => x.kind === 'foreign')) c.columns.forEach((col, i) => fkCols.set(col, `${c.refTable}.${c.refColumns?.[i] ?? ''}`));
  const idx = s.indexes.filter((i) => i.table === d.table);

  const colRows = cols
    .map(
      (c) => `<tr>
  <td class="num">${c.position}</td>
  <td class="mono">${esc(c.name)}${pk.has(c.name) ? ' <span class="tag pk" title="기본 키">PK</span>' : ''}${fkCols.has(c.name) ? ` <span class="tag fk" title="${esc(fkCols.get(c.name))}">FK</span>` : ''}</td>
  <td class="mono">${esc(c.typeText)}</td>
  <td>${c.nullable ? '' : 'NOT NULL'}</td>
  <td class="mono">${esc(c.default)}</td>
  <td>${esc(c.comment)}</td>
</tr>`
    )
    .join('');
  const consRows = cons
    .map(
      (c) => `<tr>
  <td class="mono">${esc(c.name)}</td>
  <td>${c.kind === 'primary' ? '기본 키' : c.kind === 'unique' ? '유일' : '참조'}${c.enabled === false ? ' (꺼짐)' : ''}</td>
  <td class="mono">${esc(c.columns.join(', '))}</td>
  <td class="mono">${c.kind === 'foreign' ? `${esc(c.refTable)} (${esc(c.refColumns?.join(', '))})${c.onDelete && c.onDelete !== 'NO ACTION' ? ` · ON DELETE ${esc(c.onDelete)}` : ''}` : ''}</td>
</tr>`
    )
    .join('');
  const idxRows = idx
    .map(
      (i) => `<tr>
  <td class="mono">${esc(i.name)}</td>
  <td>${i.unique ? '유일' : ''}</td>
  <td class="mono">${esc(i.columns.map((c) => c.name + (c.desc ? ' DESC' : '')).join(', '))}</td>
  <td>${esc(i.kind && i.kind !== 'NORMAL' ? i.kind : '')}</td>
</tr>`
    )
    .join('');
  const refRows = d.referencedBy
    .map((r) => `<tr><td class="mono">${esc(r.table)}</td><td class="mono">${esc(r.columns.join(', '))}</td><td class="mono">${esc(r.constraint)}</td></tr>`)
    .join('');
  const section = (title: string, count: number, body: string, empty: string) =>
    `<h2>${title} <span class="count">${count}</span></h2>${count ? body : `<p class="muted">${empty}</p>`}`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${opts.cspSource}; script-src 'nonce-${opts.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${opts.css}">
<title>${esc(d.table)}</title></head>
<body>
<header>
  <h1><span class="mono">${esc(d.owner)}.${esc(d.table)}</span> ${t?.kind === 'view' ? '<span class="tag">뷰</span>' : ''}</h1>
  <p class="muted">${esc(d.connectionName)}${t?.comment ? ` · ${esc(t.comment)}` : ''}</p>
</header>
${section(
  '칸',
  cols.length,
  `<table><thead><tr><th>#</th><th>이름</th><th>타입</th><th>NULL</th><th>기본값</th><th>설명</th></tr></thead><tbody>${colRows}</tbody></table>`,
  '칸이 없습니다.'
)}
${section('제약', cons.length, `<table><thead><tr><th>이름</th><th>종류</th><th>칸</th><th>참조</th></tr></thead><tbody>${consRows}</tbody></table>`, '기본 키·유일·참조 제약이 없습니다.')}
${section('인덱스', idx.length, `<table><thead><tr><th>이름</th><th>유일</th><th>칸</th><th>종류</th></tr></thead><tbody>${idxRows}</tbody></table>`, '인덱스가 없습니다.')}
${section('이 테이블을 참조하는 테이블', d.referencedBy.length, `<table><thead><tr><th>테이블</th><th>칸</th><th>제약</th></tr></thead><tbody>${refRows}</tbody></table>`, '참조하는 테이블이 없습니다.')}
<h2>DDL <button type="button" id="copyDdl"${d.ddl ? '' : ' hidden'}>복사</button></h2>
${d.ddl ? `<pre class="mono" id="ddl">${esc(d.ddl)}</pre>` : `<p class="muted">${esc(d.ddlError ?? 'DDL 을 가져오지 못했습니다.')}</p>`}
<script nonce="${opts.nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('copyDdl')?.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: document.getElementById('ddl').textContent }));
</script>
</body></html>`;
}

/** 테이블 정보를 새 탭에 연다 (같은 테이블이면 그 탭을 다시 쓴다) */
export class TableInfoPanel {
  private static readonly open = new Map<string, vscode.WebviewPanel>();

  static show(context: vscode.ExtensionContext, key: string, data: TableInfoData) {
    let panel = this.open.get(key);
    if (!panel) {
      panel = vscode.window.createWebviewPanel('devBoostTableInfo', data.table, vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'dbConsole')],
      });
      panel.iconPath = new vscode.ThemeIcon('table');
      panel.webview.onDidReceiveMessage(async (m: { type: string; text?: string }) => {
        if (m.type === 'copy' && m.text) {
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage('DDL 을 복사했습니다', 3000);
        }
      });
      const p = panel;
      panel.onDidDispose(() => this.open.delete(key));
      this.open.set(key, p);
    }
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'dbConsole', 'tableInfo.css'));
    panel.webview.html = tableInfoHtml(data, { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64'), css: String(css) });
    panel.reveal();
  }

  static closeAll() {
    for (const p of this.open.values()) p.dispose();
  }
}
