import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Independent from vite.config.ts (no tanstack-router/tailwind plugins needed
// for component tests, and vitest@4 has no workspace-file concept — see
// packages/core/vitest.config.ts's header comment for why every package
// needs its own file rather than relying on the root one).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: [
        'src/features/**/*.{ts,tsx}',
        'src/pages/**/*.tsx',
        'src/layouts/**/*.tsx',
      ],
      exclude: ['**/__tests__/**', '**/fixtures/**', '**/*.d.ts'],
    },
  },
});
