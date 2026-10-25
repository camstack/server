/**
 * Debug-media reclaim is a DETACHED pass, like `rebuildObjectEmbeddings`.
 *
 * The pass walks ~1.1 M rows at a paced 2 MB/s — tens of minutes — so awaiting
 * it on `addons.custom` / the cap RPC hits the 60 s UDS deadline while the
 * work carries on with no way to observe it. The start method returns
 * `{ started, alreadyRunning }` immediately; progress is `getMediaReclaimStatus`.
 */
import type { AddonContext, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
import { MediaStore } from '../store/media-store.js'
import {
  makeFakeAddonApi,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeVectorStore,
  makePipelineBootRecords,
} from './test-helpers.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: (_m: string, _e?: LogExtras) => {},
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: (_t: LogTags) => logger,
  }
  return logger
}

async function boot(): Promise<PipelineAnalyticsAddon> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const vectors = makeFakeVectorStore()
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    vectorStore: vectors.client,
  })
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()
  const records = await makePipelineBootRecords()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger: silentLogger(),
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        allocateDeviceId: async () => {
          throw new Error('no')
        },
        create: async () => {
          throw new Error('no')
        },
        createContext: () => {
          throw new Error('no')
        },
        register: async () => {
          throw new Error('no')
        },
        remove: async () => {},
        decommission: async () => {},
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
      installPythonPackages: async () => {},
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
        deviceStore.set(deviceId, { ...deviceStore.get(deviceId), ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {},
    },
    getNativeProvider: () => {
      throw new Error('no native providers')
    },
    fetchDevice: async () => {
      throw new Error('no devices')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return addon
}

describe('reclaimDebugMedia — a long pass returns started, not the outcome', () => {
  let addon: PipelineAnalyticsAddon | undefined
  let releasePage: (() => void) | undefined

  afterEach(async () => {
    releasePage?.()
    releasePage = undefined
    vi.restoreAllMocks()
    if (addon) await addon.shutdown()
    addon = undefined
  })

  async function hangTheWalk(): Promise<void> {
    const held = new Promise<void>((resolve) => {
      releasePage = resolve
    })
    vi.spyOn(MediaStore.prototype, 'pageByKindForDevice').mockImplementation(async () => {
      await held
      return []
    })
  }

  it('returns started immediately, while the walk is still in flight', async () => {
    await hangTheWalk()
    addon = await boot()

    const result = await addon.reclaimDebugMedia({ mode: 'reclaim', deviceIds: [103] })
    expect(result).toEqual({ started: true, alreadyRunning: false })

    const status = await addon.getMediaReclaimStatus()
    expect(status.running).toBe(true)
    expect(status.mode).toBe('reclaim')
    expect(status.finishedAtMs).toBeNull()
  })

  it('a second start while one is in flight is alreadyRunning, not a second walk', async () => {
    await hangTheWalk()
    addon = await boot()

    expect(await addon.reclaimDebugMedia({ mode: 'reclaim', deviceIds: [103] })).toEqual({
      started: true,
      alreadyRunning: false,
    })
    expect(await addon.reclaimDebugMedia({ mode: 'reclaim', deviceIds: [103] })).toEqual({
      started: false,
      alreadyRunning: true,
    })
  })

  it('the settings button is the same door — it also returns started', async () => {
    await hangTheWalk()
    addon = await boot()
    // Same binding the settings form hits (`addons.custom` → this handler).
    const result = await (
      addon as unknown as {
        buildEmbeddingActionHandlers(): Record<string, (input: never) => Promise<unknown>>
      }
    ).buildEmbeddingActionHandlers()['retention.mediaReclaim']!({
      mode: 'reclaim',
      deviceIds: [103],
    } as never)
    expect(result).toEqual({ started: true, alreadyRunning: false })
  })

  it('getMediaReclaimStatus (and the settings status button) report the in-flight pass', async () => {
    await hangTheWalk()
    addon = await boot()
    await addon.reclaimDebugMedia({ mode: 'reclaim', deviceIds: [103] })

    const status = await addon.getMediaReclaimStatus()
    expect(status.running).toBe(true)
    expect(status.mode).toBe('reclaim')
    expect(status.startedAtMs).toBeGreaterThan(0)
    expect(status.finishedAtMs).toBeNull()
    expect(status.error).toBeNull()

    const fromButton = await (
      addon as unknown as {
        buildEmbeddingActionHandlers(): Record<string, (input: never) => Promise<unknown>>
      }
    ).buildEmbeddingActionHandlers()['retention.mediaReclaimStatus']!({} as never)
    expect(fromButton).toMatchObject({ running: true, mode: 'reclaim' })
  })
})
