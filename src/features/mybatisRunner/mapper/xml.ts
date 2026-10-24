/**
 * MyBatis mapper XML 전용 작은 XML 파서 (vscode 의존 없음).
 * - 태그 순서·텍스트·CDATA 를 그대로 보존한 트리를 만든다 (동적 SQL 은 순서가 곧 의미)
 * - 각 노드에 원본 위치(offset)를 남겨 에디터 강조·이동에 쓴다
 * - 조금 깨진 XML(닫히지 않은 태그 등)도 최대한 읽어 낸다: 편집 중인 파일에서도 동작해야 하므로
 */

export interface XmlElement {
  kind: 'element';
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** '<' 위치 */
  start: number;
  /** 닫는 태그 '>' 다음 위치 (self-closing 이면 '/>' 다음) */
  end: number;
  /** 여는 태그 끝 '>' 다음 위치 */
  openEnd: number;
}

export interface XmlText {
  kind: 'text';
  /** 엔티티를 풀어 둔 텍스트 (CDATA 는 원문 그대로) */
  text: string;
  cdata: boolean;
  start: number;
  end: number;
}

export type XmlNode = XmlElement | XmlText;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** 문서 전체를 파싱해 최상위 노드 목록을 돌려준다 (가상의 루트 element 아래에 담음) */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { kind: 'element', name: '#root', attrs: {}, children: [], start: 0, end: src.length, openEnd: 0 };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  let textStart = 0;

  const flushText = (until: number) => {
    if (until > textStart) {
      const raw = src.slice(textStart, until);
      top().children.push({ kind: 'text', text: decodeEntities(raw), cdata: false, start: textStart, end: until });
    }
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      break;
    }
    if (src.startsWith('<!--', lt)) {
      flushText(lt);
      const e = src.indexOf('-->', lt + 4);
      i = textStart = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      flushText(lt);
      const e = src.indexOf(']]>', lt + 9);
      const stop = e < 0 ? src.length : e;
      top().children.push({ kind: 'text', text: src.slice(lt + 9, stop), cdata: true, start: lt, end: e < 0 ? src.length : e + 3 });
      i = textStart = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      flushText(lt);
      // <!DOCTYPE ...> 는 내부 [ ] 를 가질 수 있음
      let e = src.indexOf('>', lt);
      if (src.startsWith('<!DOCTYPE', lt)) {
        const br = src.indexOf('[', lt);
        if (br >= 0 && br < e) {
          const close = src.indexOf(']>', br);
          e = close < 0 ? e : close + 1;
        }
      }
      i = textStart = e < 0 ? src.length : e + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      // 닫는 태그
      const m = /^<\/\s*([A-Za-z_][\w:.-]*)\s*>/.exec(src.slice(lt, lt + 200));
      if (!m) {
        i = lt + 1;
        continue;
      }
      flushText(lt);
      const name = m[1];
      const close = lt + m[0].length;
      // 같은 이름의 열린 태그까지 닫는다 (중간에 안 닫힌 것은 함께 닫힘)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          while (stack.length > k) {
            const el = stack.pop()!;
            el.end = close;
          }
          break;
        }
      }
      i = textStart = close;
      continue;
    }
    // 여는 태그: 따옴표 안의 '>' 는 건너뛴다 (test="a > b" 같은 실수를 허용)
    const nameM = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(lt, lt + 200));
    if (!nameM) {
      i = lt + 1;
      continue;
    }
    let j = lt + nameM[0].length;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    flushText(lt);
    const selfClosing = src[j - 1] === '/';
    const attrSrc = src.slice(lt + nameM[0].length, selfClosing ? j - 1 : j);
    const el: XmlElement = {
      kind: 'element',
      name: nameM[1],
      attrs: parseAttrs(attrSrc),
      children: [],
      start: lt,
      end: j + 1,
      openEnd: j + 1,
    };
    top().children.push(el);
    if (!selfClosing) {
      stack.push(el);
    }
    i = textStart = j + 1;
  }
  flushText(src.length);
  // 닫히지 않은 태그는 문서 끝까지로 본다
  while (stack.length > 1) {
    stack.pop()!.end = src.length;
  }
  return root;
}

/** offset → 1부터 시작하는 줄 번호 계산기 */
export function lineIndex(src: string): (offset: number) => { line: number; col: number } {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 };
  };
}

export function* walk(el: XmlElement): Generator<XmlElement> {
  for (const c of el.children) {
    if (c.kind === 'element') {
      yield c;
      yield* walk(c);
    }
  }
}
