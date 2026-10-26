import { defineStore } from 'pinia';
import axios from 'axios';
export const useOptStore = defineStore('opt', {
  state: () => ({ list: [] }),
  actions: {
    async refresh() {
      await this.loadAll(); // options 스토어 안의 this.otherAction()
    },
    loadAll() {
      return axios.get('/api/opt/all');
    },
  },
});
