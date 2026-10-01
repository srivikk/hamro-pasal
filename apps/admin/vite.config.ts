import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dashboard calls the API on its own origin (`/api/...`). In development Vite proxies those
 * calls to the local API, so no CORS is needed; in production the same path must be routed to the
 * API by the load balancer (same origin).
 */
const apiTarget = process.env.ADMIN_API_PROXY_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  // shared-types is a CommonJS workspace package: pre-bundle it for the dev server.
  optimizeDeps: { include: ['@hamro-pasal/shared-types'] },
});
