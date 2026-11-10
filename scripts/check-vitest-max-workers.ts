#!/usr/bin/env tsx
/**
 * Every `vitest.config.ts` takes the ONE shared worker default.
 *
 * ## The failure this catches
 *
 * No config set `maxWorkers`, so vitest forked one worker per core (12 on the
 * dev Mac) for every run. Parallel agents each started runs and the machine
 * swapped to a stop: 22 vitest workers alive, 12 of 13 GB of swap used
 * (2026-11-10). The default now lives in `vitest.workers.ts` at the repo root
 * (`VITEST_MAX_WORKERS`, else 3), and a config added without it would bring
 * the per-core default back for its package.
 *
 * ## What it checks
 *
 * Each tracked `vitest.config.ts` imports `vitestWorkers` from the root
 * `vitest.workers` module, spreads `...vitestWorkers()` into `test`, and writes
 * no `maxWorkers` / `minWorkers` key of its own. A literal match.
 *
 * Why both bounds: a `maxWorkers` alone is refused at startup by vitest 2
 * (still pinned by some addon packages), whose default `minWorkers` is
 * cores - 1 — tinypool throws "options.minThreads and options.maxThreads must
 * not conflict" on any machine with more cores than the cap (2026-11-10, 17
 * packages red in verify:push).
 *
 * Exempt: {@link EXEMPT}, each with its reason.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Configs that may not import the root helper, and why their worker count is already bounded. */
export const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'e2e/vitest.config.ts',
    'single-threaded pool (one hub at a time); its tsconfig rootDir is e2e/, so it cannot import a root module',
  ],
])

const IMPORT_PATTERN = /import\s*\{[^}]*\bvitestWorkers\b[^}]*\}\s*from\s*'(?:\.\.?\/)+vitest\.workers(?:\.ts|\.js)?'/
const SETTING_PATTERN = /\.\.\.vitestWorkers\(\)/
const OWN_BOUND_PATTERN = /\b(?:maxWorkers|minWorkers)\s*:/

export interface VitestConfigViolation {
  readonly file: string
  readonly reason: string
}

/** Why a config's source misses the shared default; null when it has it. */
export function missingSharedDefault(source: string): string | null {
  if (!IMPORT_PATTERN.test(source)) return "does not import `vitestWorkers` from the root 'vitest.workers'"
  if (!SETTING_PATTERN.test(source)) return 'does not spread `...vitestWorkers()` into `test`'
  if (OWN_BOUND_PATTERN.test(source)) return 'writes its own `maxWorkers` / `minWorkers` instead of the shared pair'
  return null
}

export function findViolations(root: string, files: readonly string[]): readonly VitestConfigViolation[] {
  const violations: VitestConfigViolation[] = []
  for (const file of files) {
    if (EXEMPT.has(file)) continue
    const reason = missingSharedDefault(readFileSync(join(root, file), 'utf8'))
    if (reason !== null) violations.push({ file, reason })
  }
  return violations
}

function trackedConfigs(root: string): readonly string[] {
  const out = execFileSync('git', ['ls-files', '--', 'vitest.config.ts', '**/vitest.config.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
  return [...new Set(out.split('\n').filter((line) => line.length > 0))]
}

function main(): void {
  const files = trackedConfigs(ROOT)
  const violations = findViolations(ROOT, files)
  if (violations.length === 0) {
    console.log(
      `check-vitest-max-workers: ${files.length - EXEMPT.size} vitest.config.ts carry the shared worker default (${EXEMPT.size} exempt)`,
    )
    return
  }
  console.error('check-vitest-max-workers: a vitest config without the shared worker default:')
  for (const v of violations) console.error(`  ${v.file}: ${v.reason}`)
  console.error(
    "\n  Add `import { vitestWorkers } from '<relative>/vitest.workers'` and\n" +
      '  `...vitestWorkers()` under `test` (see vitest.workers.ts).',
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
