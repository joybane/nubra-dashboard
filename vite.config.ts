import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 8000,
    proxy: {
      '/auth':  { target: 'http://localhost:3000', changeOrigin: true },
      '/api':   { target: 'http://localhost:3000', changeOrigin: true },
      '/paper': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Split long-lived vendor code into stable, cacheable chunks. Using a
        // function (not the object form) so it also captures subpath imports like
        // `react/jsx-runtime` and `react-dom/client` — the object form matched the
        // bare specifiers only and left react-dom in the main bundle.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('lightweight-charts')) return 'charts';
          if (id.includes('@radix-ui')) return 'radix';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          return 'vendor';
        },
      },
    },
  },
});
