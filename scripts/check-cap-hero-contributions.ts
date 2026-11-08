#!/usr/bin/env tsx
/**
 * GUARD: every device capability is accounted for in the hero (D1023).
 *
 * A device cap either CONTRIBUTES to the hero model (it appears in
 * `HERO_CAP_CONTRIBUTIONS`) or is listed in `HERO_CAP_COVERAGE` with the reason
 * it does not. A new cap with neither is silent drift: its facts never reach
 * the hero and nobody decided that. Also refused: `contributes` with no
 * contribution, a contribution not declared as such, and an entry for a cap
 * that no longer exists. `remote` is a system cap listed because its button is
 * a reserved slot.
 *
 *   npx tsx scripts/check-cap-hero-contributions.ts
 */
import { ALL_CAPABILITY_DEFINITIONS } from '../packages/types/src/generated/capability-router-map.js'
import { HERO_CAP_COVERAGE } from '../packages/types/src/device/hero/hero-cap-coverage.js'
import { HERO_CAP_CONTRIBUTIONS } from '../packages/types/src/device/hero/hero-contributions.js'

const REMOTE = 'remote'
const problems: string[] = []

const deviceCaps = new Set(
  ALL_CAPABILITY_DEFINITIONS.filter((d) => d.scope === 'device' || d.name === REMOTE).map(
    (d) => d.name,
  ),
)
const contributing = new Set(HERO_CAP_CONTRIBUTIONS.map((c) => c.cap))

for (const cap of deviceCaps) {
  const entry = HERO_CAP_COVERAGE[cap]
  if (entry === undefined) {
    problems.push(
      `"${cap}" is a device cap with no hero decision: add it to HERO_CAP_COVERAGE ('contributes' or a reason)`,
    )
  } else if (entry === 'contributes' && !contributing.has(cap)) {
    problems.push(`"${cap}" is declared 'contributes' but has no entry in HERO_CAP_CONTRIBUTIONS`)
  } else if (entry !== 'contributes' && entry.none.trim().length === 0) {
    problems.push(`"${cap}" is excluded without a reason`)
  }
}
for (const cap of contributing) {
  if (HERO_CAP_COVERAGE[cap] !== 'contributes')
    problems.push(`"${cap}" contributes but is not declared 'contributes'`)
}
for (const cap of Object.keys(HERO_CAP_COVERAGE)) {
  if (!deviceCaps.has(cap))
    problems.push(
      `HERO_CAP_COVERAGE names "${cap}", which is not a device cap (renamed or removed?)`,
    )
}

if (problems.length > 0) {
  console.error(`check-cap-hero-contributions: ${problems.length} problem(s)`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `check-cap-hero-contributions: ${deviceCaps.size} caps accounted for, ${contributing.size} contribute`,
)
