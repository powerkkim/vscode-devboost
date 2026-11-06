// PostgreSQL 드라이버 라이브러리 묶음 → dist/drivers/pg.js (PostgreSQL 에 처음 접속할 때만 읽는다)
module.exports = { pg: require('pg'), Cursor: require('pg-cursor') };
