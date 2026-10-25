#!/usr/bin/env tsx
/**
 * GUARD: an owner-only event category never reaches a consumer surface (D224,
 * D663).
 *
 * The native shadow of a claimed cap (`device.native-shadow-changed`) is for
 * the composer alone; served to anyone else it is a second truth beside the
 * merged slice. Two things can silently go wrong: a new subscriber to the
 * category anywhere in the tree, and a new public event procedure that reads
 * the bus without `isPublicEvent` — the eighth such path was found by a
 * review, not by a test, because a raw forwarder subscribes to nothing by
 * name. The rules live in `owner-only-events-guard.ts`, where
 * `scripts/__tests__/check-owner-only-events.spec.ts` proves each red on a
 * fixture and green on the real tree.
 *
 * Usage: tsx scripts/check-owner-only-events.ts
 */
import { checkOwnerOnlyEventFacts, collectOwnerOnlyEventFiles } from './owner-only-events-guard.ts'

function main(): void {
  const files = collectOwnerOnlyEventFiles()
  const failures = checkOwnerOnlyEventFacts(files)
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-owner-only-events: FAILED\n')
    // eslint-disable-next-line no-console
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `check-owner-only-events: OK — ${files.length} source files; one shadow subscriber, every public path filtered`,
  )
}

main()
