import { describe, it, expect, vi } from 'vitest'
import { dispatchDerivedFormSave, type DerivedFormSaveSurface } from '../device-aggregation.js'

describe('dispatchDerivedFormSave', () => {
  it('routes to setSettings when the provider exposes it (day-night / image-settings)', async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined)
    const provider: DerivedFormSaveSurface = { setSettings }

    await dispatchDerivedFormSave(
      'day-night',
      42,
      { dayNight_mode: 'night' },
      provider,
      'day-night',
    )

    expect(setSettings).toHaveBeenCalledWith({ deviceId: 42, settings: { mode: 'night' } })
  })

  it('routes to setProfile when the provider exposes it (stream-params) — never calls setSettings', async () => {
    const setProfile = vi.fn().mockResolvedValue(undefined)
    const provider: DerivedFormSaveSurface = { setProfile }

    await dispatchDerivedFormSave(
      'stream-params',
      7,
      { streamMain_codec: 'h265' },
      provider,
      'stream-params',
    )

    expect(setProfile).toHaveBeenCalledWith({
      deviceId: 7,
      profile: 'main',
      patch: { codec: 'h265' },
    })
  })

  it('prefers setSettings over setProfile when a provider exposes both', async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined)
    const setProfile = vi.fn().mockResolvedValue(undefined)
    const provider: DerivedFormSaveSurface = { setSettings, setProfile }

    await dispatchDerivedFormSave('day-night', 1, { dayNight_mode: 'day' }, provider, 'day-night')

    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setProfile).not.toHaveBeenCalled()
  })

  it('throws when the provider exposes neither method', async () => {
    await expect(dispatchDerivedFormSave('day-night', 1, {}, {}, 'day-night')).rejects.toThrow(
      /exposes neither setSettings nor setProfile/,
    )
  })
})
