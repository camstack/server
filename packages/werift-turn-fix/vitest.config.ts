import { defineConfig } from 'vitest/config'

/**
 * Vitest config for `@camstack/werift-turn-fix`.
 *
 * `vitest` is pinned to `^3.2.4` in this package's own `devDependencies`
 * (the repo root hoists vitest 4.x whose ESM evaluator mis-resolves Node
 * builtins). `pool: 'forks'` isolates each spec file in its own process so
 * that node-turn UDP port bindings and werift sockets don't collide across
 * parallel specs.
 */
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    pool: 'forks',
  },
})
