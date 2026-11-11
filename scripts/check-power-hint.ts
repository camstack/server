#!/usr/bin/env tsx
/**
 * GUARD: `switch` is the one on/off control of a device (#462 P1).
 *
 * A cap's `power` hint (`*.cap.ts`) says how that device turns on and off;
 * `registerPowerSwitch` builds the device's `switch` from it. Two things go
 * wrong silently: a hinted cap grows a second power field or setter, and a
 * provider of a hinted cap forgets the helper, so that device has no switch.
 * The rules live in `power-hint-guard.ts`; `scripts/__tests__/check-power-hint.
 * spec.ts` proves each red on a fixture and green on the real tree.
 *
 * Usage: tsx scripts/check-power-hint.ts
 */
import * as capabilities from '../packages/types/src/capabilities/index.ts'
import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.ts'
import { checkHintedCaps, checkProviderWiring, collectPowerGuardFiles } from './power-hint-guard.ts'

function isCapability(value: unknown): value is CapabilityDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'methods') === 'object'
  )
}

function main(): void {
  const hinted = new Map<string, string>()
  const caps: CapabilityDefinition[] = []
  for (const [ident, value] of Object.entries(capabilities)) {
    if (!isCapability(value) || value.power === undefined) continue
    hinted.set(ident, value.name)
    caps.push(value)
  }
  const files = collectPowerGuardFiles()
  const failures = [...checkHintedCaps(caps), ...checkProviderWiring(files, hinted)]
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-power-hint: FAILED\n')
    // eslint-disable-next-line no-console
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `check-power-hint: OK — ${caps.length} power-hinted caps, ${files.length} source files`,
  )
}

main()
