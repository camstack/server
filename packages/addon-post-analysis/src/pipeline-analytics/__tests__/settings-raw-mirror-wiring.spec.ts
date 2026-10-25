/**
 * `readDeviceSettings` wiring — A.4/A.5 of `2026-08-26-remaining-queue.md`.
 *
 * Live hub, 2026-08-26: `get pipeline-analytics:addon-settings` at
 * 547–694 calls/min, `get pipeline-analytics:addon-devices` at ~700/min.
 * Static trace: eight per-device settings kinds (audio, sensitivity,
 * tracking, confirmation-gate, face, media, stationary, package-drop) each
 * own an independent 5 s `DeviceTtlCache`, and EVERY one of them calls
 * `readDeviceSettings`, which called `resolveGlobalStore()` +
 * `readDeviceBlob()` DIRECTLY — so eight kinds expiring in the same window
 * paid for the same two reads eight times. Boots the real addon (same
 * harness as `global-settings-cascade.spec.ts`) and counts the underlying
 * `ctx.settings` calls, because a test that only checks the resolved VALUE
 * passes on the code that caused the incident.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeAddonApi,
  makePipelineBootRecords,
} from './test-helpers.js'

function makeNoopLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly addonStore: Record<string, unknown>
  readonly deviceStore: Map<number, Record<string, unknown>>
  readonly readAddonStoreCalls: () => number
  readonly readDeviceStoreCalls: () => number
}

async function boot(seed: Record<string, unknown> = {}): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
  })
  const addonStore: Record<string, unknown> = { ...seed }
  const deviceStore = new Map<number, Record<string, unknown>>()
  let readAddonStoreCalls = 0
  let readDeviceStoreCalls = 0

  const records = await makePipelineBootRecords()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger: makeNoopLogger(),
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        getAll: async () => [],
        getChildren: async () => [],
      },
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        readAddonStoreCalls += 1
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        readDeviceStoreCalls += 1
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        const existing = deviceStore.get(deviceId) ?? {}
        deviceStore.set(deviceId, { ...existing, ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {
        /* no-op */
      },
    },
    getNativeProvider: () => {
      throw new Error('no native providers in this spec')
    },
    fetchDevice: async () => {
      throw new Error('no devices in this spec')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return {
    addon,
    addonStore,
    deviceStore,
    readAddonStoreCalls: () => readAddonStoreCalls,
    readDeviceStoreCalls: () => readDeviceStoreCalls,
  }
}

describe('pipeline-analytics — readDeviceSettings raw-store mirror wiring', () => {
  let booted: BootResult | null = null
  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = null
  })

  it('eight settings kinds cold-resolving the SAME device cost ONE addon-store read and ONE device-blob read', async () => {
    booted = await boot({ similarityThreshold: 0.45 })
    const addon = booted.addon as unknown as {
      resolveDeviceFaceSettings(id: number): Promise<unknown>
      resolveDeviceMediaSettings(id: number): Promise<unknown>
      resolveDeviceTrackingSettings(id: number): Promise<unknown>
      resolveDeviceAudioSettings(id: number): Promise<unknown>
      resolveDeviceConfirmationGateSettings(id: number): Promise<unknown>
      resolveDeviceStationarySettings(id: number): Promise<unknown>
      resolveDevicePackageDropSettings(id: number): Promise<unknown>
      resolveDeviceDetectionSensitivitySettings(id: number): Promise<unknown>
    }

    // `boot()` itself already reads the addon store a handful of times
    // during ordinary startup (`resolveConfig`, the NC action/artifact
    // planes, the embedding dispatcher, the orphan-audit timer — all
    // unrelated to `readDeviceSettings`). Some of those readers keep
    // going AFTER `initialize()` resolves (NC boot backfill →
    // `pruneWindows` → `resolveGlobalStore`), so drain the microtask /
    // timer queue before sampling — otherwise a late boot read lands
    // inside the delta and looks like a second settings-kind miss.
    await new Promise<void>((r) => setImmediate(r))
    await new Promise<void>((r) => setTimeout(r, 0))
    // The read count that matters here is the DELTA the 8 concurrent
    // settings-kind resolves add, not the absolute total.
    const addonStoreReadsBefore = booted.readAddonStoreCalls()
    const deviceStoreReadsBefore = booted.readDeviceStoreCalls()

    const resolveAllKinds = async (deviceId: number): Promise<readonly unknown[]> =>
      Promise.all([
        addon.resolveDeviceFaceSettings(deviceId),
        addon.resolveDeviceMediaSettings(deviceId),
        addon.resolveDeviceTrackingSettings(deviceId),
        addon.resolveDeviceAudioSettings(deviceId),
        addon.resolveDeviceConfirmationGateSettings(deviceId),
        addon.resolveDeviceStationarySettings(deviceId),
        addon.resolveDevicePackageDropSettings(deviceId),
        addon.resolveDeviceDetectionSensitivitySettings(deviceId),
      ])

    const first = await resolveAllKinds(102)
    const afterFirstDeviceReads = booted.readDeviceStoreCalls()
    // A SECOND, previously untouched device — the count must scale with
    // devices, never with kinds.
    const second = await resolveAllKinds(9_091)

    // The resolves really ran. Without this the read-count assertions below
    // are satisfied just as well by eight calls that returned nothing.
    expect(first).toHaveLength(8)
    expect(first.every((r) => typeof r === 'object' && r !== null)).toBe(true)
    expect(second.every((r) => typeof r === 'object' && r !== null)).toBe(true)

    // Before the shared mirror: 8 kinds × 1 device-blob read each = 8 per
    // device. The mirror collapses each device's eight to ONE.
    expect(afterFirstDeviceReads - deviceStoreReadsBefore).toBe(1)
    expect(booted.readDeviceStoreCalls() - afterFirstDeviceReads).toBe(1)

    // The addon-store blob is device-INDEPENDENT, so the whole batch may cost
    // one read or none at all depending on how warm boot left the mirror.
    // What it must never do is scale with the 16 resolves. Asserting an exact
    // 1 here made the spec fail the day the mirror got warmer — a test that
    // goes red when the system improves is measuring the wrong thing.
    expect(booted.readAddonStoreCalls() - addonStoreReadsBefore).toBeLessThanOrEqual(1)
  })

  it('applyDeviceSettingsPatch: the raw mirror does not re-serve the pre-patch blob to the kinds it clears', async () => {
    // `tracking` IS one of the four kinds `applyDeviceSettingsPatch` clears
    // directly (audio/sensitivity/tracking/confirmation-gate, "legacy
    // parity" — unchanged by this fix). That clear only works if the SHARED
    // raw mirror it re-fills from is ALSO fresh: without
    // `rawDeviceBlobMirror.invalidate()` in `applyDeviceSettingsPatch`, the
    // cleared kind cache would miss, call `readDeviceSettings` again, and get
    // served the pre-patch blob straight back out of the still-warm mirror —
    // the exact D224 failure (a write whose own mirror doesn't see it).
    booted = await boot()
    const addon = booted.addon as unknown as {
      resolveDeviceTrackingSettings(id: number): Promise<{ iouThreshold: number }>
      applyDeviceSettingsPatch(input: {
        deviceId: number
        patch: Record<string, unknown>
      }): Promise<{ success: true }>
    }

    const before = await addon.resolveDeviceTrackingSettings(108)
    expect(before.iouThreshold).toBe(0.3) // schema default

    await addon.applyDeviceSettingsPatch({
      deviceId: 108,
      patch: { iouThreshold: 0.6 },
    })

    const after = await addon.resolveDeviceTrackingSettings(108)
    expect(after.iouThreshold).toBe(0.6)
  })

  it('onConfigChanged: a GLOBAL settings change invalidates the shared mirror, not only the per-kind cache', async () => {
    // Warm the SHARED `rawGlobalStoreMirror` through one kind/device, then
    // change a global value, then resolve a DIFFERENT kind/device (cold for
    // ITS OWN per-kind cache, so it must re-read). Without
    // `onConfigChanged` invalidating the shared mirror, this cold read would
    // still be served the pre-update blob the mirror was holding warm —
    // `updateGlobalSettings`'s own write would be invisible to its own
    // process for up to `RAW_SETTINGS_STALE_MS`.
    booted = await boot({ similarityThreshold: 0.55 })
    const addon = booted.addon as unknown as {
      resolveDeviceTrackingSettings(id: number): Promise<unknown>
      resolveDeviceFaceSettings(id: number): Promise<{ similarityThreshold: number }>
      updateGlobalSettings(patch: Record<string, unknown>): Promise<void>
    }

    await addon.resolveDeviceTrackingSettings(700) // warms rawGlobalStoreMirror
    await addon.updateGlobalSettings({ similarityThreshold: 0.45 })

    const resolved = await addon.resolveDeviceFaceSettings(701) // cold kind+device
    expect(resolved.similarityThreshold).toBe(0.45)
  })
})
