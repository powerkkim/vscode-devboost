import { defineConfig } from 'vite';
export default defineConfig({
  resolve: { alias: { '@': '/src' } },
  server: { proxy: { '/api': { target: 'http://localhost:8080', rewrite: (p) => p.replace(/^\/api/, '') } } },
});
