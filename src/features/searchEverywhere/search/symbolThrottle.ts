/**
 * 언어 서버 요청을 1초 단위로 보내는 장치 (vscode 모듈에 의존하지 않아 단독 테스트 가능).
 *
 * 언어 서버 요청(vscode.executeWorkspaceSymbolProvider)은 취소할 수 없어서, 글자마다 보내면 서버 안에 요청이 쌓인다.
 * 그래서 검색 화면은 rg 결과로 바로 확정하고, 언어 서버에는 아래 규칙으로만 묻는다.
 *
 * - 입력이 시작되고 intervalMs(1초) 뒤에 그때의 검색어로 요청
 * - 입력이 이어지면 intervalMs 마다, 앞 요청 이후 검색어가 바뀌었을 때만 다시 요청
 * - 검색어가 그대로면 멈춤 (다시 입력하면 같은 방식으로 다시 시작)
 * - 응답은 마지막으로 보낸 요청의 것만 전달 (앞 요청 응답은 버림, 늦게 와도 덮어쓰지 않음)
 * - stop(): 창이 닫히거나 언어 서버가 필요 없는 탭으로 가면 타이머를 끄고 이후 응답은 모두 버림
 */
export class SymbolThrottle<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 지금 원하는 요청 (key: 검색어 + 범위 등, 같은 key 면 다시 보내지 않음) */
  private wanted: { key: string; query: string } | undefined;
  private lastSentKey: string | undefined;
  /** 보낸 요청 번호. 응답이 왔을 때 이 번호가 아니면 버린다 */
  private seq = 0;
  private sent = 0;
  private deliver: ((query: string, key: string, result: T) => void) | undefined;
  private fail: (() => void) | undefined;

  /** fetch(query, key): key 는 요청을 만든 조건. 그사이 조건(범위 등)이 바뀌었으면 fetch 쪽에서 거부하면 된다 */
  constructor(
    private readonly fetch: (query: string, key: string) => Promise<T>,
    private readonly intervalMs = 1000
  ) {}

  /** 검색어가 바뀔 때마다 부른다. 바로 보내지 않고 다음 1초 시점에 마지막 값으로 보낸다 */
  want(key: string, query: string, deliver: (query: string, key: string, result: T) => void, fail?: () => void) {
    this.wanted = { key, query };
    this.deliver = deliver;
    this.fail = fail;
    if (!this.timer) {
      this.timer = setTimeout(() => this.tick(), this.intervalMs);
    }
  }

  private tick() {
    this.timer = undefined;
    const w = this.wanted;
    if (!w || w.key === this.lastSentKey) {
      return; // 바뀐 게 없으면 멈춤
    }
    this.lastSentKey = w.key;
    this.sent++;
    const id = ++this.seq;
    this.fetch(w.query, w.key).then(
      (r) => {
        if (id === this.seq) this.deliver?.(w.query, w.key, r);
      },
      () => {
        // 언어 서버 오류·조건 변경: 결과는 버리고 알리기만 (rg 결과는 이미 화면에 있음)
        if (id === this.seq) this.fail?.();
      }
    );
    // 입력이 이어질 수 있으니 1초 뒤 한 번 더 확인 (그대로면 멈춤)
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  /** 더 이상 필요 없음: 타이머를 끄고, 이미 보낸 요청의 응답은 버린다 */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wanted = undefined;
    this.lastSentKey = undefined;
    this.seq++;
  }

  /** 지금까지 보낸 요청 수 (테스트·기록용) */
  get sentCount(): number {
    return this.sent;
  }
}
