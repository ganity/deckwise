import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real PPTX/media builds spawn workers and hold large binary fixtures.
    maxWorkers: 2,
  },
});
