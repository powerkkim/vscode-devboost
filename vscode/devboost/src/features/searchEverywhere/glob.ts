/**
 * 간단한 glob → 정규식 변환 (vscode 모듈 의존 없음, 단독 테스트 가능).
 * 지원: ** (여러 폴더), * (한 폴더 안), ? (한 글자), {a,b} (선택)
 * 경로는 '/' 구분자로 정규화해서 비교한다 (Windows의 '\' 포함).
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" → 0개 이상의 폴더, 끝의 "**" → 아무거나
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      re += '(?:';
      inBrace++;
      i++;
    } else if (c === '}' && inBrace > 0) {
      re += ')';
      inBrace--;
      i++;
    } else if (c === ',' && inBrace > 0) {
      re += '|';
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export class GlobMatcher {
  private readonly regexes: RegExp[];
  constructor(globs: string[]) {
    this.regexes = globs.filter(Boolean).map(globToRegExp);
  }
  /** relPath: 워크스페이스 기준 상대 경로 */
  matches(relPath: string): boolean {
    const p = relPath.replace(/\\/g, '/');
    return this.regexes.some((r) => r.test(p));
  }
}
