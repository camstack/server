#!/usr/bin/env tsx
/**
 * GUARD: the per-field claim contract has a closed set of producers (D663).
 *
 * A claim rewrites what every consumer reads for a device's field. What can go
 * wrong is silent: a provider addon calling `claimFields` on its own device
 * becomes a second authority for a field it already writes natively (D62), and
 * a module spelling the row key `'$owned'` grows a second reading of the row
 * that the mirror never learns about. Neither fails a type check. The rules
 * live in `field-claims-guard.ts`, where `scripts/__tests__/check-field-claims.
 * spec.ts` proves each red on a fixture and green on the real tree.
 *
 * Usage: tsx scripts/check-field-claims.ts
 */
import { checkFieldClaimFacts, collectFieldClaimFiles } from './field-claims-guard.ts'

function main(): void {
  const files = collectFieldClaimFiles()
  const failures = checkFieldClaimFacts(files)
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-field-claims: FAILED\n')
    // eslint-disable-next-line no-console
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`check-field-claims: OK — ${files.length} source files, one claim contract`)
}

main()
