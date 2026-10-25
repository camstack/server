import { NavigationRuntimeStateSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NAV_COLD_START, navigationSlice } from '../devices/dreame-camera-device.js'

/**
 * The runtime-state slice the camera device writes must satisfy the cap's
 * RUNTIME schema (status + `lastFetchedAt`), not just the status schema. On
 * 2026-09-06 the cold-start write lacked `lastFetchedAt`, `setCapState`
 * threw at activation, and neither the navigation provider nor the PTZ
 * mimic were ever registered ("device.onActivate() threw").
 */
describe('navigation slice writes satisfy the runtime-state schema', () => {
  it('the cold-start slice parses', () => {
    expect(NavigationRuntimeStateSchema.safeParse(NAV_COLD_START).success).toBe(true)
  })

  it('a patched slice parses and refreshes both clocks', () => {
    const next = navigationSlice(NAV_COLD_START, { flash: true }, 1234)
    expect(NavigationRuntimeStateSchema.safeParse(next).success).toBe(true)
    expect(next).toMatchObject({ flash: true, lastChangedAt: 1234, lastFetchedAt: 1234 })
  })
})
