#!/usr/bin/env tsx
/**
 * npm run ui:shots -- --route "/system/identity?tab=access" [--fixtures access]
 *                     [--label before|after] [--out <dir>] [--compare <before-dir>]
 *
 * Renders admin-ui routes from workspace source against fixture data (no hub),
 * screenshots each in light and dark at 1440×900 and 390×844, measures
 * horizontal overflow, elements past the viewport and sticky pinning, and
 * writes `report.md` + `report.json` into `scratchpad/ui-shots/<label>/`
 * (gitignored — never commit the shots). Full options: `lib/args.ts`.
 * Fixtures: `scripts/ui/shots/fixtures/` (contract in `_define.ts`).
 */
import * as path from 'node:path'
import { parseShotsArgs, USAGE } from './lib/args.js'
import { runShots } from './lib/run.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

async function main(): Promise<void> {
  const args = parseShotsArgs(process.argv.slice(2), ROOT)
  if ('error' in args) {
    console.error(`ui:shots: ${args.error}\n${USAGE}`)
    process.exit(2)
  }
  console.log(`ui:shots → ${path.relative(ROOT, args.out)}`)
  const { report, markdownPath } = await runShots(args, ROOT, (l) => console.log(l))
  const missing = new Set(report.shots.flatMap((s) => s.missingFixtures))
  if (missing.size > 0) {
    console.log(
      `\n  ${missing.size} tRPC path(s) had no fixture (answered null): ${[...missing].join(', ')}`,
    )
    console.log('  Add them to a file in scripts/ui/shots/fixtures/ if the page needs them.')
  }
  console.log(`\nreport: ${path.relative(ROOT, markdownPath)}`)
}

main().catch((err: unknown) => {
  console.error(`ui:shots: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
