import { describe, expect, it } from 'vitest'
import { applyPersistedClimateTempStep } from '../shc-climate-temp-step.js'
import { mapRoomClimateStateToSlice } from '../shc-domain-mapping.js'

describe('applyPersistedClimateTempStep', () => {
  it('overrides mapper default when config tempStep is positive', () => {
    const base = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      setpointTemperature: 20,
      temperature: 19,
    })
    expect(base.tempStep).toBe(0.5)
    const withConfig = applyPersistedClimateTempStep(base, 1)
    expect(withConfig.tempStep).toBe(1)
  })

  it('keeps mapper default when config tempStep is absent', () => {
    const base = mapRoomClimateStateToSlice({
      '@type': 'climateControlState',
      setpointTemperature: 20,
      temperature: 19,
    })
    expect(applyPersistedClimateTempStep(base, undefined).tempStep).toBe(0.5)
  })
})
