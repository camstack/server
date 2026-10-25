/**
 * The media-PRESENCE probe, on the wire.
 *
 * `videoclips` publishes a `thumbnail` only for an event the media INDEX
 * answered for — `mediaUrl` is stamped from a template for every event in the
 * system, and believing it made 64 of one camera's 179 clips point at a 404
 * (device 3836, 2026-08-17). The probe was an in-process `MediaStore` read
 * because the clip source was registered by THIS addon.
 *
 * It is not any more: the source is registered by the addon that owns the
 * footage (D560), so the probe has to cross a process boundary. It crosses as
 * ONE batched question per owner kind — never one call per owner, which is the
 * N+1 `MediaStore.ownersWithMedia` exists to prevent — and it THROWS rather
 * than answering partially, because a probe that quietly under-reports reads as
 * "these events own nothing" and silently drops thumbnails that exist.
 *
 * D683 fix round 2: for `ownerKind: 'track'`, `ownerIds` can carry an absorbed
 * provisional id (`videoclips-provider.ts`'s `resolveVouchedEvents` probes
 * with `event.trackId`, read off its own rows, never re-pointed by a fusion
 * that happened elsewhere). The describe block below pins that the probe
 * resolves to the survivor internally but answers KEYED BY THE ASKED id — see
 * `resolveTrackOwnerIds` in `track-alias-resolution.ts`.
 */
import type { AddonContext, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
import { MediaStore } from '../store/media-store.js'
import { TrackAliasStore } from '../store/track-alias-store.js'
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

describe('pipelineAnalytics.ownersWithMedia', () => {
  let addon: PipelineAnalyticsAddon | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (addon) await addon.shutdown()
    addon = undefined
  })

  it('answers ONE batched index read, naming the owner kind and the device', async () => {
    const calls: { ownerKind: string; ownerIds: readonly string[]; deviceId: number }[] = []
    vi.spyOn(MediaStore.prototype, 'ownersWithMedia').mockImplementation(
      async (ownerKind, ownerIds, deviceId) => {
        calls.push({ ownerKind, ownerIds, deviceId })
        return new Set(['11', '13'])
      },
    )
    addon = await boot()

    const answer = await addon.ownersWithMedia({
      deviceId: 101,
      ownerKind: 'motion',
      ownerIds: ['11', '12', '13'],
    })

    expect([...answer].toSorted()).toEqual(['11', '13'])
    expect(calls).toEqual([{ ownerKind: 'motion', ownerIds: ['11', '12', '13'], deviceId: 101 }])
  })

  it('an empty ask costs no read at all', async () => {
    const spy = vi.spyOn(MediaStore.prototype, 'ownersWithMedia')
    addon = await boot()
    expect(
      await addon.ownersWithMedia({ deviceId: 101, ownerKind: 'track', ownerIds: [] }),
    ).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('THROWS rather than answering partially — a quiet under-report drops live thumbnails', async () => {
    vi.spyOn(MediaStore.prototype, 'ownersWithMedia').mockImplementation(async () => {
      throw new Error('media index unreachable')
    })
    addon = await boot()
    await expect(
      addon.ownersWithMedia({ deviceId: 101, ownerKind: 'object', ownerIds: ['1'] }),
    ).rejects.toThrow('media index unreachable')
  })
})

/**
 * D683 fix round 2: `ownerKind: 'track'` is the one branch where `ownerIds`
 * can be a fused provisional id. Each test asserts the FULL round trip
 * through the real addon, not just the pure resolver — the bug the review
 * found was in the WIRING (the discriminated field was never resolved at
 * all), not in any per-function logic.
 *
 * Disarm: in `index.ts`'s `ownersWithMedia`, replace the `ownerKind !==
 * 'track'` branch guard so EVERY kind skips `resolveTrackOwnerIds` (i.e.
 * always take the pass-through path) — "an absorbed asked id still answers
 * present" fails (the store never sees the survivor, which the mock below
 * is the only owner of).
 */
describe('pipelineAnalytics.ownersWithMedia — the track branch resolves aliases (review fix round 2)', () => {
  let addon: PipelineAnalyticsAddon | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    if (addon) await addon.shutdown()
    addon = undefined
  })

  it('an absorbed asked id still answers present, keyed by the id asked (not the survivor)', async () => {
    vi.spyOn(TrackAliasStore.prototype, 'resolveMany').mockImplementation(
      async (ids) =>
        new Map(ids.filter((id) => id === 'B').map((id): [string, string] => [id, 'A'])),
    )
    const probeCalls: { ownerKind: string; ownerIds: readonly string[] }[] = []
    vi.spyOn(MediaStore.prototype, 'ownersWithMedia').mockImplementation(
      async (ownerKind, ownerIds) => {
        probeCalls.push({ ownerKind, ownerIds })
        return new Set(['A'])
      },
    )
    addon = await boot()

    const answer = await addon.ownersWithMedia({
      deviceId: 101,
      ownerKind: 'track',
      ownerIds: ['B', 'C'],
    })

    // The caller asked with 'B' (the absorbed id) — the answer must name
    // 'B', never the survivor 'A', or `trackMedia.has(event.trackId)` in
    // `videoclips-provider.ts` misses it. 'C' is not an alias (the mock
    // resolveMany answers nothing for it), so it probes as itself and is
    // not in the mocked `ownersWithMedia` result either way.
    expect(answer).toEqual(['B'])
    // The STORE is probed with 'B's survivor ('A') and 'C' as itself —
    // never 'B' itself.
    expect(probeCalls).toEqual([{ ownerKind: 'track', ownerIds: ['A', 'C'] }])
  })

  it('two asked ids absorbed into the SAME survivor both answer present', async () => {
    vi.spyOn(TrackAliasStore.prototype, 'resolveMany').mockImplementation(
      async () =>
        new Map([
          ['B1', 'A'],
          ['B2', 'A'],
        ]),
    )
    vi.spyOn(MediaStore.prototype, 'ownersWithMedia').mockImplementation(async () => new Set(['A']))
    addon = await boot()

    const answer = await addon.ownersWithMedia({
      deviceId: 101,
      ownerKind: 'track',
      ownerIds: ['B1', 'B2'],
    })

    expect(answer.toSorted()).toEqual(['B1', 'B2'])
  })

  it('a NON-track owner kind never touches the alias store — ownerIds there are event ids', async () => {
    const aliasSpy = vi.spyOn(TrackAliasStore.prototype, 'resolveMany')
    vi.spyOn(MediaStore.prototype, 'ownersWithMedia').mockImplementation(
      async () => new Set(['11']),
    )
    addon = await boot()

    const answer = await addon.ownersWithMedia({
      deviceId: 101,
      ownerKind: 'motion',
      ownerIds: ['11', '12'],
    })

    expect(answer).toEqual(['11'])
    expect(aliasSpy).not.toHaveBeenCalled()
  })

  it('an alias-store failure does not throw — falls back to probing the asked ids as their own (review H2)', async () => {
    vi.spyOn(TrackAliasStore.prototype, 'resolveMany').mockImplementation(async () => {
      throw new Error('settings store unreachable')
    })
    vi.spyOn(MediaStore.prototype, 'ownersWithMedia').mockImplementation(
      async (_ownerKind, ownerIds) => new Set(ownerIds),
    )
    addon = await boot()

    const answer = await addon.ownersWithMedia({
      deviceId: 101,
      ownerKind: 'track',
      ownerIds: ['B', 'C'],
    })

    expect(answer.toSorted()).toEqual(['B', 'C'])
  })
})
