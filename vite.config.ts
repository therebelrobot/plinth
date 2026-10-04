import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the Node API server runs separately (npm run dev:server) on :3000
// and Vite proxies /api to it so the browser sees one origin.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/public', emptyOutDir: true },
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
