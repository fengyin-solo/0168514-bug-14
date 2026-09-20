import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup-node.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts'],
  },
});
