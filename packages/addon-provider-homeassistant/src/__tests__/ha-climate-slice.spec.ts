import { climateControlCapability } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { climateSliceFromState } from '../devices/ha-climate-device.js'
import type { HaEntityState } from '../ha-types.js'

/**
 * Every thermostat push was being DROPPED. `handleStatePush` built the
 * `climate-control` slice without `swingVertical` / `swingHorizontal`, the
 * cap schema has them `nullable` (absent is not null), `setCapState`
 * refused the slice and the base child logged `ha-child state-push handler
 * error` — 828 times in 24 h on the live hub, once per push of every
 * `climate.termostato_*`, while the devices stayed at their cold start.
 */
function thermostat(attributes: Record<string, unknown>): HaEntityState {
  return {
    entity_id: 'climate.termostato_studio',
    state: 'heat',
    attributes,
    last_changed: '2026-09-05T15:48:38.000Z',
    last_updated: '2026-09-05T15:48:38.000Z',
  } as HaEntityState
}

const NO_SWING = {
  hvac_modes: ['off', 'heat'],
  temperature: 21,
  current_temperature: 19.5,
}

describe('climateSliceFromState', () => {
  it('builds a slice the cap schema ACCEPTS for a thermostat with no swing surface', () => {
    const slice = climateSliceFromState(thermostat(NO_SWING))
    const parsed = climateControlCapability.status.schema.safeParse(slice)
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true)
    expect(slice.swingVertical).toBeNull()
    expect(slice.swingHorizontal).toBeNull()
    expect(slice.mode).toBe('heat')
    expect(slice.target).toBe(21)
  })

  it('carries the setpoint bounds Alexa clamps to (min_temp / max_temp / target_temp_step)', () => {
    const slice = climateSliceFromState(
      thermostat({ ...NO_SWING, min_temp: 7, max_temp: 28, target_temp_step: 0.5 }),
    )
    expect([slice.minTemp, slice.maxTemp, slice.tempStep]).toEqual([7, 28, 0.5])
    const bare = climateSliceFromState(thermostat(NO_SWING))
    expect([bare.minTemp, bare.maxTemp, bare.tempStep]).toEqual([null, null, null])
  })

  it('reads the vertical louver from `swing_mode` when the device lists swing modes', () => {
    const on = climateSliceFromState(
      thermostat({ ...NO_SWING, swing_modes: ['off', 'vertical'], swing_mode: 'vertical' }),
    )
    expect(on.swingVertical).toBe(true)
    expect(on.swingHorizontal).toBeNull()
    const off = climateSliceFromState(
      thermostat({ ...NO_SWING, swing_modes: ['off', 'vertical'], swing_mode: 'off' }),
    )
    expect(off.swingVertical).toBe(false)
  })

  it('reads both louvers from a combined `both` and from `swing_horizontal_mode`', () => {
    const both = climateSliceFromState(
      thermostat({ ...NO_SWING, swing_modes: ['off', 'both'], swing_mode: 'both' }),
    )
    expect(both).toMatchObject({ swingVertical: true, swingHorizontal: true })
    const split = climateSliceFromState(
      thermostat({
        ...NO_SWING,
        swing_modes: ['off', 'on'],
        swing_mode: 'off',
        swing_horizontal_modes: ['off', 'on'],
        swing_horizontal_mode: 'on',
      }),
    )
    expect(split).toMatchObject({ swingVertical: false, swingHorizontal: true })
  })
})
