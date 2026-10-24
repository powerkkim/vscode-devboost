<script setup lang="ts">
defineProps<{ order: { id: number } }>();
defineEmits<{ (e: 'pick', id: number): void }>();
</script>
<template><tr /></template>
