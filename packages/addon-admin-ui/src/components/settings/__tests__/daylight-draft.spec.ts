import { describe, expect, it } from 'vitest'
import type { DaylightSettings } from '@camstack/types'
import { draftOfSettings, pendingChanges, settingsOfDraft } from '../daylight-draft'

const SENSOR: DaylightSettings = {
  source: 'sensor',
  deviceId: 7,
  cap: 'ambient-light-sensor',
  fieldPath: 'illuminance',
  darkBelow: 20,
  hysteresis: 8,
  minDwellMin: 15,
}

describe('daylight draft', () => {
  it('round-trips a sensor setting', () => {
    expect(settingsOfDraft(draftOfSettings(SENSOR))).toEqual(SENSOR)
  })

  it('a sensor draft with no device picked cannot be saved and counts as pending', () => {
    const draft = { ...draftOfSettings({ source: 'sun' }), source: 'sensor' as const }
    expect(settingsOfDraft(draft)).toBeNull()
    expect(pendingChanges({ source: 'sun' }, draft)).toBe(1)
  })

  it('an untouched draft has nothing pending, an edited threshold has', () => {
    const draft = draftOfSettings(SENSOR)
    expect(pendingChanges(SENSOR, draft)).toBe(0)
    expect(pendingChanges(SENSOR, { ...draft, darkBelow: 30 })).toBe(1)
  })

  it('switching back to the sun saves only the source', () => {
    expect(settingsOfDraft({ ...draftOfSettings(SENSOR), source: 'sun' })).toEqual({
      source: 'sun',
    })
  })
})
