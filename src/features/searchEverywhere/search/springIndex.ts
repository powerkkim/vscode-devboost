import * as path from 'path';
import { FileIndex } from './fileIndex';

/**
 * Spring 색인 (Spring 탭). Java·Kotlin 파일의 어노테이션 줄만 모은다 — 공통 틀(FileIndex) 사용.
 * 어노테이션 다음에 오는 클래스·메서드 이름은 클래스 색인(ClassIndex)에서 같은 파일의 다음 선언으로 맞춘다.
 *
 * - 빈 클래스: @Controller·@RestController·@ControllerAdvice·@RestControllerAdvice·@Service·@Repository·@Component·@Configuration
 * - @Bean 메서드
 * - URL 매핑: @RequestMapping·@GetMapping·@PostMapping·@PutMapping·@DeleteMapping·@PatchMapping (적힌 그대로)
 */

export type SpringAnnKind = 'bean-class' | 'bean-method' | 'mapping';

export interface SpringEntry {
  /** 어노테이션 이름 (Service, GetMapping …) */
  ann: string;
  kind: SpringAnnKind;
  /** 어노테이션에 적힌 그대로: @GetMapping("/search") */
  text: string;
  file: string;
  /** 0부터 */
  line: number;
}

const BEAN_CLASS = ['RestControllerAdvice', 'ControllerAdvice', 'RestController', 'Controller', 'Service', 'Repository', 'Component', 'Configuration'];
const MAPPING = ['RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'];

/**
 * rg 정규식: 줄 맨 앞(공백 뒤)의 어노테이션. 패키지를 붙여 쓴 것(@org.springframework…Service)도.
 *  $1 = 어노테이션 이름, $2 = 괄호 안 인자 (있으면, 한 줄에 닫힌 것만)
 */
export const SPRING_PATTERN =
  `^\\s*@(?:[\\w.]+\\.)?(${[...BEAN_CLASS, 'Bean', ...MAPPING].join('|')})\\b(\\([^)]*\\))?`;

export function buildSpringArgs(paths: string[], excludeGlobs: string[]): string[] {
  const args = ['--no-config', '--no-heading', '--with-filename', '--line-number', '--null', '--only-matching', '--max-filesize', '1M', '--max-columns', '0', '-r', '$1\t$2', '--iglob', '*.java', '--iglob', '*.kt'];
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  args.push('-e', SPRING_PATTERN, '--', ...paths);
  return args;
}

export function parseSpringOutput(out: string): Map<string, SpringEntry[]> {
  const m = new Map<string, SpringEntry[]>();
  for (const raw of out.split('\n')) {
    const z = raw.indexOf('\0');
    if (z < 0) continue;
    const file = path.normalize(raw.slice(0, z));
    const rest = raw.slice(z + 1).replace(/\r$/, '');
    const colon = rest.indexOf(':');
    if (colon < 0) continue;
    const line = Number(rest.slice(0, colon)) - 1;
    const [ann, argsText = ''] = rest.slice(colon + 1).split('\t');
    if (!ann) continue;
    const kind: SpringAnnKind = ann === 'Bean' ? 'bean-method' : MAPPING.includes(ann) ? 'mapping' : 'bean-class';
    const list = m.get(file) ?? [];
    list.push({ ann, kind, text: `@${ann}${argsText}`, file, line });
    m.set(file, list);
  }
  return m;
}

export function createSpringIndex(rgPath: string): FileIndex<SpringEntry> {
  return new FileIndex<SpringEntry>(rgPath, {
    name: 'Spring',
    accepts: (f) => /\.(java|kt)$/i.test(f),
    args: buildSpringArgs,
    parse: parseSpringOutput,
  });
}
