/**
 * JavaScript 작업대 예제 모음 (media/playground/jsBench/examples.txt). 인터넷 없이 쓰도록 확장 안에 둔다.
 * 파일 모양(UTF-8):
 *   ## 묶음 이름
 *   ### 예제 제목
 *   > 한 줄 설명 (여러 줄이면 이어 붙인다)
 *   @보기만            ← 있으면 브라우저 · Vue 화면에서만 도는 코드 (실행하지 않고 복사해 쓴다)
 *   코드 …
 *   --- 데이터          ← 있으면 그 아래가 입력 데이터
 *   데이터 …
 * 예제는 `## ` · `### ` 로 시작하는 줄에서 끝난다. 코드 · 데이터 앞뒤 빈 줄은 뗀다.
 */
export interface Example {
  group: string;
  title: string;
  description: string;
  viewOnly: boolean;
  code: string;
  data: string;
}

const GROUP = '## ';
const TITLE = '### ';
const DESCRIPTION = '> ';
const VIEW_ONLY = '@보기만';
const DATA = '--- 데이터';

/** 앞뒤 빈 줄만 뗀다 (줄 안 들여쓰기는 둔다) */
export function trimBlankLines(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines
    .slice(start, end)
    .map((l) => l.trimEnd())
    .join('\n');
}

/** 예제 글을 읽는다. 묶음 없는 예제 · 제목 없는 글 · 코드 없는 예제는 줄 번호와 함께 오류 */
export function parseExamples(text: string): Example[] {
  const out: Example[] = [];
  let group: string | undefined;
  let cur: { title: string; line: number; description: string[]; viewOnly: boolean; code: string[]; data?: string[] } | undefined;
  let head = false;
  const flush = () => {
    if (!cur) return;
    const code = trimBlankLines(cur.code.join('\n'));
    if (!code) throw new Error(`${cur.line}줄: "${cur.title}" 에 코드가 없습니다.`);
    out.push({ group: group!, title: cur.title, description: cur.description.join(' '), viewOnly: cur.viewOnly, code, data: cur.data ? trimBlankLines(cur.data.join('\n')) : '' });
    cur = undefined;
  };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const newGroup = line.startsWith(GROUP);
    if (newGroup || line.startsWith(TITLE)) {
      flush();
      if (newGroup) {
        group = line.slice(GROUP.length).trim();
        continue;
      }
      if (group === undefined) throw new Error(`${i + 1}줄: 묶음(## ) 없이 예제가 나왔습니다.`);
      cur = { title: line.slice(TITLE.length).trim(), line: i + 1, description: [], viewOnly: false, code: [] };
      head = true;
      continue;
    }
    if (!cur) {
      if (line.trim()) throw new Error(`${i + 1}줄: 제목(### ) 없는 글입니다.`);
      continue;
    }
    if (head && line.startsWith(DESCRIPTION)) {
      cur.description.push(line.slice(DESCRIPTION.length).trim());
      continue;
    }
    if (head && line.trim() === VIEW_ONLY) {
      cur.viewOnly = true;
      continue;
    }
    head = false;
    if (!cur.data && line.trim() === DATA) {
      cur.data = [];
      continue;
    }
    (cur.data ?? cur.code).push(line);
  }
  flush();
  return out;
}
