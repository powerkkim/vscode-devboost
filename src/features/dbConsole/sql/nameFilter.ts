/**
 * 테이블 목록 필터 (vscode 모듈에 의존하지 않아 단독 테스트 가능).
 *
 * 쓰는 법 — 쉼표나 공백으로 여러 개:
 *  - TB_PLM          TB_PLM 으로 시작하는 것 (와일드카드가 없으면 앞부분 일치)
 *  - *_HIST          _HIST 로 끝나는 것 (* = 아무 글자 여러 개, ? = 한 글자)
 *  - *PART*          PART 가 들어간 것
 *  - !*_BAK          _BAK 로 끝나는 것은 빼기 (! 또는 - 로 시작하면 제외)
 * 대소문자는 가리지 않는다. 포함 조건이 없으면(제외만 있으면) 나머지 전부
 */

export interface NameFilter {
  /** 사용자가 넣은 글 (정리한 것) */
  text: string;
  /** 거르는 조건이 있는가 */
  active: boolean;
  test(name: string): boolean;
}

function toRegExp(pattern: string): RegExp {
  const wild = /[*?]/.test(pattern);
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}${wild ? '$' : ''}`, 'i');
}

export function parseNameFilter(text: string | undefined): NameFilter {
  const tokens = (text ?? '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const t of tokens) {
    if (/^[!-]/.test(t)) {
      if (t.length > 1) exclude.push(toRegExp(t.slice(1)));
    } else {
      include.push(toRegExp(t));
    }
  }
  const active = include.length > 0 || exclude.length > 0;
  return {
    text: tokens.join(', '),
    active,
    test: (name) => (!include.length || include.some((r) => r.test(name))) && !exclude.some((r) => r.test(name)),
  };
}
