import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Isolation tests share one database and TRUNCATE in setup; running files
    // in parallel would let one file's reset race another file's assertions.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
