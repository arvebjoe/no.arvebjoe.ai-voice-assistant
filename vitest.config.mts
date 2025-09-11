import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,mts}', 'src/**/*.test.{ts,mts}'],
    exclude: ['node_modules', 'dist', '.homeycompose', '.homeybuild'],
    setupFiles: [],
  },
});
