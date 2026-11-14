// Source Atlas 분석기가 쓰는 라이브러리 묶음 → dist/libs/atlas.js (Atlas 로 처음 분석할 때만 읽는다)
// Babel 패키지들은 @babel/types 를 함께 쓰므로 한 파일에 묶는다 (따로 묶으면 같은 코드가 여러 번 들어간다)
module.exports = {
  '@vue/compiler-sfc': require('@vue/compiler-sfc'),
  '@babel/parser': require('@babel/parser'),
  '@babel/traverse': require('@babel/traverse'),
  '@babel/types': require('@babel/types'),
};
