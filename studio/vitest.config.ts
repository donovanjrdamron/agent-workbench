import { defineConfig } from 'vitest/config'

// The packages live in node_modules.nosync (kept out of iCloud): only our own tests run.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
