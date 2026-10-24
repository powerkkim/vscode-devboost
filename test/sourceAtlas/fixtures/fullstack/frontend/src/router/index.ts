import { createRouter, createWebHistory } from 'vue-router';
import OrderPage from '@/views/OrderPage.vue';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/orders', name: 'orders', component: OrderPage },
    { path: '/lazy', component: () => import('@/views/OrderPage.vue') },
  ],
});
