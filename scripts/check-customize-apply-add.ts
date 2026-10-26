#!/usr/bin/env tsx
/**
 * Customize apply guard (D944). An extension target is `apply: 'add'` only.
 *
 * Run: npx tsx scripts/check-customize-apply-add.ts
 */
import { loadCustomizeCaps } from './lib/customize-declaration.ts'
import { customizeApplyViolations } from './lib/customize-apply.ts'

async function main(): Promise<void> {
  const caps = await loadCustomizeCaps()
  const violations = customizeApplyViolations(
    caps.map((cap) => ({
      capName: cap.capName,
      targets: cap.customize?.targets ?? [],
    })),
  )
  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`✔ customize apply: ${caps.length} caps, every target is add`)
    return
  }
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ customize apply guard failed\x1b[0m')
  for (const line of violations) {
    // eslint-disable-next-line no-console
    console.error(`    - ${line}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

void main()
