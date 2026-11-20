/**
 * D1062 — the floodlight is read by the hub (push none, 30 s) and owns no
 * timer; a command confirms nothing itself: the hub's read after it is what the
 * slice shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HikvisionLightAccessory } from '../accessories/light.js'

interface Supplement {
  readonly mode: string
  readonly brightness?: number
}

function makeSubject(getSupplementLight: () => Promise<Supplement | null>) {
  const registered: { name: string; provider: unknown; options: unknown }[] = []
  const setCapSlice = vi.fn()
  const setSupplementLight = vi.fn(async () => {})
  const getSupplement = vi.fn(getSupplementLight)
  const subject = {
    cameraNumber: 1,
    onMode: 'colorVuWhiteLight',
    setCapSlice,
    switchView: () => ({ on: false, lastChangedAt: 0 }),
    brightnessView: () => ({ level: 100, lastChangedAt: 0 }),
    parent: {
      ensureClient: () => ({ getSupplementLight: getSupplement, setSupplementLight }),
    },
    ctx: {
      stableId: 'hik:front:light',
      registerNativeCap: (cap: { name: string }, provider: unknown, options?: unknown) => {
        registered.push({ name: cap.name, provider, options })
      },
    },
    refreshFromFirmware: HikvisionLightAccessory.prototype['refreshFromFirmware'],
  }
  const refresh = async (): Promise<unknown> => {
    const found = registered.find((r) => r.name === 'device-state-refresh')?.provider
    if (typeof found !== 'object' || found === null || !('refresh' in found)) {
      throw new Error('no refresh provider registered')
    }
    const call: unknown = found.refresh
    if (typeof call !== 'function') throw new Error('refresh is not a function')
    return call({ deviceId: 5, deviceIds: [5], reason: 'interval' })
  }
  return { subject, registered, setCapSlice, setSupplementLight, getSupplement, refresh }
}

describe('Hikvision floodlight through device-state-refresh (D1062)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('declares a polled 30 s read under its own group', () => {
    const h = makeSubject(async () => null)
    HikvisionLightAccessory.prototype['registerStateRefresh'].call(h.subject)
    expect(h.registered[0]?.options).toMatchObject({
      stateRefresh: {
        integrationId: 'hik:front:light',
        minIntervalMs: 30_000,
        push: 'none',
        batch: false,
      },
    })
  })

  it('a refresh writes the firmware on/off and brightness to the slices', async () => {
    const h = makeSubject(async () => ({ mode: 'colorVuWhiteLight', brightness: 40 }))
    HikvisionLightAccessory.prototype['registerStateRefresh'].call(h.subject)
    await h.refresh()
    expect(h.setCapSlice).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'switch' }),
      expect.objectContaining({ on: true }),
    )
    expect(h.setCapSlice).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'brightness' }),
      expect.objectContaining({ level: 40 }),
    )
  })

  it('a refresh the camera cannot serve fails, so the core backs off', async () => {
    const h = makeSubject(async () => {
      throw new Error('ISAPI 503')
    })
    HikvisionLightAccessory.prototype['registerStateRefresh'].call(h.subject)
    await expect(h.refresh()).rejects.toThrow(/ISAPI 503/)
  })

  it('a command writes no slice itself', async () => {
    const h = makeSubject(async () => null)
    await HikvisionLightAccessory.prototype['applyOn'].call(h.subject, true, 60)
    expect(h.setSupplementLight).toHaveBeenCalledOnce()
    expect(h.setCapSlice).not.toHaveBeenCalled()
  })

  it('owns no timer: nothing is read while time passes', async () => {
    const h = makeSubject(async () => ({ mode: 'close' }))
    HikvisionLightAccessory.prototype['registerStateRefresh'].call(h.subject)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.getSupplement).not.toHaveBeenCalled()
  })
})
