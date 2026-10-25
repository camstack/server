#!/usr/bin/env tsx
/**
 * Customize bespoke-card guard (D936). A cap that declares `customize` is
 * offered by the generic scalar, keyed-array and event cards. A component or
 * builder named after that cap outside those folders is a second card, and a
 * new override has to go through the generic compile path.
 *
 * Run: npx tsx scripts/check-customize-bespoke-card.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAP_CUSTOMIZE_CATALOG } from '../packages/types/src/generated/customize-catalog.ts'
import { bespokeCustomizeHits, scanCustomizeSources } from './lib/customize-bespoke.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function main(): void {
  const caps = Object.keys(CAP_CUSTOMIZE_CATALOG)
  const hits = bespokeCustomizeHits(scanCustomizeSources(repoRoot), caps)
  if (hits.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `✔ customize bespoke cards: ${caps.length} declared caps, no leftover card or builder`,
    )
    return
  }
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ customize bespoke-card guard failed\x1b[0m')
  for (const hit of hits) {
    // eslint-disable-next-line no-console
    console.error(`    - ${hit.path} [${hit.cap}] ${hit.message}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

main()
