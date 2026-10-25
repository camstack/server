import { VACUUM_CONSUMABLES } from '@apocaliss92/nodedreame'
import { describe, expect, it } from 'vitest'
import { DREAME_NUMERIC_SENSORS } from '../dreame-entity-catalog.js'

/**
 * Time left is exposed as the `*-time-left` numeric-sensor children — the
 * `consumables` cap item carries no time-left field. Those children read the
 * robot's property cache, which `refreshConsumables()` (nodedreame ≥1.12.5)
 * now reseeds together with the life %. That only works while the catalog's
 * coordinates ARE the library's time-left twins: pin them.
 */
describe('time-left children match the library time-left map', () => {
  const UNIT = { hours: 'h', days: 'days' } as const

  for (const spec of VACUUM_CONSUMABLES) {
    const twin = spec.timeLeft
    if (twin === null) continue
    it(`${spec.key}: ${twin.siid}/${twin.piid} in ${twin.unit}`, () => {
      const child = DREAME_NUMERIC_SENSORS.find((s) => s.key === `${spec.key}-time-left`)
      expect(child).toBeDefined()
      expect({ siid: child?.siid, piid: child?.piid, unit: child?.unit }).toEqual({
        siid: twin.siid,
        piid: twin.piid,
        unit: UNIT[twin.unit],
      })
    })
  }
})
