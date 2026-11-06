import * as path from 'path';

/**
 * DB 드라이버 라이브러리(pg, mysql2)는 확장 본체에 넣지 않고 dist/drivers/<이름>.js 로 따로 묶는다.
 * 그 DB에 처음 접속할 때 여기서 읽으므로, 쓰지 않는 DB의 라이브러리는 메모리에 올라오지 않는다.
 * (Oracle 은 본체에 함께 들어 있다)
 */
const loaded = new Map<string, unknown>();

export function loadLib<T>(name: 'pg' | 'mysql'): T {
  let lib = loaded.get(name);
  if (!lib) {
    // 묶은 확장(dist/extension.js) 기준 dist/drivers/. 테스트(out/…)에서는 쓰지 않는다
    const file = path.join(__dirname, 'drivers', `${name}.js`);
    lib = require(file);
    loaded.set(name, lib);
  }
  return lib as T;
}
