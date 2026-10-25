import axios from 'axios';
import { useAuth } from './useAuth';

// 컴포넌트가 const api = useApi() 로 받아서 api.post(url) 로 부르는 형태 (coinwork 와 같음)
export function useApi() {
  const { token } = useAuth();
  const client = axios.create({ baseURL: import.meta.env.VITE_API_BASE ?? '/api' });
  return {
    get: (url: string) => client.get(url, { headers: { Authorization: token } }),
    post: (url: string, body?: unknown) => client.post(url, body),
  };
}
