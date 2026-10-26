import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/request';

// setup 스토어
export const useCartStore = defineStore('cart', () => {
  const items = ref([]);
  async function add(id: number) {
    await api.post('/cart/items', { id });
  }
  return { items, add };
});
