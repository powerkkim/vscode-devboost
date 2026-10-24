<script setup lang="ts">
import axios from 'axios';
import OrderRow from '@/components/OrderRow.vue';
import Unrelated from '@/components/Unrelated.vue';

async function load(id: number) {
  await axios.get('/api/orders');
  await axios.get(`/api/orders/${id}`);
  await axios.post('/api/orders', {});
  await axios.get('/api/orders/legacy-count');
  await axios.get('/api/nothing/here');
}
</script>
<template><div><OrderRow :order="{ id: 1 }" /></div></template>
