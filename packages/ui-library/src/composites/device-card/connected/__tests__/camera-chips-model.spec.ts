import { describe, expect, it } from 'vitest'
import { defaultUiText } from '../../../../contexts/ui-text'
import { cameraChipsOf } from '../camera-chips-model'

const NOW = 1_700_000_000_000
const ids = (chips: readonly { id: string }[]): string[] => chips.map((c) => c.id)
const NOTHING = { battery: undefined, sleep: undefined, motion: undefined }

describe('cameraChipsOf', () => {
  it('draws nothing for a camera that binds none of the generic caps', () => {
    expect(cameraChipsOf(NOTHING, NOW, defaultUiText)).toEqual([])
  })

  it('draws charge, power source and sleep for a battery camera on its battery', () => {
    const chips = cameraChipsOf(
      { ...NOTHING, battery: { level: 82, charging: 'none', sleeping: true } },
      NOW,
      defaultUiText,
    )
    expect(chips.map((c) => [c.id, c.label])).toEqual([
      ['battery', '82%'],
      ['power', 'Battery'],
      ['sleep', 'Asleep'],
    ])
  })

  it('names wired and solar, and flags a low charge', () => {
    const wired = cameraChipsOf(
      { ...NOTHING, battery: { level: 12, charging: 'dc', sleeping: false } },
      NOW,
      defaultUiText,
    )
    expect(wired.find((c) => c.id === 'power')?.label).toBe('Wired')
    expect(wired.find((c) => c.id === 'battery')?.tone).toBe('warning')
    const solar = cameraChipsOf(
      { ...NOTHING, battery: { level: 90, charging: 'solar', sleeping: false } },
      NOW,
      defaultUiText,
    )
    expect(solar.find((c) => c.id === 'power')?.label).toBe('Solar')
  })

  it('skips an unknown level and an unknown power source rather than drawing them', () => {
    const chips = cameraChipsOf(
      { ...NOTHING, battery: { level: null, charging: 'unknown', sleeping: false } },
      NOW,
      defaultUiText,
    )
    expect(ids(chips)).toEqual(['sleep'])
  })

  it('prefers the low-power-sleep cap over the battery flag', () => {
    const chips = cameraChipsOf(
      {
        battery: { level: 50, charging: 'none', sleeping: false },
        sleep: { sleeping: true },
        motion: undefined,
      },
      NOW,
      defaultUiText,
    )
    expect(chips.find((c) => c.id === 'sleep')?.label).toBe('Asleep')
  })

  it('draws a sleep chip from low-power-sleep alone, for a wired sleeper', () => {
    const chips = cameraChipsOf({ ...NOTHING, sleep: { sleeping: false } }, NOW, defaultUiText)
    expect(chips.map((c) => c.label)).toEqual(['Awake'])
  })

  it('draws the last motion as a relative time, and says nothing for a seeded stamp', () => {
    const since = cameraChipsOf(
      { ...NOTHING, motion: { detected: false, lastDetectedAt: NOW - 2 * 60_000 } },
      NOW,
      defaultUiText,
    )
    expect(since.map((c) => c.label)).toEqual(['Motion 2 min ago'])
    expect(
      cameraChipsOf(
        { ...NOTHING, motion: { detected: false, lastDetectedAt: null } },
        NOW,
        defaultUiText,
      ),
    ).toEqual([])
    expect(
      cameraChipsOf(
        { ...NOTHING, motion: { detected: false, lastDetectedAt: 1 } },
        NOW,
        defaultUiText,
      ),
    ).toEqual([])
  })

  it('says motion now while it is detected', () => {
    const chips = cameraChipsOf(
      { ...NOTHING, motion: { detected: true, lastDetectedAt: NOW } },
      NOW,
      defaultUiText,
    )
    expect(chips.map((c) => [c.label, c.tone])).toEqual([['Motion now', 'warning']])
  })
})
