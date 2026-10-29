#!/usr/bin/env tsx
/**
 * GUARD: every entry that resolves a cap call by name asks the claim authority
 * first (D663, ruling S3).
 *
 * A claimed cap's `getStatus` is the hub mirror's merged slice for EVERY
 * caller. There is no single chokepoint: the sibling short-circuit, the
 * parent's unowned-call handler and the hub's `callCapabilityOnNode` each
 * dispatch straight to the owning runner, whose `getStatus` is the native
 * slice. Each asks `answerClaimedGetStatus` first; this guard fails the build
 * when a production file resolves by name without it. The rule lives in
 * `claimed-get-status-guard.ts`, where `scripts/__tests__/check-claimed-get-
 * status.spec.ts` proves it red on a fixture and green on the real tree.
 *
 * Usage: tsx scripts/check-claimed-get-status.ts
 */
import {
  checkClaimedGetStatusFacts,
  collectClaimedGetStatusFiles,
} from './claimed-get-status-guard.ts'

function main(): void {
  const files = collectClaimedGetStatusFiles()
  const failures = checkClaimedGetStatusFacts(files)
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-claimed-get-status: FAILED\n')
    // eslint-disable-next-line no-console
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `check-claimed-get-status: OK — ${files.length} source files, every name-resolving entry asks the claim authority and the device-call redirect`,
  )
}

main()
