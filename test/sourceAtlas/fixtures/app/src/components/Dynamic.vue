<script setup lang="ts">
import { shallowRef } from 'vue';
import Lazy from './TooDeep.vue';
const current = shallowRef(Lazy);
const name = './' + 'x';
const A = () => import('./GrandChild.vue');
const B = () => import(name);
</script>
<template>
  <component :is="current" />
</template>
