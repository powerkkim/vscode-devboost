import { defineStore } from 'pinia';
import http from '@/api/http';

// options 스토어
export const useUserStore = defineStore('user', {
  state: () => ({ name: '' }),
  actions: {
    async login(id: string, pw: string) {
      const r = await http.post('/auth/login', { id, pw });
      this.name = r.data.name;
    },
    logout() {
      return http.post('/auth/logout');
    },
  },
});
