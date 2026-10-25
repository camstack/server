/**
 * Global → device settings CASCADE (D62-family, 2026-08-21).
 *
 * The global settings page (`updateGlobalSettings`) writes the ADDON store;
 * the per-frame resolvers (`resolveDeviceFaceSettings` & siblings) read the
 * DEVICE store. Until this spec's fix, a device with no per-device override
 * fell back to the SCHEMA defaults — the operator's global values were a knob
 * nobody at frame-time read. Live cost: the face `similarityThreshold` was
 * moved to 0.45 globally on 2026-08-21 and the matcher kept running at the
 * 0.55 schema default, so a 0.507-cosine face (track 3892b82b…) surfaced as a
 * "51%" suggestion instead of auto-assigning.
 *
 * Contract pinned here: device override > global store value > schema default,
 * resolved per field.
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
import type { FaceSettings } from '../face-settings.js'
import type { TrackingSettings } from '../tracking-settings.js'

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
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
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
  return { addon, addonStore, deviceStore }
}

describe('pipeline-analytics — global → device settings cascade', () => {
  let booted: BootResult | null = null
  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = null
  })

  it('a GLOBAL face similarityThreshold reaches a device with no override (the 2026-08-21 live defect)', async () => {
    // 0.40, the operator's live value: it must differ from the 0.45 schema
    // default (D651) or this test cannot tell the global from the default.
    booted = await boot({ similarityThreshold: 0.4 })
    const resolved: FaceSettings = await booted.addon['resolveDeviceFaceSettings'](104)
    expect(resolved.similarityThreshold).toBe(0.4)
    // Fields the operator did NOT touch keep their schema defaults.
    expect(resolved.margin).toBe(0.12)
    expect(resolved.confirmFrames).toBe(3)
  })

  it('a per-DEVICE override still wins over the global value', async () => {
    booted = await boot({ similarityThreshold: 0.45 })
    booted.deviceStore.set(591, { similarityThreshold: 0.7 })
    const resolved: FaceSettings = await booted.addon['resolveDeviceFaceSettings'](591)
    expect(resolved.similarityThreshold).toBe(0.7)
  })

  it('no global, no override ⇒ schema default (unchanged fallback)', async () => {
    booted = await boot({})
    const resolved: FaceSettings = await booted.addon['resolveDeviceFaceSettings'](107)
    expect(resolved.similarityThreshold).toBe(0.45)
  })

  it('the cascade is generic to every per-device settings kind (tracking shown)', async () => {
    booted = await boot({ iouThreshold: 0.55 })
    const resolved: TrackingSettings = await booted.addon['resolveDeviceTrackingSettings'](593)
    expect(resolved.iouThreshold).toBe(0.55)
  })

  it('foreign addon-store keys (secrets, unrelated config) never leak into a resolved kind', async () => {
    booted = await boot({ ncArtifactSecret: 'abc', similarityThreshold: 0.45 })
    const resolved: FaceSettings = await booted.addon['resolveDeviceFaceSettings'](594)
    // Schema-driven resolve: only declared fields survive.
    expect(Object.keys(resolved)).not.toContain('ncArtifactSecret')
  })
})
