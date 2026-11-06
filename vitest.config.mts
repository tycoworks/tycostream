import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the TypeScript, so Nest's decorator metadata is emitted as tsc would.
const shared = {
  plugins: [swc.vite({ module: { type: 'es6' } })],
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'utils',
          globals: true,
          environment: 'node',
          include: ['test/utils/**/*.spec.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'e2e',
          globals: true,
          environment: 'node',
          include: ['test/**/*.e2e-spec.ts'],
          fileParallelism: false, // the suites share ports and Docker
          testTimeout: 60000,
          hookTimeout: 180000,
        },
      },
    ],
  },
});
