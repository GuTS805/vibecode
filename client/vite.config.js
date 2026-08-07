import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // In dev the React app runs on 5173 and proxies API calls to the Express server.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
