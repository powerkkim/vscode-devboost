// 케이스 변환 · SQL→Java · Java→TS · Java→MyBatis 테스트. vscode 모듈 없이 Node 만으로 동작한다. (npm test 가 먼저 compile 한다)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'out', 'features', 'caseConverter', 'convert');
const { convertName, convertText, splitWords, cycleCase } = require(path.join(OUT, 'words.js'));
const { sqlToJavaFields, renderJavaFields, statementAt, sqlTypeToJava } = require(path.join(OUT, 'sql.js'));
const { parseJavaFields, javaToTs, javaToMyBatis } = require(path.join(OUT, 'java.js'));

const OPT = { dateType: 'LocalDateTime' };
const TS = { optional: 'required', dateType: 'string', objectType: 'any' };
const MB = { columnCase: 'lower', mapUnderscore: true, tablePrefix: '', width: 100 };

test('케이스 변환: 기본', () => {
  assert.strictEqual(convertName('user_name', 'camel'), 'userName');
  assert.strictEqual(convertName('userName', 'snake'), 'user_name');
  assert.strictEqual(convertName('user-name', 'pascal'), 'UserName');
  assert.strictEqual(convertName('UserName', 'kebab'), 'user-name');
  assert.strictEqual(convertName('userName', 'constant'), 'USER_NAME');
  assert.strictEqual(convertName('USER_NAME', 'camel'), 'userName');
  assert.strictEqual(convertName('userName', 'dot'), 'user.name');
});

test('케이스 변환: 약어·숫자·앞뒤 밑줄', () => {
  assert.deepStrictEqual(splitWords('XMLHttpRequest'), ['xml', 'http', 'request']);
  assert.strictEqual(convertName('userID', 'snake'), 'user_id');
  assert.strictEqual(convertName('addr2Line', 'snake'), 'addr2_line');
  assert.strictEqual(convertName('_privateValue', 'snake'), '_private_value');
  assert.strictEqual(convertName('user_id', 'camel'), 'userId');
});

test('케이스 변환: 여러 이름이 섞인 글', () => {
  assert.strictEqual(convertText('id, user_name,\n  last_login_date', 'camel'), 'id, userName,\n  lastLoginDate');
  assert.strictEqual(convertText('this.userName = 3', 'snake'), 'this.user_name = 3');
});

test('SQL → Java: mapper XML SELECT 목록 (이름으로 타입 추정)', () => {
  const xml = `
    SELECT id, username, email, role, create_date, last_login_date
        FROM tb_users
        ORDER BY id`;
  const r = sqlToJavaFields(xml, OPT);
  assert.strictEqual(r.kind, 'select');
  assert.strictEqual(r.table, 'tb_users');
  assert.strictEqual(
    renderJavaFields(r.fields),
    [
      '    private Long id;',
      '    private String username;',
      '    private String email;',
      '    private String role;',
      '    private LocalDateTime createDate;',
      '    private LocalDateTime lastLoginDate;',
    ].join('\n')
  );
  assert.deepStrictEqual(r.imports, ['java.time.LocalDateTime']);
});

test('SQL → Java: 별칭·함수·동적 태그·CDATA', () => {
  const xml = `
    <![CDATA[
    SELECT DISTINCT u.user_id AS userId, NVL(u.amt, 0) amt, COUNT(*) cnt, u.reg_dt
    ]]>
    <if test="withDept != null and n > 0">, d.dept_nm</if>
    FROM tb_user u
    LEFT JOIN tb_dept d ON d.dept_id = u.dept_id`;
  const r = sqlToJavaFields(xml, OPT);
  assert.deepStrictEqual(
    r.fields.map((f) => `${f.type} ${f.name}`),
    ['Long userId', 'BigDecimal amt', 'Long cnt', 'LocalDateTime regDt', 'String deptNm']
  );
});

test('SQL → Java: 이름을 알 수 없는 식은 경고', () => {
  const r = sqlToJavaFields('SELECT a.id, a.x + a.y, CASE WHEN a.z = 1 THEN 1 END FROM tb_a a', OPT);
  assert.deepStrictEqual(r.fields.map((f) => f.name), ['id']);
  assert.strictEqual(r.warnings.length, 2);
});

test('SQL → Java: 스키마가 있으면 실제 타입·설명, * 는 펼침', () => {
  const cols = [
    { name: 'ID', typeText: 'NUMBER(10)', comment: '번호' },
    { name: 'NAME', typeText: 'VARCHAR2(100 CHAR)' },
    { name: 'PRICE', typeText: 'NUMBER(15,2)' },
    { name: 'FLAG', typeText: 'NUMBER(1)' },
    { name: 'REG_DT', typeText: 'DATE' },
  ];
  const lookup = {
    column: (t, c) => (t.toUpperCase() === 'TB_ITEM' ? cols.find((x) => x.name === c.toUpperCase()) : undefined),
    columns: (t) => (t.toUpperCase() === 'TB_ITEM' ? cols : undefined),
  };
  const sel = sqlToJavaFields('SELECT i.id, i.price, i.flag FROM tb_item i', { ...OPT, lookup });
  assert.deepStrictEqual(sel.fields.map((f) => `${f.type} ${f.name}`), ['Long id', 'BigDecimal price', 'Integer flag']);
  assert.strictEqual(sel.fields[0].comment, '번호');
  assert.ok(sel.fields.every((f) => !f.guessed));

  const star = sqlToJavaFields('SELECT * FROM tb_item', { ...OPT, lookup });
  assert.strictEqual(star.fields.length, 5);
  assert.strictEqual(star.fields[4].type, 'LocalDateTime');

  const byName = sqlToJavaFields('tb_item', { ...OPT, lookup });
  assert.strictEqual(byName.kind, 'table');
  assert.strictEqual(byName.fields.length, 5);
});

test('SQL → Java: CREATE TABLE (주석 · COMMENT ON COLUMN)', () => {
  const ddl = `
    CREATE TABLE tb_order (
      order_id NUMBER(12) NOT NULL, -- 주문번호
      cust_name VARCHAR2(100 CHAR),
      amount NUMBER(15,2) DEFAULT 0,
      reg_dt DATE,
      memo CLOB,
      CONSTRAINT pk_order PRIMARY KEY (order_id)
    );
    COMMENT ON COLUMN tb_order.cust_name IS '고객명';`;
  const r = sqlToJavaFields(ddl, OPT);
  assert.strictEqual(r.kind, 'ddl');
  assert.deepStrictEqual(
    r.fields.map((f) => `${f.type} ${f.name}${f.comment ? ' /' + f.comment : ''}`),
    ['Long orderId /주문번호', 'String custName /고객명', 'BigDecimal amount', 'LocalDateTime regDt', 'String memo']
  );
});

test('SQL → Java: INSERT 컬럼 · 컬럼 이름 목록 · Date 설정', () => {
  const ins = sqlToJavaFields('INSERT INTO tb_users (id, user_name, create_date) VALUES (#{id}, #{userName}, SYSDATE)', OPT);
  assert.deepStrictEqual(ins.fields.map((f) => f.name), ['id', 'userName', 'createDate']);
  const names = sqlToJavaFields('id, user_name, use_yn', { dateType: 'Date' });
  assert.deepStrictEqual(names.fields.map((f) => `${f.type} ${f.name}`), ['Long id', 'String userName', 'String useYn']);
  const d = sqlToJavaFields('create_date', { dateType: 'Date' });
  assert.strictEqual(d.fields[0].type, 'Date');
  assert.deepStrictEqual(d.imports, ['java.util.Date']);
});

test('SQL → Java: 같은 이름 · 같은 파일의 include', () => {
  const full = '<mapper><sql id="cols">id, user_name</sql><select id="a">SELECT <include refid="cols"/>, id FROM tb_u</select></mapper>';
  const st = statementAt(full, full.indexOf('SELECT'));
  assert.strictEqual(st.id, 'a');
  const r = sqlToJavaFields(st.body, { ...OPT, fullXml: full });
  assert.deepStrictEqual(r.fields.map((f) => f.name), ['id', 'userName', 'id2']);
  assert.ok(r.warnings.some((w) => w.includes('id2')));
  const miss = sqlToJavaFields('SELECT <include refid="x"/>, a FROM t', OPT);
  assert.ok(miss.warnings.some((w) => w.includes('refid="x"')));
});

test('DB 타입 → Java 타입', () => {
  const t = (x) => sqlTypeToJava(x, 'LocalDateTime');
  assert.strictEqual(t('NUMBER'), 'Long');
  assert.strictEqual(t('NUMBER(9)'), 'Integer');
  assert.strictEqual(t('NUMBER(10)'), 'Long');
  assert.strictEqual(t('NUMBER(19)'), 'BigDecimal');
  assert.strictEqual(t('numeric(10,2)'), 'BigDecimal');
  assert.strictEqual(t('TIMESTAMP(6) WITH TIME ZONE'), 'LocalDateTime');
  assert.strictEqual(t('tinyint(1)'), 'Boolean');
  assert.strictEqual(t('varchar(20)'), 'String');
  assert.strictEqual(t('BLOB'), 'byte[]');
  assert.strictEqual(t('double precision'), 'Double');
});

const USER_JAVA = `
    private Long id;
    private String username;
    private String password;
    private String email;
    private String role;
    private LocalDateTime lastLoginDate;
    /** 이 시각(UTC) 이전(같은 초 포함)에 발급된 토큰은 무효. 로그아웃 시 갱신된다. */
    private LocalDateTime tokenValidAfter;
`;

test('Java → TypeScript: 필드 몇 줄', () => {
  const cls = parseJavaFields(USER_JAVA);
  assert.strictEqual(cls.fields.length, 8 - 1);
  const r = javaToTs(cls, 'User', TS);
  assert.strictEqual(
    r.text,
    [
      'export interface User {',
      '  id: number;',
      '  username: string;',
      '  password: string;',
      '  email: string;',
      '  role: string;',
      '  lastLoginDate: string;',
      '  /** 이 시각(UTC) 이전(같은 초 포함)에 발급된 토큰은 무효. 로그아웃 시 갱신된다. */',
      '  tokenValidAfter: string;',
      '}',
    ].join('\n')
  );
});

test('Java → TypeScript: 클래스 전체 (애노테이션·메서드·static 건너뜀, 제네릭)', () => {
  const src = `
package a.b;
import java.util.*;
@Data
@Entity
public class OrderDto<T> extends Base {
    private static final long serialVersionUID = 1L;
    @JsonProperty("order_id")
    @NotNull(message = "필수")
    private Long orderId; // 주문번호
    private List<OrderItem> items = new ArrayList<>();
    private Map<String, Object> extra;
    private Optional<String> memo;
    private int[] scores;
    private byte[] file;
    private boolean paid;
    private BigDecimal amount;
    private Date regDt;
    private Status status;
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
}`;
  const cls = parseJavaFields(src);
  assert.strictEqual(cls.name, 'OrderDto');
  assert.deepStrictEqual(cls.fields.map((f) => f.name), ['orderId', 'items', 'extra', 'memo', 'scores', 'file', 'paid', 'amount', 'regDt', 'status']);
  assert.strictEqual(cls.fields[0].comment, '주문번호');
  const r = javaToTs(cls, 'OrderDto', { optional: 'optional', dateType: 'Date', objectType: 'unknown' });
  assert.ok(r.text.includes('orderId?: number;'));
  assert.ok(r.text.includes('items?: OrderItem[];'));
  assert.ok(r.text.includes('extra?: Record<string, unknown>;'));
  assert.ok(r.text.includes('memo?: string | null;'));
  assert.ok(r.text.includes('scores?: number[];'));
  assert.ok(r.text.includes('file?: string;'));
  assert.ok(r.text.includes('paid?: boolean;'));
  assert.ok(r.text.includes('regDt?: Date;'));
  assert.deepStrictEqual(r.referenced, ['OrderItem', 'Status']);
});

test('Java → TypeScript: record', () => {
  const cls = parseJavaFields('public record UserRes(Long id, @NotBlank String name, List<String> roles) {}');
  assert.strictEqual(cls.name, 'UserRes');
  const r = javaToTs(cls, 'UserRes', { ...TS, optional: 'nullable' });
  assert.ok(r.text.includes('id: number | null;'));
  assert.ok(r.text.includes('roles: string[] | null;'));
});

test('Java → MyBatis SQL', () => {
  const cls = parseJavaFields(`class UserInfo { private Long id; private String userName; private LocalDateTime createDate; }`);
  const sql = javaToMyBatis(cls, ['select', 'insert', 'update', 'resultMap'], { ...MB, tablePrefix: 'tb_' });
  assert.ok(sql.includes('SELECT id, user_name, create_date\n  FROM tb_user_info'));
  assert.ok(sql.includes('INSERT INTO tb_user_info (\n    id, user_name, create_date\n) VALUES (\n    #{id}, #{userName}, #{createDate}\n)'));
  assert.ok(sql.includes('UPDATE tb_user_info\n   SET user_name = #{userName},\n       create_date = #{createDate}\n WHERE id = #{id}'));
  assert.ok(sql.includes('<id column="id" property="id"/>'));
  assert.ok(sql.includes('<result column="create_date" property="createDate"/>'));
  const alias = javaToMyBatis(cls, ['select'], { ...MB, mapUnderscore: false, columnCase: 'upper' });
  assert.ok(alias.startsWith('SELECT ID, USER_NAME AS userName, CREATE_DATE AS createDate'));
});

test('케이스 롤업: camel → Pascal → snake → SCREAMING → kebab → camel', () => {
  let t = 'userName';
  const seen = [t];
  for (let i = 0; i < 5; i++) seen.push((t = cycleCase(t)));
  assert.deepStrictEqual(seen, ['userName', 'UserName', 'user_name', 'USER_NAME', 'user-name', 'userName']);
});

test('케이스 롤업: 반대 방향', () => {
  assert.strictEqual(cycleCase('userName', -1), 'user-name');
  assert.strictEqual(cycleCase('user-name', -1), 'USER_NAME');
  assert.strictEqual(cycleCase('UserName', -1), 'userName');
});

test('케이스 롤업: 단일 단어는 같은 글을 건너뜀', () => {
  let t = 'user';
  const seen = [t];
  for (let i = 0; i < 3; i++) seen.push((t = cycleCase(t)));
  assert.deepStrictEqual(seen, ['user', 'User', 'USER', 'user']);
});

test('케이스 롤업: 어느 표기도 아니면 첫 표기로 정리, 앞뒤 밑줄·약어 유지', () => {
  assert.strictEqual(cycleCase('User_name'), 'userName');
  assert.strictEqual(cycleCase('User_name', -1), 'user-name');
  assert.strictEqual(cycleCase('_privateValue'), '_PrivateValue');
  assert.strictEqual(cycleCase('userID'), 'userId');
  assert.strictEqual(cycleCase('user_id'), 'USER_ID');
});

test('케이스 롤업: 여러 이름이 섞인 선택', () => {
  assert.strictEqual(cycleCase('id, user_name'), 'ID, USER_NAME');
});
