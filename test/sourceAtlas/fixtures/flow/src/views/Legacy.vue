<script>
import http from '@/api/http';

// Options API: this.method() 와 this.$http
export default {
  name: 'Legacy',
  data() {
    return { rows: [] };
  },
  created() {
    this.fetchRows();
  },
  methods: {
    async fetchRows() {
      this.rows = await http.get('/legacy/rows');
      this.helper();
    },
    helper() {
      this.$http.post('/legacy/log', {});
    },
    loop() {
      this.loop2();
    },
    loop2() {
      this.loop();
      http.get('/legacy/loop');
    },
  },
};
</script>
<template><div /></template>
