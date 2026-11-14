import * as crypto from 'crypto';
import * as http from 'http';
import { Socket } from 'net';

/**
 * 아주 작은 WebSocket 클라이언트 (ws:// 만, 글 메시지). 브라우저의 디버깅 포트에 붙는 데만 쓴다.
 * 편집기에 든 Node 버전에 따라 내장 WebSocket 이 없을 수 있어 직접 둔다 (추가 라이브러리 없음).
 */
export class WsClient {
  onMessage: (text: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  private chunks: Buffer[] = [];
  private size = 0;
  /** 이어지는 조각(fragment)들 */
  private parts: Buffer[] = [];
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  static connect(url: string, timeoutMs = 5000): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      });
      const timer = setTimeout(() => req.destroy(new Error('연결 시간이 지났습니다')), timeoutMs);
      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timer);
        const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (res.headers['sec-websocket-accept'] !== expect) {
          socket.destroy();
          reject(new Error('WebSocket 응답이 올바르지 않습니다'));
          return;
        }
        socket.setNoDelay(true);
        const ws = new WsClient(socket);
        resolve(ws);
        if (head.length) ws.feed(head);
      });
      req.on('response', (res) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket 으로 바꾸지 못했습니다 (HTTP ${res.statusCode})`));
        res.resume();
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
  }

  send(text: string) {
    if (this.closed) return;
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(frame(0x8, Buffer.alloc(0)));
    } catch {
      // 이미 끊김
    }
    this.socket.destroy();
    this.finish();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private feed(d: Buffer) {
    this.chunks.push(d);
    this.size += d.length;
    for (;;) {
      if (this.size < 2) return;
      // 머리(최대 10바이트)가 첫 조각에 다 없으면 합친다
      if (this.chunks[0].length < Math.min(this.size, 10)) this.chunks = [Buffer.concat(this.chunks)];
      const head = this.chunks[0];
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      const masked = (head[1] & 0x80) !== 0;
      let len = head[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.size < 4) return;
        len = head.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.size < 10) return;
        len = Number(head.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (this.size < offset + len) return;
      const all = this.chunks.length === 1 ? head : Buffer.concat(this.chunks);
      let payload = all.subarray(offset, offset + len);
      if (masked) {
        const mask = all.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      const rest = all.subarray(offset + len);
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload)); // ping → pong
        continue;
      }
      if (opcode === 0xa) continue;
      this.parts.push(payload);
      if (fin) {
        const text = (this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)).toString('utf8');
        this.parts = [];
        try {
          this.onMessage(text);
        } catch {
          // 받는 쪽 오류로 연결이 끊기지 않게
        }
      }
    }
  }
}

/** 클라이언트가 보내는 프레임 (마스크 필수) */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = 0x80 | len;
  else if (len < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
