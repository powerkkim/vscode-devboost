// 확장 코드를 라이브러리(@vue/compiler-sfc, @babel/parser 등)까지 한 파일로 묶는다.
//   npm run build            개발용 (소스맵 포함)
//   npm run build -- --production   배포용 (minify)  ← vsce package 가 vscode:prepublish 로 호출
import * as esbuild from 'esbuild';
import { writeNotices } from './scripts/thirdPartyNotices.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// @vue/compiler-sfc 는 <template lang="pug"> 같은 전처리용으로 템플릿 엔진을 "필요할 때만" require 한다.
// Atlas 는 parse() 만 쓰므로 호출되지 않는다 → 번들에서 제외해 크기와 해석 오류를 막는다.
const optionalEngines = [
  'atpl', 'babel-core', 'bracket-template', 'coffee-script', 'dot', 'dustjs-linkedin', 'eco', 'ect', 'ejs',
  'haml-coffee', 'hamlet', 'hamljs', 'handlebars', 'hogan.js', 'htmling', 'jazz', 'jqtpl', 'just', 'liquor',
  'lodash', 'marko', 'mote', 'mustache', 'plates', 'pug', 'ractive', 'react', 'react-dom/server', 'slm',
  'squirrelly', 'swig', 'swig-templates', 'teacup/lib/express', 'templayed', 'toffee', 'twig', 'twing',
  'underscore', 'vash', 'velocityjs', 'walrus', 'whiskers',
];

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode', ...optionalEngines],
  sourcemap: !production,
  minify: production,
  metafile: true, // 묶인 라이브러리 목록 → THIRD-PARTY-NOTICES.md
  logLevel: 'info',
};

// Source Atlas 화면(Webview): Vue 3 + Vue Flow → media/sourceAtlas/app.js, app.css
const webviewOptions = {
  entryPoints: ['webview/sourceAtlas/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'media/sourceAtlas/app.js',
  sourcemap: !production,
  minify: production,
  metafile: true,
  logLevel: 'info',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.svg': 'dataurl' },
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
};

// DB 콘솔 화면(Webview): SQL 편집기(CodeMirror) → media/dbConsole/console.js
const consoleOptions = {
  entryPoints: ['webview/dbConsole/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'media/dbConsole/console.js',
  sourcemap: !production,
  minify: production,
  metafile: true,
  logLevel: 'info',
};

// DB 드라이버 라이브러리: DB마다 따로 묶어 그 DB에 처음 접속할 때만 읽는다 (src/features/dbConsole/drivers/lib.ts)
//  - pg: pg-native(선택 의존, C 확장)는 쓰지 않는다
//  - mysql2: AWS RDS 인증서 묶음과 중국어·일본어 문자 집합 표는 빼서 크기를 줄인다 (한국어 CP949·EUC-KR 은 남긴다)
const trimDriver = {
  name: 'trim-driver',
  setup(build) {
    build.onResolve({ filter: /^aws-ssl-profiles$/ }, () => ({ path: 'aws-ssl-profiles', namespace: 'stub' }));
    build.onResolve({ filter: /tables\/(cp936|cp950|eucjp|shiftjis|big5-added|gbk-added|gb18030-ranges)\.json$/ }, (a) => ({ path: a.path, namespace: 'stub-table' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-table' }, () => ({ contents: '[]', loader: 'json' }));
  },
};
const driverOptions = (name) => ({
  entryPoints: [`src/libs/${name}.js`],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: `dist/drivers/${name}.js`,
  external: ['pg-native'],
  plugins: [trimDriver],
  minify: production,
  metafile: true,
  logLevel: 'info',
});

// DB 결과 패널(Webview) → media/dbConsole/results.js (결과 표는 콘솔과 같은 것을 쓴다)
const resultsOptions = { ...consoleOptions, entryPoints: ['webview/dbConsole/results.ts'], outfile: 'media/dbConsole/results.js' };
const bookOptions = { ...consoleOptions, entryPoints: ['webview/queryBook/main.ts'], outfile: 'media/queryBook/book.js' };

if (watch) {
  for (const o of [options, webviewOptions, consoleOptions, resultsOptions, bookOptions, driverOptions('pg'), driverOptions('mysql')]) {
    const ctx = await esbuild.context(o);
    await ctx.watch();
  }
} else {
  const results = await Promise.all([esbuild.build(options), esbuild.build(webviewOptions), esbuild.build(consoleOptions), esbuild.build(resultsOptions), esbuild.build(bookOptions), esbuild.build(driverOptions('pg')), esbuild.build(driverOptions('mysql'))]);
  // 묶인 라이브러리의 라이선스 고지 (배포 파일에 함께 들어간다)
  writeNotices(results.flatMap((r) => Object.keys(r.metafile.inputs)));
}
