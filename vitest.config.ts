import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    // These suites cover pure math modules (greeks, metrics, margin, GEX payoff)
    // that run identically in Node and the browser — no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    globals: false,
  },
});
