/**
 * 쿼리 사전 설명용 작은 마크다운 → HTML. 문단·목록·표·코드 블록·`코드`·**굵게** 만.
 * 글은 모두 이스케이프한다 (사전 파일에 HTML 을 써도 그대로 글자로 보인다)
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  // `코드` 를 먼저 떼어 두고 나머지를 꾸민다
  const codes: string[] = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function renderMarkdown(md: string, codeClass = 'code'): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // 코드 블록
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(`<pre class="${codeClass}" data-lang="${esc(fence[1])}">${esc(body.join('\n'))}</pre>`);
      continue;
    }
    // 표: | a | b | 다음 줄이 |---|
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? ' class="r"' : ''));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push(
        '<table class="ex"><thead><tr>' +
          head.map((h, k) => `<th${aligns[k] ?? ''}>${inline(h)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => `<td${aligns[k] ?? ''}>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>'
      );
      continue;
    }
    // 목록
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i])) {
        let item = lines[i++].replace(bullet, '');
        // 들여 쓴 다음 줄은 같은 항목
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    // 문단 (빈 줄·표·목록·코드 전까지)
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i].trim()) && !lines[i].trim().startsWith('|') && !bullet.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
