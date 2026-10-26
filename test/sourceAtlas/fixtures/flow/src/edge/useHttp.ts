import axios from 'axios';
// baseURL 이 리터럴인 래퍼: 자기 효과(GET /api/{})는 노드가 되면 안 된다
const client = axios.create({ baseURL: '/api' });
export function useHttp() {
  return { get: (url: string) => client.get(url), post: (url: string, b?: unknown) => client.post(url, b) };
}
// 기본 인자값
export function fetcher(p: string, base = '/api/v2') {
  return axios.get(base + p);
}
// 부분 확정 baseURL: 앞은 환경변수, 뒤는 고정 /v1
const v1 = axios.create({ baseURL: `${import.meta.env.VITE_BASE}/v1` });
export const v1get = (u: string) => v1.get(u);
