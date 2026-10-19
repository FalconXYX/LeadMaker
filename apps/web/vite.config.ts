/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Pre-bundled up front: discovered late (the dashboard chunk is lazy), they trigger a re-optimise and a
  // reload mid-load, and the stale React copy in the old chunk throws "Invalid hook call" on first load.
  optimizeDeps: { include: ['react-leaflet', 'leaflet'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': { target, changeOrigin: true },
      '/api': {
        target,
        changeOrigin: true,
        // Streams (the SSE feed and the assistant's replies): ask for an unbuffered, uncompressed body so
        // events are flushed as they arrive. The dev proxy sets no timeout, so long streams stay open.
        configure: (proxy) => {
          const streaming = (url: string | undefined) => !!url && (url.startsWith('/api/events') || url.startsWith('/api/assistant/'));
          proxy.on('proxyReq', (proxyReq, req) => {
            if (streaming(req.url)) proxyReq.setHeader('Accept-Encoding', 'identity');
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            if (streaming(req.url)) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  preview: { port: 4173 },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
