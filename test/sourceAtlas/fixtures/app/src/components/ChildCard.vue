<script lang="ts">
import { defineComponent } from 'vue';
import GrandChild from './GrandChild.vue';

export default defineComponent({
  name: 'ChildCard',
  components: { GrandChild },
  props: {
    item: { type: Object, required: true },
    mode: String,
  },
  emits: ['close', 'save'],
  setup() {
    return {};
  },
});
</script>

<template>
  <section><GrandChild /></section>
</template>
