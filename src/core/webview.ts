import { randomBytes } from 'crypto';

/**
 * 웹뷰 HTML 의 CSP(script-src 'nonce-…')에 넣는 일회용 값.
 * 화면을 그릴 때마다 새로 만든다 — 이 값이 붙은 <script> 만 실행된다.
 */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}
