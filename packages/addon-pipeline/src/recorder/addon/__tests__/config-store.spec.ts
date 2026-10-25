import { describe, it, expect } from 'vitest'
import type { IScopedLogger, RecordingConfig } from '@camstack/types'
import {
  readDeviceConfigs,
  loadDeviceConfig,
  saveDeviceConfig,
  activeModeForConfig,
  warnLostBands,
  migrateLegacyDeviceSignalRows,
  recordingConfigsState,
  DEFAULT_DEVICE_CONFIG,
  type ConfigStoreLogger,
  type RecordingConfigsState,
} from '../config-store.js'
import { type FakeDeviceSettings, makeDeviceSettingsFake } from './configs-state-fixture.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  // Documented type boundary: the store only ever calls `warn`.
  return logger as unknown as IScopedLogger
}

/**
 * A real settings engine on `:memory:`, with the collection declared — the
 * production wiring minus the addon. Seeding goes through the store's own
 * writer, so a spec can never seed a shape production cannot write.
 */
async function fakeState(): Promise<{
  state: RecordingConfigsState
  settings: FakeDeviceSettings
}> {
  const settings = makeDeviceSettingsFake()
  const state = recordingConfigsState({ settings, logger: silentLogger() })
  await state.declare()
  return { state, settings }
}

/**
 * Put a config in a camera's settings the way an OLDER BUILD (or the migration
 * script) would have — payload verbatim, bypassing the store's own writer. A
 * spec that must seed a shape production would reject (a retired legacy key, a
 * corrupt value) has to go around it. Nothing else may.
 */
async function seedRow(
  settings: FakeDeviceSettings,
  deviceId: string,
  value: unknown,
): Promise<void> {
  await settings.writeDeviceStore(Number(deviceId), { recordingConfig: value })
}

describe('config-store', () => {
  it('returns the disabled default for an unconfigured device', async () => {
    const { state } = await fakeState()
    expect(await loadDeviceConfig(state, 7)).toEqual(DEFAULT_DEVICE_CONFIG)
  })

  it('round-trips a saved config and surfaces it via readDeviceConfigs', async () => {
    const { state } = await fakeState()
    const config: RecordingConfig = {
      enabled: true,
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
    }
    const saved = await saveDeviceConfig(state, 42, config)
    // `mode` is stamped as the DERIVED summary of the bands on every save.
    const expected = { ...config, mode: 'continuous' as const }
    expect(saved).toEqual(expected)
    expect(await loadDeviceConfig(state, 42)).toEqual(expected)
    const all = await readDeviceConfigs(state)
    expect(all.get(42)).toEqual(expected)
  })

  it('keeps a camera config in ITS device settings and reads it back with ONE keyed read', async () => {
    const { state, settings } = await fakeState()
    const config: RecordingConfig = { enabled: true, bands: [] }
    await saveDeviceConfig(state, 42, config)
    await saveDeviceConfig(state, 43, config)
    expect([...settings.rows.keys()].toSorted()).toEqual([42, 43])
    expect(Object.keys(settings.rows.get(42) ?? {})).toEqual(['recordingConfig'])

    settings.calls.length = 0
    // Enabled with NO bands = nothing records → derived mode 'off'.
    expect(await loadDeviceConfig(state, 42)).toEqual({ ...config, mode: 'off' })
    // The whole point: one camera's scope read, not a parse of every camera's config.
    expect(settings.calls).toEqual(['read:42'])
  })

  it('a deleted device scope takes the config with it — the camera reads as unconfigured', async () => {
    const { state, settings } = await fakeState()
    await saveDeviceConfig(state, 42, { enabled: true, bands: [] })
    settings.rows.delete(42)
    expect(await loadDeviceConfig(state, 42)).toEqual(DEFAULT_DEVICE_CONFIG)
  })

  it('a corrupt ROW costs that camera only — the blob used to cost the whole fleet', async () => {
    const { state, settings } = await fakeState()
    await saveDeviceConfig(state, 1, { enabled: true, bands: [] })
    await seedRow(settings, '7', 'garbage — not a record')

    // The blob's single safeParse fell back to `{}` here: EVERY camera
    // unconfigured because of one bad entry.
    const all = await readDeviceConfigs(state)
    expect([...all.keys()]).toEqual([1])
    expect(await loadDeviceConfig(state, 7)).toEqual(DEFAULT_DEVICE_CONFIG)
  })

  // The legacy authoring surface was retired 2026-07-30 and the WIRE schema is
  // strict — but a blob written by an older build may still carry those keys.
  // Reading must strip them, not reject the record: one bad device would empty
  // the whole blob and silently unconfigure EVERY camera.
  it('strips retired legacy keys off a pre-retirement blob without losing the other devices', async () => {
    const { state, settings } = await fakeState()
    await seedRow(settings, '1', {
      enabled: true,
      mode: 'continuous',
      schedules: [{ kind: 'always' }],
      triggers: { motion: true },
      preBufferSec: 5,
      rules: [{ schedule: { kind: 'always' }, mode: 'continuous' }],
    })
    await seedRow(settings, '2', {
      enabled: true,
      bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
    })
    const all = await readDeviceConfigs(state)
    expect([...all.keys()].toSorted()).toEqual([1, 2])
    expect(all.get(1)).toEqual({ enabled: true, mode: 'continuous', bands: [] })
    expect(all.get(2)?.bands).toHaveLength(1)
  })

  it('warns at boot for every config that claims a mode but has no bands left', async () => {
    const warnings: string[] = []
    const logger: ConfigStoreLogger = { warn: (message) => warnings.push(message) }
    const { state, settings } = await fakeState()
    await seedRow(settings, '9', { enabled: true, mode: 'continuous', schedules: [] })
    await seedRow(settings, '3', { enabled: true, mode: 'events', triggers: { motion: true } })
    await warnLostBands(state, logger)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('device(s) 3, 9')
    expect(warnings[0]).toContain('NO bands')
  })

  it('does not warn for a legitimately band-less config', async () => {
    const warnings: string[] = []
    const logger: ConfigStoreLogger = { warn: (message) => warnings.push(message) }
    const { state } = await fakeState()
    // Enabled with no bands is a valid "record nothing" state — the derived
    // mode is 'off', so it is NOT a lost-bands config.
    await saveDeviceConfig(state, 1, { enabled: true, bands: [] })
    await saveDeviceConfig(state, 2, { enabled: false, bands: [] })
    await warnLostBands(state, logger)
    expect(warnings).toEqual([])
  })

  it('keeps multiple device configs disjoint', async () => {
    const { state } = await fakeState()
    await saveDeviceConfig(state, 1, { enabled: true, bands: [] })
    await saveDeviceConfig(state, 2, { enabled: false, bands: [] })
    const all = await readDeviceConfigs(state)
    expect([...all.keys()].toSorted()).toEqual([1, 2])
  })

  describe('activeModeForConfig', () => {
    it('off when disabled', () => {
      expect(
        activeModeForConfig({
          enabled: false,
          bands: [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' }],
        }),
      ).toBe('off')
    })
    it('off when no bands', () => {
      expect(activeModeForConfig({ enabled: true, bands: [] })).toBe('off')
    })
    it('continuous when any band is continuous', () => {
      expect(
        activeModeForConfig({
          enabled: true,
          bands: [
            { days: [], start: '00:00', end: '06:00', mode: 'events', triggers: { motion: true } },
            { days: [], start: '06:00', end: '23:59', mode: 'continuous' },
          ],
        }),
      ).toBe('continuous')
    })
    it('events when only event bands', () => {
      expect(
        activeModeForConfig({
          enabled: true,
          bands: [
            { days: [], start: '00:00', end: '23:59', mode: 'events', triggers: { motion: true } },
          ],
        }),
      ).toBe('events')
    })
  })
})

describe('migrateLegacyDeviceSignalRows — the D371 row becomes the D380 mode', () => {
  /** Camera 4374 exactly as the hub stores it before this change. */
  const LEGACY_4374 = {
    enabled: true,
    mode: 'events',
    profiles: ['low'],
    bands: [
      {
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '23:59',
        mode: 'events',
        triggers: { deviceSignal: true },
        preBufferSec: 5,
        postBufferSec: 15,
      },
    ],
  }

  it('reads the legacy row as the mode BEFORE anything is persisted', async () => {
    const { state, settings } = await fakeState()
    await seedRow(settings, '4374', LEGACY_4374)
    // No migration run yet: the read path alone must already be correct, or the
    // camera records nothing for the whole boot that precedes the write.
    const config = await loadDeviceConfig(state, 4374)
    expect(config.deviceDecision).toBe(true)
    expect(config.bands).toEqual([])
    expect(config.enabled).toBe(true)
  })

  it('persists the migration and is IDEMPOTENT — a second run changes nothing', async () => {
    const { state, settings } = await fakeState()
    await seedRow(settings, '4374', LEGACY_4374)
    const logs: string[] = []
    const logger = {
      warn: (msg: string) => logs.push(`warn:${msg}`),
      info: (msg: string) => logs.push(`info:${msg}`),
    }
    const first = await migrateLegacyDeviceSignalRows(state, logger)
    expect(first.migrated).toEqual([4374])
    expect(first.stripped).toEqual([])
    const stored = await loadDeviceConfig(state, 4374)
    expect(stored).toEqual({
      enabled: true,
      bands: [],
      deviceDecision: true,
      profiles: ['low'],
      mode: 'on-device-decision',
    })
    const second = await migrateLegacyDeviceSignalRows(state, logger)
    expect(second.migrated).toEqual([])
    expect(second.stripped).toEqual([])
    expect(await loadDeviceConfig(state, 4374)).toEqual(stored)
  })

  it('a camera the operator had switched OFF stays off through the migration', async () => {
    const { state, settings } = await fakeState()
    await seedRow(settings, '4374', { ...LEGACY_4374, enabled: false })
    await migrateLegacyDeviceSignalRows(state, silentLogger())
    const stored = await loadDeviceConfig(state, 4374)
    expect(stored.enabled).toBe(false)
    expect(stored.deviceDecision).toBe(true)
    expect(stored.mode).toBe('off')
  })

  it('does not report a device-decision config among the band-less ones', async () => {
    const { state, settings } = await fakeState()
    await seedRow(settings, '4374', LEGACY_4374)
    await migrateLegacyDeviceSignalRows(state, silentLogger())
    const { deviceIdsWithLostBands } = await import('../config-store.js')
    expect(deviceIdsWithLostBands(await readDeviceConfigs(state))).toEqual([])
  })
})
