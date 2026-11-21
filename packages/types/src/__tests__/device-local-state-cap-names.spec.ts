import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../generated/capability-router-map.js'
import { DEVICE_LOCAL_STATE_CAP_NAMES } from '../generated/device-local-state.js'

/**
 * `BaseDevice.state` looks a cap up by NAME (D1073): the generated table holds names so it pulls
 * no schema into a device provider's bundle. The live table is the cap definitions themselves;
 * this proves the names are exactly the device-scoped caps that declare a `runtimeState`.
 */
describe('DEVICE_LOCAL_STATE_CAP_NAMES', () => {
  const live = ALL_CAPABILITY_DEFINITIONS.filter(
    (def) => def.scope === 'device' && def.runtimeState !== undefined,
  )

  it('names exactly the device-scoped caps that declare a runtimeState', () => {
    const names = Object.values(DEVICE_LOCAL_STATE_CAP_NAMES).sort()
    expect(names).toEqual(live.map((def) => def.name).sort())
  })

  it('names every cap once (run `npm run codegen` after a cap change)', () => {
    const names = Object.values(DEVICE_LOCAL_STATE_CAP_NAMES)
    expect(new Set(names).size).toBe(names.length)
  })
})
