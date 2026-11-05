// 묶어서 배포하는 라이브러리의 라이선스 고지 파일(THIRD-PARTY-NOTICES.md)을 만든다. esbuild.mjs 가 빌드 끝에 부른다.
//
// MIT·Apache-2.0 등은 다시 배포할 때 저작권·라이선스 글을 함께 넣어야 하는데, 한 파일로 묶으면(minify) 원본의 주석이 지워진다.
// 실제로 번들에 들어간 파일(esbuild metafile)에서 패키지를 찾으므로, 라이브러리를 더하거나 빼면 빌드할 때 따라 바뀐다.
import * as fs from 'node:fs';
import * as path from 'node:path';

const FILE = 'THIRD-PARTY-NOTICES.md';
const MARK = 'node_modules/';

/** "node_modules/@scope/name/…" → 패키지 폴더 (안쪽에 또 node_modules 가 있으면 가장 안쪽 것) */
function packageDirs(inputs) {
  const dirs = new Set();
  for (const file of inputs) {
    const i = file.lastIndexOf(MARK);
    if (i < 0) continue;
    const parts = file.slice(i + MARK.length).split('/');
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    dirs.add(file.slice(0, i) + MARK + name);
  }
  return [...dirs];
}

/** 폴더에서 이름이 pattern 에 맞는 첫 파일의 내용 (없으면 '') */
function readFirst(dir, pattern) {
  const hit = fs
    .readdirSync(dir)
    .filter((n) => pattern.test(n))
    .sort()[0];
  if (!hit) return '';
  return fs.readFileSync(path.join(dir, hit), 'utf8').split('\r\n').join('\n').trim();
}

function repoUrl(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
  const url = repo
    .replace(/^git\+/, '')
    .replace(/^git:/, 'https:')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`; // "vercel/ms" 처럼 줄여 쓴 GitHub 저장소
  return url || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`;
}

function readPackage(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? '알 수 없음'),
    url: repoUrl(pkg),
    text: readFirst(dir, /^licen[sc]e/i) || readFirst(dir, /^copying/i),
    notice: readFirst(dir, /^notice/i),
  };
}

const fence = (text) => ['```text', text, '```'].join('\n');

/**
 * inputs: 번들에 들어간 파일 경로들 (esbuild metafile.inputs 의 키).
 * 내용이 같으면 파일을 다시 쓰지 않는다 (git 에 변경으로 잡히지 않게)
 */
export function writeNotices(inputs) {
  const packages = packageDirs(inputs)
    .map(readPackage)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));

  const out = [
    '# Third-Party Notices',
    '',
    'DevBoost 는 아래 오픈 소스 라이브러리를 확장 파일(`dist/extension.js`, `media/sourceAtlas/app.js`)에 묶어서 배포합니다.',
    '각 라이브러리의 저작권은 해당 저작권자에게 있으며, 아래에 라이선스 전문을 옮겨 둡니다.',
    '',
    '이 파일은 빌드할 때(`node esbuild.mjs`) 실제로 묶인 라이브러리에서 자동으로 만들어집니다. 직접 고치지 마세요.',
    '',
    '| 라이브러리 | 버전 | 라이선스 |',
    '|---|---|---|',
    ...packages.map((p) => `| [${p.name}](${p.url}) | ${p.version} | ${p.license} |`),
    '',
  ];

  // 라이선스 글이 글자까지 같은 라이브러리는 한 번만 싣는다
  const groups = new Map();
  for (const p of packages) {
    const key = JSON.stringify([p.text, p.notice]);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    out.push('---', '', `## ${group.map((g) => `${g.name} ${g.version}`).join(', ')}`, '');
    out.push(`라이선스: ${[...new Set(group.map((g) => g.license))].join(', ')}`, '');
    out.push(first.text ? fence(first.text) : '(패키지에 라이선스 파일이 없습니다. 위 표의 라이선스 이름과 저장소를 참고하세요.)', '');
    if (first.notice) out.push('NOTICE:', '', fence(first.notice), '');
  }

  const content = out.join('\n');
  const old = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n') : '';
  if (old !== content) {
    fs.writeFileSync(FILE, content);
    console.log(`  ${FILE}  라이브러리 ${packages.length}개`);
  }
  return packages;
}
