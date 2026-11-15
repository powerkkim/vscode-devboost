/**
 * Run · Debug 로 띄운 Java 서버의 출력을 읽기 위한 실행 설정 바꾸기 (vscode 를 쓰지 않는다 — 테스트용으로 따로 둔다).
 * 쓰는 곳: serverTerminal.ts
 */

/** 이 실행 설정을 바꿨다는 표시 (세션이 시작될 때 터미널을 만들 곳을 알아본다) */
export const MARK = '__devBoostServerTerminal';

/**
 * Java launch 설정을 "디버그 콘솔로 받아 확장 터미널에 보이기" 로 바꾼다. 바꾸지 않을 설정이면 그대로 돌려준다.
 * 출력에 색이 남게 Spring Boot 의 색 출력을 켠다 (이미 정했으면 그대로)
 */
export function redirectJavaLaunch<T extends Record<string, unknown>>(config: T): T {
  if (config.type !== 'java' || config.request !== 'launch') return config;
  if (config.console !== undefined && config.console !== 'integratedTerminal') return config;
  const vmArgs = config.vmArgs;
  const color = '-Dspring.output.ansi.enabled=ALWAYS';
  const has = (v: unknown) => (Array.isArray(v) ? v.join(' ') : String(v ?? '')).includes('spring.output.ansi');
  const nextArgs = has(vmArgs) ? vmArgs : Array.isArray(vmArgs) ? [...vmArgs, color] : vmArgs ? `${vmArgs} ${color}` : color;
  return { ...config, console: 'internalConsole', internalConsoleOptions: 'neverOpen', vmArgs: nextArgs, [MARK]: true };
}

/** 디버그 출력 한 덩이를 터미널에 쓸 글로 (줄바꿈은 \r\n) */
export const toTerminalText = (output: string) => output.replace(/\r?\n/g, '\r\n');

