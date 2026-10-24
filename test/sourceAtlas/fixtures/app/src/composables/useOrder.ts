import { ref } from 'vue';
import http from '@/utils/http';

export function useOrder() {
  const orders = ref<string[]>([]);
  async function create() {
    await http.post('/orders', {});
  }
  return { orders, create };
}
