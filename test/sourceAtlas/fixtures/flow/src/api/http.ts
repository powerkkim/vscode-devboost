import axios from 'axios';
import { BASE } from '@/constants/urls';

// 1겹: axios 인스턴스 (baseURL)
const instance = axios.create({ baseURL: BASE, timeout: 5000 });
instance.interceptors.response.use((r) => r);
export default instance;
