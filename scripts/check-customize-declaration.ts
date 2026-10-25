#!/usr/bin/env tsx
/**
 * Customize declaration guard (D936). A cap may offer a generic override only
 * by declaring `customize`, and that declaration has to name paths, types and
 * vocabulary the cap actually has.
 *
 * Rules, judged by `scripts/lib/customize-declaration.ts` against the real
 * Zod schemas and the D920 vocabulary map. See the design
 * `docs/design/2026-10-24-generic-device-customize.md` §4.1.
 *
 * Run: npx tsx scripts/check-customize-declaration.ts
 */
import { judgeCustomize, loadCustomizeCaps } from './lib/customize-declaration.ts'

async function main(): Promise<void> {
  const caps = await loadCustomizeCaps()
  const violations = caps.flatMap((cap) => judgeCustomize(cap))
  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`✔ customize declarations: ${caps.length} caps, all paths and vocabulary agree`)
    return
  }
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ customize declaration guard failed\x1b[0m')
  for (const violation of violations) {
    const target = violation.targetId === undefined ? '' : `.${violation.targetId}`
    // eslint-disable-next-line no-console
    console.error(`    - ${violation.capName}${target} [${violation.rule}] ${violation.message}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

void main()
