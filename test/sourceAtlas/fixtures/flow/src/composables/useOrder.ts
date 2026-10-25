import { ref } from 'vue';
import { api, post } from '@/api/request';
import { API } from '@/constants/urls';

export function useOrder() {
  const orders = ref<string[]>([]);
  async function load() {
    orders.value = await api.get(API.ORDER.LIST);
  }
  const detail = (id: number) => api.get(API.ORDER.DETAIL(id));
  const cancel = () => post(API.ORDER.NESTED.CANCEL, {});
  const remove = (id: number) => api.del(`/orders/${id}`);
  // 안쪽 헬퍼: 외부로 돌려주지 않음 → useOrder() 자체의 효과가 아니다
  const neverCalled = () => api.get('/never');
  return { orders, load, detail, cancel, remove };
}
