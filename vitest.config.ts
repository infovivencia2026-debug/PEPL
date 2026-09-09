import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests own pepl_test and TRUNCATE it freely. Set here rather than in .env
    // so running the suite can never wipe the demo/dev database, whatever the
    // developer's local environment says.
    env: { PEPL_DB: 'pepl_test' },
    // Isolation tests share one database and TRUNCATE in setup; running files
    // in parallel would let one file's reset race another file's assertions.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
