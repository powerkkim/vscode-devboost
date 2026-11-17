/**
 * Run · Debug 로 띄운 Java 서버의 출력이 어디로 가는지 (vscode 를 쓰지 않는다 — 테스트용으로 따로 둔다).
 *
 * Java 디버거는 기본으로 서버를 자기 터미널(Debug: 앱 이름)에서 띄운다. 그 터미널은 셸 통합이 없어 확장이 읽을 수 없고,
 * 디버그 콘솔(internalConsole)로 보내면 디버그 출력으로 받아 SQL 을 모을 수 있다.
 * 출력 곳은 실행 설정의 console, 없으면 사용자 설정 java.debug.settings.console(기본 integratedTerminal) 로 정해진다.
 */
export type JavaOutput = 'debugConsole' | 'terminal' | 'external';

/** 실행 설정의 console 과 사용자 설정으로 이 실행의 출력 곳. explicit 은 실행 설정에 console 을 직접 적었는지 */
export function javaOutputPlace(launchConsole: unknown, setting: unknown): { place: JavaOutput; explicit: boolean } {
  const explicit = typeof launchConsole === 'string' && launchConsole !== '';
  const value = explicit ? launchConsole : typeof setting === 'string' && setting ? setting : 'integratedTerminal';
  const place: JavaOutput = value === 'internalConsole' ? 'debugConsole' : value === 'externalTerminal' ? 'external' : 'terminal';
  return { place, explicit };
}

/** 디버그 콘솔에서도 Spring Boot 로그에 색이 나오게 하는 JVM 옵션 (디버그 콘솔은 터미널이 아니라서 Spring 이 색을 끈다) */
export const COLOR_ARG = '-Dspring.output.ansi.enabled=ALWAYS';

/**
 * 사용자 설정 java.debug.settings.vmArgs 에 색 옵션을 더한 값. 적어 둔 값은 그대로 두고 뒤에 잇는다.
 * 이미 spring.output.ansi 를 정해 두었으면(값이 무엇이든) undefined — 바꿀 것 없음
 */
export function withColorArg(vmArgs: unknown): string | undefined {
  const cur = typeof vmArgs === 'string' ? vmArgs.trim() : '';
  if (cur.includes('spring.output.ansi')) return undefined;
  return cur ? `${cur} ${COLOR_ARG}` : COLOR_ARG;
}
