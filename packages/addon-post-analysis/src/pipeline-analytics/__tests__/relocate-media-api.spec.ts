/**
 * `relocateMedia` (Task A2, entity-routing Phase 4) is the operator's mover
 * for event media — the twin of `recording.relocateFootage`: same engine
 * (`MediaRelocateEngine`) the lease-gated coordinator move uses
 * (`startStorageMigrationMove`), runnable in the background WITHOUT a lease.
 *
 * The regression this pins: `startStorageMigrationMove` MUST keep rejecting a
 * `leaseId` that does not match `storageMigrationLeaseId` — that check is the
 * only thing stopping an unrelated caller from racing the paused-migration
 * mover. Adding the no-lease `relocateMedia` twin next to it is the easiest
 * place in this codebase to accidentally loosen that check.
 */
import type { AddonContext, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineAnalyticsAddon from '../index.js'
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

async function boot(
  opts: {
    readonly moverClearance?: (
      locationIds: readonly string[],
    ) => Promise<{ clear: boolean; repointLocationId?: string }>
  } = {},
): Promise<PipelineAnalyticsAddon> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const vectors = makeFakeVectorStore()
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    vectorStore: vectors.client,
    ...(opts.moverClearance !== undefined ? { moverClearance: opts.moverClearance } : {}),
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

describe('relocateMedia — the lease-free operator mover', () => {
  let addon: PipelineAnalyticsAddon | undefined

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = undefined
  })

  it('starts a job with NO lease at all', async () => {
    addon = await boot()
    const result = await addon.relocateMedia({ toLocationId: 'eventMedia:ssd' })
    expect(result.jobId).toEqual(expect.any(String))
    expect(result.jobId.length).toBeGreaterThan(0)
  })

  it('lists the job it just started', async () => {
    addon = await boot()
    const { jobId } = await addon.relocateMedia({ toLocationId: 'eventMedia:ssd' })
    const jobs = await addon.listRelocateMediaJobs()
    expect(jobs.some((j) => j.jobId === jobId)).toBe(true)
  })

  it('cancelling an unknown job reports false, not an error', async () => {
    addon = await boot()
    const { cancelled } = await addon.cancelRelocateMedia({ jobId: 'never-existed' })
    expect(cancelled).toBe(false)
  })

  // ── The regression this file exists to pin ─────────────────────────────

  it('REGRESSION GUARD: startStorageMigrationMove still rejects a leaseId that does not match', async () => {
    addon = await boot()
    // No pause was requested — storageMigrationLeaseId is null — so ANY
    // leaseId must be refused. relocateMedia (above) must never have made
    // this check optional.
    await expect(
      addon.startStorageMigrationMove({ toLocationId: 'eventMedia:ssd', leaseId: 'not-the-lease' }),
    ).rejects.toThrow('event-media storage migration lease does not match')
  })

  it('REGRESSION GUARD: startStorageMigrationMove still rejects a WRONG leaseId even while a real one is held', async () => {
    addon = await boot()
    await addon.pauseForStorageMigration({ leaseId: 'the-real-lease' })
    await expect(
      addon.startStorageMigrationMove({ toLocationId: 'eventMedia:ssd', leaseId: 'an-impostor' }),
    ).rejects.toThrow('event-media storage migration lease does not match')
    // Cleanup: release the pause this test took, exactly the matching lease.
    await addon.resumeForStorageMigration({ leaseId: 'the-real-lease' })
  })

  it('startStorageMigrationMove still SUCCEEDS with the lease that matches — the pair is not broken, only the mismatch is refused', async () => {
    addon = await boot()
    await addon.pauseForStorageMigration({ leaseId: 'the-real-lease' })
    const result = await addon.startStorageMigrationMove({
      toLocationId: 'eventMedia:ssd',
      leaseId: 'the-real-lease',
    })
    expect(result.jobId).toEqual(expect.any(String))
    await addon.resumeForStorageMigration({ leaseId: 'the-real-lease' })
  })

  it('is REFUSED, and its job cancelled, while a re-point holds an overlapping root', async () => {
    const asked: Array<readonly string[]> = []
    addon = await boot({
      moverClearance: async (locationIds) => {
        asked.push(locationIds)
        return { clear: false, repointLocationId: 'homekitClips:default' }
      },
    })
    await expect(addon.relocateMedia({ toLocationId: 'eventMedia:ssd' })).rejects.toThrow(
      /re-point of "homekitClips:default"/,
    )
    // The mover names what it touches: every eventMedia source (`*`) and the target.
    expect(asked[0]).toEqual(['*', 'eventMedia:ssd'])
    const jobs = await addon.listRelocateMediaJobs()
    expect(jobs.filter((job) => job.state === 'running' || job.state === 'queued')).toEqual([])
  })

  it('a repoint that begins AFTER the first answer still cancels the job it just started', async () => {
    let calls = 0
    addon = await boot({
      moverClearance: async () => {
        calls += 1
        return calls === 1
          ? { clear: true }
          : { clear: false, repointLocationId: 'homekitClips:default' }
      },
    })
    await expect(addon.relocateMedia({ toLocationId: 'eventMedia:ssd' })).rejects.toThrow(
      /mover refused/,
    )
    const jobs = await addon.listRelocateMediaJobs()
    expect(jobs.filter((job) => job.state === 'running' || job.state === 'queued')).toEqual([])
  })

  it('refuses when the orchestrator cannot be asked (fail closed)', async () => {
    addon = await boot({
      moverClearance: async () => {
        throw new Error('orchestrator offline')
      },
    })
    await expect(addon.relocateMedia({ toLocationId: 'eventMedia:ssd' })).rejects.toThrow(
      /could not be asked/,
    )
  })
})
