import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    setupFiles: ['./tests/test-setup.ts'],
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.d.ts',
        'vitest.config.ts',
        'src/types/**',
        'src/index.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@shared': new URL('./shared', import.meta.url).pathname,
    },
  },
});