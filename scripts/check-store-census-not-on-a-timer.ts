#!/usr/bin/env tsx
/**
 * Store-census storm guard — enforcement for the 2026-08-31 settings-store
 * saturation (docs/design/2026-08-31-settings-store-saturation.md, D320).
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `storageMigration.residue` walked 1.26 M media rows (OFFSET paging, no
 * stop, not single-flighted) on a 10 s React Query timer. Each poll ADDED a
 * walk. Measured: that one SQL shape was 88.7 % of the settings engine's
 * wall-clock for six hours, ~500 walks in flight, ~16 s FIFO in front of
 * every store call in the cluster.
 *
 * Cap-usage rate cannot catch this: a healthy recorder already talks to
 * `settings-store` at ~2k calls/min, and 500 piled-up censuses look like
 * ~1.9k/min from `pipeline-analytics`. The tell is the SHAPE — a timer on a
 * full-collection census, or `stop: () => false` standing in for a budget.
 * The runtime half is `sqlite engine storm` on the settings engine: one
 * statement shape holding ≥ 50 % of a 60 s window (the 2026-08-31 census
 * was 88.7 %). That line is WARN so Loki can alert; the per-statement
 * slow-call WARN does not fire on 40 ms OFFSET pages.
 *
 * ── What it looks for ──────────────────────────────────────────────────────
 *  1. `useStorageMigrationResidue` / `storageMigration.residue` given a
 *     numeric `refetchInterval` (false/undefined is fine).
 *  2. `stop: () => false` in live TypeScript (comments and tests may name
 *     the defect).
 *  3. The settings profiler still emits `sqlite engine storm` (the runtime
 *     half — a CI that only watches the UI would miss the next walk).
 *
 * Usage: npx tsx scripts/check-store-census-not-on-a-timer.ts
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const RESIDUE_HOOK = /useStorageMigrationResidue\s*\(/
const RESIDUE_PATH = /storageMigration\.residue/
const REFETCH_NUMBER = /refetchInterval\s*:\s*\d/
const STOP_FALSE = /stop\s*:\s*\(\s*\)\s*=>\s*false/
const COMMENT = /^\s*(\/\/|\*)/

function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf-8' })
  return out.split('\n').filter((f) => {
    if (f.length === 0) return false
    if (f.includes('__tests__') || f.includes('.spec.') || f.includes('.test.')) return false
    if (f.endsWith('.d.ts')) return false
    // A guard's own text names the pattern it forbids, so scanning `scripts/`
    // makes every guard a violation of itself. This one flagged its own error
    // message (`check-store-census-not-on-a-timer.ts:67`) and had been red on
    // that line since it was written — a permanent failure that teaches the
    // reader the CI is noise, which is how this repo's CI ended up
    // `disabled_manually`. Guards check product code; they are not product.
    if (f.startsWith('scripts/')) return false
    return true
  })
}

function isComment(line: string): boolean {
  return COMMENT.test(line)
}

const problems: string[] = []

for (const rel of sourceFiles()) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (isComment(line)) continue
    if (STOP_FALSE.test(line)) {
      problems.push(
        `${rel}:${i + 1} — unbounded \`stop: () => false\` (D320: a census needs a budget, a pass needs cancel)`,
      )
    }
    if (RESIDUE_HOOK.test(line) || (RESIDUE_PATH.test(line) && line.includes('useQuery'))) {
      const window = lines.slice(i, Math.min(i + 12, lines.length)).join('\n')
      if (REFETCH_NUMBER.test(window)) {
        problems.push(
          `${rel}:${i + 1} — residue census on a numeric refetchInterval (the 2026-08-31 store storm)`,
        )
      }
    }
  }
}

const profilerPath = 'packages/system/src/builtins/sqlite-storage/query-profiler.ts'
const profiler = fs.readFileSync(path.join(ROOT, profilerPath), 'utf8')
if (!profiler.includes("'sqlite engine storm'") && !profiler.includes('"sqlite engine storm"')) {
  problems.push(
    `${profilerPath} — lost the sqlite engine storm WARN (runtime half of D320; Loki alerts on this line)`,
  )
}

if (problems.length > 0) {
  console.error('Store-census storm guard failed:')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('✔ store census is operator-driven, not on a timer')
