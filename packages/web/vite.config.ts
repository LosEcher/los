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
      // Dev proxy: forward all gateway API calls to the los backend.
      // Keep in sync with gateway route registrations in server.ts.
      '/artifacts': 'http://127.0.0.1:8080',
      '/chat': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
      '/logs': 'http://127.0.0.1:8080',
      '/mcp-servers': 'http://127.0.0.1:8080',
      '/memory': 'http://127.0.0.1:8080',
      '/node-commands': 'http://127.0.0.1:8080',
      '/nodes': 'http://127.0.0.1:8080',
      '/onboarding': 'http://127.0.0.1:8080',
      '/projects': 'http://127.0.0.1:8080',
      '/providers': 'http://127.0.0.1:8080',
      '/rules': 'http://127.0.0.1:8080',
      '/runs': 'http://127.0.0.1:8080',
      '/runtimes': 'http://127.0.0.1:8080',
      '/services': 'http://127.0.0.1:8080',
      '/sessions': { target: 'http://127.0.0.1:8080', ws: true },
      '/settings': 'http://127.0.0.1:8080',
      '/skills': 'http://127.0.0.1:8080',
      '/tasks': 'http://127.0.0.1:8080',
      '/todos': 'http://127.0.0.1:8080',
      '/workspace': 'http://127.0.0.1:8080',
    },
  },
});
