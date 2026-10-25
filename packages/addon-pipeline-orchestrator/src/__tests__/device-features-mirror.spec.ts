import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { DeviceFeaturesMirror, type DeviceFeaturesRead } from '../device-features-mirror.js'

/**
 * D49 regression guard — measured on the live hub 2026-08-07.
 *
 * The Reolink "Baby monitor" (deviceId 106, `battery-operated`) was woken from
 * sleep three times in 24 h by the audio-analyzer. Root cause, proven by
 * counting: 12 `Starting detection` passes produced 3 `audio subscription:
 * resolved audio node` lines — a 25% failure rate, not a permanent
 * misconfiguration.
 *
 * The chain: `lookupDeviceFeatures` collapsed BOTH "the read threw" and "the
 * device is not in the registry yet" into `[]`. An empty feature array makes
 * `resolveDeviceProfile` return `null`, `BATTERY_DEVICE_PROFILE` never applies,
 * and `audioMode` falls back to `'always-on'` — because device 106's store
 * carries only `{motionSources:['onboard']}`, so there is no operator value to
 * win. The audio subscription then dials `native:sub`, which wakes the camera.
 *
 * Every one of the three wakes landed immediately after a `provider-reolink`
 * restart (distinct pids 363, 364, 1797 in the logs), i.e. exactly when the
 * device is momentarily absent from the registry while the orchestrator process
 * keeps running. That is what the mirror covers.
 *
 * The rule being enforced is D49's: a read that FAILS changes nothing, and a
 * read that contradicts the mirror in the direction that DESTROYS work needs a
 * second read to agree.
 */

function makeLogger(): IScopedLogger & { warn: ReturnType<typeof vi.fn> } {
  const logger: IScopedLogger & { warn: ReturnType<typeof vi.fn> } = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const BATTERY = ['native-snapshot', 'battery-operated', 'two-way-audio'] as const

describe('DeviceFeaturesMirror — a fallible read never destroys the battery profile', () => {
  it('returns and remembers a successful read', async () => {
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger() })
    const out = await mirror.resolve(106, async () => BATTERY)
    expect(out).toEqual([...BATTERY])
  })

  it('serves the mirror when a later read FAILS (returns null)', async () => {
    const logger = makeLogger()
    const mirror = new DeviceFeaturesMirror({ logger: logger })
    await mirror.resolve(106, async () => BATTERY)

    const out = await mirror.resolve(106, async () => null)

    expect(out).toEqual([...BATTERY])
    expect(out).toContain('battery-operated')
    // A branch that would otherwise drop work logs it, with the deviceId tag.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('last-known'),
      expect.objectContaining({ tags: { deviceId: 106 } }),
    )
  })

  it('re-reads ONCE when an empty read contradicts a non-empty mirror, and keeps the mirror if the re-read disagrees', async () => {
    const logger = makeLogger()
    const mirror = new DeviceFeaturesMirror({ logger: logger })
    await mirror.resolve(106, async () => BATTERY)

    const read = vi
      .fn<DeviceFeaturesRead>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(BATTERY)

    const out = await mirror.resolve(106, read)

    expect(read).toHaveBeenCalledTimes(2)
    expect(out).toContain('battery-operated')
  })

  it('accepts a genuinely empty feature set when the second read AGREES', async () => {
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger() })
    await mirror.resolve(106, async () => BATTERY)

    const read = vi.fn<DeviceFeaturesRead>().mockResolvedValueOnce([]).mockResolvedValueOnce([])

    const out = await mirror.resolve(106, read)

    expect(read).toHaveBeenCalledTimes(2)
    expect(out).toEqual([])
    // ...and the mirror is cleared, so it does not resurrect a stale claim.
    const after = await mirror.resolve(106, async () => null)
    expect(after).toEqual([])
  })

  it('does not re-read when the mirror is empty too — nothing to protect', async () => {
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger() })
    const read = vi.fn<DeviceFeaturesRead>().mockResolvedValue([])

    const out = await mirror.resolve(106, read)

    expect(read).toHaveBeenCalledTimes(1)
    expect(out).toEqual([])
  })

  it('LOGS loudly when the read fails and there is no mirror — the cold-boot hole is visible, never silent', async () => {
    const logger = makeLogger()
    const mirror = new DeviceFeaturesMirror({ logger: logger })

    const out = await mirror.resolve(106, async () => null)

    expect(out).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 106 } }),
    )
  })

  it('keeps mirrors per device — one camera’s failure never serves another camera’s features', async () => {
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger() })
    await mirror.resolve(106, async () => BATTERY)

    const out = await mirror.resolve(592, async () => null)

    expect(out).toEqual([])
  })
})

/**
 * The residual cold-boot hole the file used to DOCUMENT rather than fix
 * (census §1.1 #18): the mirror was process-local, so an orchestrator whose
 * very first read of device 106 failed still resolved `[]` — and `[]` is what
 * dials a sleeping battery camera awake. The log line did not stop the dial.
 *
 * The persisted copy is a MIRROR and nothing more: the device stays the
 * authority, the row only covers the window between boot and the first
 * successful read, and two reads that agree the device is genuinely featureless
 * still clear it.
 */
/** The standard per-device settings, as an in-memory fake. */
function makeDeviceSettings() {
  const rows = new Map<number, Record<string, unknown>>()
  return {
    rows,
    readDeviceStore: async (id: number) => ({ ...rows.get(id) }),
    writeDeviceStore: async (id: number, patch: Record<string, unknown>) => {
      const next = { ...rows.get(id), ...patch }
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
      if (Object.keys(next).length === 0) rows.delete(id)
      else rows.set(id, next)
    },
    readDeviceStoreBatch: async (ids: readonly number[]) =>
      new Map(ids.map((id) => [id, { ...rows.get(id) }])),
    listDeviceStoreIds: async () => [...rows.keys()],
  }
}

describe('DeviceFeaturesMirror — the persisted copy covers the cold-boot window', () => {
  it('THE HOLE: a cold boot whose FIRST read fails serves the restored copy, not []', async () => {
    const settings = makeDeviceSettings()

    // Session one: the device answers once.
    const before = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    await before.resolve(106, async () => BATTERY)
    await Promise.resolve()

    // Session two IS the restart. Its very first read fails — the exact
    // `provider-reolink` restart window that produced the three wakes.
    const after = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    expect(await after.hydrate()).toBe(1)
    expect(await after.resolve(106, async () => null)).toEqual([...BATTERY])
  })

  it('CONTROL: without the reseed the same cold boot resolves [] — the hole, reproduced', async () => {
    const settings = makeDeviceSettings()
    const before = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    await before.resolve(106, async () => BATTERY)
    await Promise.resolve()

    const after = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    // No `hydrate()` — this is what the code did before.
    expect(await after.resolve(106, async () => null)).toEqual([])
  })

  it('the AUTHORITY wins: a successful read overwrites the restored copy at once', async () => {
    const settings = makeDeviceSettings()
    settings.rows.set(106, { deviceFeatures: { features: ['stale-feature'], updatedAt: 1 } })

    const mirror = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    await mirror.hydrate()
    expect(await mirror.resolve(106, async () => BATTERY)).toEqual([...BATTERY])
    await Promise.resolve()
    expect(settings.rows.get(106)?.['deviceFeatures']).toMatchObject({ features: [...BATTERY] })
  })

  it('says out loud that a served copy predates this process', async () => {
    const settings = makeDeviceSettings()
    settings.rows.set(106, { deviceFeatures: { features: [...BATTERY], updatedAt: 1 } })
    const logger = makeLogger()
    const mirror = new DeviceFeaturesMirror({ logger, settings })
    await mirror.hydrate()
    await mirror.resolve(106, async () => null)
    expect(logger.warn).toHaveBeenCalledWith(
      'device features unavailable — serving last-known mirror',
      expect.objectContaining({ meta: expect.objectContaining({ restored: true }) }),
    )
  })

  it('a confirmed-empty device clears the persisted row too — a mirror must not outlive the truth', async () => {
    const settings = makeDeviceSettings()
    settings.rows.set(106, { deviceFeatures: { features: [...BATTERY], updatedAt: 1 } })
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    await mirror.hydrate()
    // Two reads that AGREE the device has no features.
    expect(await mirror.resolve(106, async () => [])).toEqual([])
    await Promise.resolve()
    expect(settings.rows.has(106)).toBe(false)
  })

  it('an unchanged feature list does not rewrite its row — no clock churn', async () => {
    const settings = makeDeviceSettings()
    let clock = 100
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger(), settings, now: () => clock })
    await mirror.resolve(106, async () => BATTERY)
    await Promise.resolve()
    clock = 999
    await mirror.resolve(106, async () => [...BATTERY].toReversed())
    await Promise.resolve()
    // The set did not move, so neither did the row.
    expect(settings.rows.get(106)?.['deviceFeatures']).toMatchObject({ updatedAt: 100 })
  })

  it('forget deletes the persisted row, not just the RAM copy', async () => {
    const settings = makeDeviceSettings()
    const mirror = new DeviceFeaturesMirror({ logger: makeLogger(), settings })
    await mirror.resolve(106, async () => BATTERY)
    await Promise.resolve()
    expect(settings.rows.has(106)).toBe(true)
    mirror.forget(106)
    await Promise.resolve()
    expect(settings.rows.has(106)).toBe(false)
  })
})
