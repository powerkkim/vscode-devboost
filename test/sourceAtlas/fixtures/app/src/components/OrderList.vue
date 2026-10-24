<script>
import Deep from './GrandChild.vue';

export default {
  name: 'OrderList',
  components: { Deep },
  props: ['items', 'status'],
  emits: { change: null },
  data() {
    return { selected: null };
  },
};
</script>

<template>
  <ul><Deep /></ul>
</template>
