import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/chat': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
      '/memory': 'http://127.0.0.1:8080',
      '/providers': 'http://127.0.0.1:8080',
      '/sessions': 'http://127.0.0.1:8080',
      '/tasks': 'http://127.0.0.1:8080',
      '/todos': 'http://127.0.0.1:8080',
    },
  },
});
