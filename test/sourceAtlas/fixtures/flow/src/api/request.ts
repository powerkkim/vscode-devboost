import http from './http';

// 2겹: 공통 요청 함수. 메서드와 URL 을 인자로 받는다
export async function request(method: string, url: string, body?: unknown) {
  const res = await http.request({ method, url, data: body });
  return res.data;
}
export const get = (url: string) => request('get', url);
export const post = (url: string, body?: unknown) => request('post', url, body);
export const api = { get, post, del: (url: string) => http.delete(url) };
