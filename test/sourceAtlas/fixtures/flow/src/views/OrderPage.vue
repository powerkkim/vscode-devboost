<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useOrder } from '@/composables/useOrder';
import { useApi } from '@/composables/useApi';
import { useCartStore } from '@/stores/cart';
import { useUserStore } from '@/stores/user';
import { API } from '@/constants/urls';

const { load, detail, cancel } = useOrder();           // 구조 분해
const order = useOrder();                                // 객체로 받아서 호출
const api = useApi();                                    // 래퍼 객체
const cart = useCartStore();
const user = useUserStore();
const mode = ref<'add' | 'edit'>('add');

onMounted(() => load());                                 // 콜백 안의 호출 → setup 효과

async function open(id: number) {
  await detail(id);
  await order.remove(id);
}
async function save(payload: unknown) {
  const url = mode.value === 'add' ? '/api/admin/addGroupCode' : '/api/admin/modifyGroupCode';
  await api.post(url, payload);
  await cart.add(1);
  await useUserStore().logout();
}
function runCallback(cb: () => void) {
  cb();                                                  // 무엇이 올지 모름
}
function dynamicUrl(endpoint: string) {
  return (window as any).$legacyApi.get(endpoint);        // 전역 주입 래퍼 + URL 변수 → 미해석 목록
}
async function conflicting() {
  await cancel();
  await api.get(API.ORDER.LIST);                         // 상수 객체 → '/orders', baseURL 환경변수(알 수 없음)
}
</script>
<template>
  <button @click="save({})">save</button>
</template>
