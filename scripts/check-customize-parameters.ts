#!/usr/bin/env tsx
/**
 * Customize parameter guard (D944). An extension's transform parameters —
 * threshold, comparison, dwell, scale, offset, clamp, debounce, edges,
 * source modes, timeout — have to appear on the catalog the editor reads.
 * A declaration field the projector drops fails codegen and this guard.
 *
 * Run: npx tsx scripts/check-customize-parameters.ts
 */
import { CAP_CUSTOMIZE_CATALOG } from '../packages/types/src/generated/customize-catalog.ts'
import { loadCustomizeCaps } from './lib/customize-declaration.ts'
import { projectCustomize } from './lib/customize-project.ts'

async function main(): Promise<void> {
  const caps = await loadCustomizeCaps()
  const mismatches: string[] = []
  for (const cap of caps) {
    let projected: ReturnType<typeof projectCustomize>
    try {
      projected = projectCustomize(cap)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'projection failed'
      mismatches.push(`${cap.capName}: ${message}`)
      continue
    }
    const stored = CAP_CUSTOMIZE_CATALOG[cap.capName]
    if (JSON.stringify(stored) !== JSON.stringify(projected)) {
      mismatches.push(`${cap.capName}: generated catalog is not the projection`)
    }
  }
  if (mismatches.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`✔ customize parameters: ${caps.length} caps project every declared parameter`)
    return
  }
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ customize parameter guard failed\x1b[0m')
  for (const mismatch of mismatches) {
    // eslint-disable-next-line no-console
    console.error(`    - ${mismatch}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

void main()
