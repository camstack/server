import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from './vitest.workers'

const repoRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * One alias per subpath export of `@camstack/types`, read from its
 * package.json `exports` (the single source), most specific first.
 *
 * A string alias `@camstack/types` -> `dist/index.mjs` also matches the prefix
 * `@camstack/types/<sub>` and rewrites it to `dist/index.mjs/<sub>`, so a spec
 * importing `@camstack/types/node` (or `/client`, `/enums`, `/catalogs`) failed
 * to LOAD with "Cannot find package" — it was never collected, which reads as
 * "no failures". Exact-match regexes make each subpath resolve to its own file.
 */
function typesAliases(): { find: RegExp; replacement: string }[] {
  const pkgDir = path.join(repoRoot, 'packages/types')
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { import?: string }>
  }
  const aliases: { find: RegExp; replacement: string }[] = []
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (typeof target === 'string' || target.import === undefined) continue
    const specifier = subpath === '.' ? '@camstack/types' : `@camstack/types/${subpath.slice(2)}`
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    aliases.push({
      find: new RegExp(`^${escaped}$`),
      replacement: path.join(pkgDir, target.import),
    })
  }
  return aliases
}

const isAdminUiRun = process.argv.some((arg) => arg.includes('packages/addon-admin-ui'))

export default defineConfig({
  resolve: {
    alias: [
      ...typesAliases(),
      /** The desktop shell's alias for ONE source file of `@camstack/types` (see packages/desktop/vitest.config.ts); a root run has no other way to resolve it. */
      {
        find: /^@camstack\/owner-only-file$/,
        replacement: path.join(repoRoot, 'packages/types/src/util/owner-only-file.ts'),
      },
    ],
  },
  test: {
    maxWorkers: vitestMaxWorkers(),
    globals: true,
    environment: isAdminUiRun ? 'jsdom' : 'node',
    /**
     * Only setup files that EXIST.
     *
     * The list was static, and `pipeline/flow/__tests__/setup.ts` was deleted
     * by the Pipeline→Cameras rework (96141a901) without being removed from
     * here. Vitest fails to resolve a missing setup file before it collects
     * anything, so **every admin-ui test has been unrunnable since** — not
     * failing, unrunnable, which is why nothing reported it. Filtering makes
     * the next deletion cost a skipped setup rather than the whole suite.
     */
    setupFiles: isAdminUiRun
      ? [
          'packages/addon-admin-ui/src/components/cluster/__tests__/setup.ts',
          'packages/addon-admin-ui/src/components/addons/__tests__/setup.ts',
          'packages/addon-admin-ui/src/components/brokers/__tests__/setup.ts',
          'packages/addon-admin-ui/src/components/pipeline/flow/__tests__/setup.ts',
        ].filter((f) => existsSync(f))
      : [],
    testTimeout: 10_000,
    teardownTimeout: 5_000,
    hookTimeout: 10_000,
    exclude: [
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
      '**/node_modules/**',
      '**/dist/**',
      '**/camstack-data/**',
      '**/performance.test.ts',
      /**
       * Agent worktrees are a SECOND checkout of this repo inside it. Without
       * this, every run collected both copies of every spec — which is not
       * only twice the work: the two copies of the Moleculer TCP integration
       * test bound the same port and BOTH failed, so a clean working tree
       * reported red for a reason that had nothing to do with it. It cost an
       * investigation before the cause was found.
       */
      '**/.claude/worktrees/**',
      /**
       * Parallel-agent git worktrees under `.worktrees/` (same hazard as
       * `.claude/worktrees/` above). Without this, `npx vitest run scripts/…`
       * collects every worktree's copy of the same guard specs — stale
       * allowlists fail, and the real-tree scans run N times.
       */
      '**/.worktrees/**',
      /**
       * The SAME failure, from two more second copies — found 2026-08-11 when a
       * root `npx vitest run` reported 569 failures across 124 files on a tree
       * whose every package was green under `npm run test`.
       *
       * A local dev agent's data root (`camstack-agent-<n>-data/`) holds
       * INSTALLED addon packages, and an installed package carries its `src/`
       * — so every addon spec was collected a second time, from a copy whose
       * imports do not resolve from there. `camstack-data/` above is the same
       * idea; the agent variant was simply never added.
       *
       * `camstack/` is the Viewer submodule: a different project, with its own
       * vitest setup and its own `npm run test:v2`. Running its specs under
       * this config is meaningless.
       *
       * Both are gitignored/submodule paths, so this only ever bites locally —
       * which is worse, not better: it makes a clean tree look broken to the
       * one person who could act on it.
       */
      '**/camstack-agent-*-data/**',
      'camstack/**',
    ],
  },
})
