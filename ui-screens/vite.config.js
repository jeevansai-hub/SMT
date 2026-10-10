import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/lobby': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/exam': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/result': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/path': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/login': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/register': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/sandbox': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/assets': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});
