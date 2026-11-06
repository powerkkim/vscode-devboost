// MySQL 드라이버 라이브러리 묶음 → dist/drivers/mysql.js (MySQL 에 처음 접속할 때만 읽는다)
module.exports = { mysql: require('mysql2') };
