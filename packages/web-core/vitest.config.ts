import { defineConfig } from 'vitest/config';
import { SOURCE_CONDITION } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, 'module', 'browser', 'development|production'] },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
