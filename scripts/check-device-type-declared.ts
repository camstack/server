#!/usr/bin/env tsx
/**
 * A device's type is declared, never guessed (#459).
 *
 * Features are derived from the bound caps; what the device IS comes from its
 * `DeviceType`. A fallback to `DeviceType.Generic` (`?? DeviceType.Generic`, a
 * `default:` arm returning it) lets a mapping gap pass as a real type, and
 * every consumer that reads the type then treats the device as "something
 * unknown" with no error anywhere. This ratchet pins how many such fallbacks
 * remain per file and only lets the number fall; the resolutions are listed in
 * the plan (`matter-cluster-mapping`, `alexa-domain-mapping`, `esp-container-device`).
 *
 * Scope: runtime source, comment lines skipped, specs and the types package
 * excluded. Textual.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareToPins, countMatchingLines, readRuntimeSource } from './lib/pinned-line-scan.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const GENERIC_FALLBACK =
  /(?:\?\?|\|\|)\s*DeviceType\.Generic\b|\bdefault:\s*return\s+DeviceType\.Generic\b|\?\s*[^:]+:\s*DeviceType\.Generic\b/

/** Fallbacks still present, per file. Lower a number in the commit that removes the hit. */
export const PINS: Readonly<Record<string, number>> = {
  'packages/addon-export-hap/src/mappers/generic-accessory.ts': 1,
  'packages/addon-provider-homeassistant/src/ha-candidate-mapper.ts': 1,
  'packages/addon-provider-homeassistant/src/ha-standalone-entity.ts': 1,
}

function main(): void {
  const files = readRuntimeSource(ROOT, (rel) => rel.startsWith('packages/types/'))
  const counts = countMatchingLines(files, GENERIC_FALLBACK)
  if (process.argv.includes('--print-pins')) {
    console.log(JSON.stringify(Object.fromEntries([...counts].sort()), null, 2))
    return
  }
  const problems = compareToPins(counts, PINS)
  if (problems.length === 0) {
    console.log(`check-device-type-declared: ${counts.size} file(s) pinned, none grew`)
    return
  }
  console.error('check-device-type-declared: a device type is declared, not defaulted to Generic:')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
