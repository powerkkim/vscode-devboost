<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import axios from 'axios';
import { ElButton } from 'element-plus';
import ChildCard from '@/components/ChildCard.vue';
import OrderList from '../components/OrderList.vue';
import Unused from '@/components/Unused.vue';
import { useOrder } from '@/composables/useOrder';
import { useCartStore } from '@/stores/cart';

interface Props {
  title: string;
  count?: number;
}
const props = withDefaults(defineProps<Props>(), { count: 0 });
const emit = defineEmits<{
  (e: 'select', id: number): void;
  (e: 'refresh'): void;
}>();

const keyword = ref('');
const total = computed(() => props.count * 2);
watch(keyword, () => emit('refresh'));

const { orders } = useOrder();
const cart = useCartStore();

async function load() {
  await axios.get('/api/orders');
  await fetch(`/api/users/${keyword.value}`, { method: 'post' });
}
</script>

<template>
  <div>
    <el-button @click="load">load</el-button>
    <ChildCard />
    <child-card />
    <order-list />
    <MyGlobalWidget />
    <slot name="footer" />
  </div>
</template>
