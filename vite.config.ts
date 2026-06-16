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
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/api':  { target: 'http://localhost:3000', changeOrigin: true },
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
        manualChunks: {
          react:   ['react', 'react-dom'],
          charts:  ['lightweight-charts', 'recharts'],
          radix:   ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-select', '@radix-ui/react-tooltip'],
        },
      },
    },
  },
});
