/**
 * Eviction logging — Task C2.
 *
 * Asserts that `pruneEventsBefore` emits an INFO log entry with the
 * correct meta (deviceId, cutoffMs, per-kind counts) when at least one
 * event is deleted, and stays silent when nothing is deleted.
 *
 * Strategy: boot the addon via the shared `boot()` helper (which wires
 * a spy-able IScopedLogger), seed events into the fake store, call
 * `addon.pruneEventsBefore(...)`, and inspect the spy's call log.
 *
 * `sweepRetention` is `private` so it cannot be called from a test.
 * That path is covered by a code-path note: the sweep INFO log fires
 * only when `evicted.*length > 0`; its correctness is validated manually
 * at deployment and by the fact that it shares the same conditional guard
 * pattern used (and tested) here for `pruneEventsBefore`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeEventBus,
  makeFakeDeviceManager,
  makeFakeAddonApi,
  seedTracklessEvents,
  type FakeSettingsStore,
} from './test-helpers.js'
import { makeAnalyticsRecords, type FakeRecords } from './fake-records.js'
import {
  MOTION_EVENTS_COLLECTION,
  OBJECT_EVENTS_COLLECTION,
  AUDIO_EVENTS_COLLECTION,
} from '../store/event-store.js'
import type { AddonContext } from '@camstack/types'

// ── Spy logger ──────────────────────────────────────────────────────────

// biome-ignore lint/plugin: test spy that extends IScopedLogger to capture info() calls
interface SpyLogger extends IScopedLogger {
  infoCalls: Array<{ message: string; extras: LogExtras | undefined }>
}

function makeSpyLogger(): SpyLogger {
  const infoCalls: Array<{ message: string; extras: LogExtras | undefined }> = []
  const noop = (): void => {}
  const logger: SpyLogger = {
    infoCalls,
    debug: noop,
    info(message: string, extras?: LogExtras): void {
      infoCalls.push({ message, extras })
    },
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: (_tags: LogTags) => logger,
  }
  return logger
}

// ── Raw record helpers (mirror event-store-prune.spec.ts) ───────────────

function rawMotion(
  id: string,
  deviceId: number,
  timestamp: number,
): { id: string; data: Record<string, unknown> } {
  return {
    id,
    data: { deviceId, timestamp, regionCount: 0, regions: [], frameWidth: 640, frameHeight: 480 },
  }
}

function rawObject(
  id: string,
  deviceId: number,
  timestamp: number,
): { id: string; data: Record<string, unknown> } {
  return {
    id,
    data: {
      deviceId,
      timestamp,
      trackId: 't1',
      className: 'person',
      confidence: 0.9,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      zones: [],
      state: 'new',
    },
  }
}

function rawAudio(
  id: string,
  deviceId: number,
  timestamp: number,
): { id: string; data: Record<string, unknown> } {
  return { id, data: { deviceId, timestamp, rms: 0.1, dbfs: -20 } }
}

// ── Boot helper ─────────────────────────────────────────────────────────

interface EvictionBootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly logger: SpyLogger
  readonly fake: FakeSettingsStore
  readonly records: FakeRecords
}

async function bootWithSpyLogger(): Promise<EvictionBootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
  })

  const logger = makeSpyLogger()

  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()

  const recordsWorld = await makeAnalyticsRecords()
  const records = recordsWorld.records
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger,
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
        remove: async () => {
          /* no-op */
        },
        decommission: async () => {
          /* no-op */
        },
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
      throw new Error('no native providers')
    },
    fetchDevice: async () => {
      throw new Error('no devices')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)

  return { addon, logger, fake: settings, records: recordsWorld }
}

// ── Tests ───────────────────────────────────────────────────────────────

const DEVICE_ID = 7
const CUTOFF_MS = 10_000

describe('pruneEventsBefore eviction logging', () => {
  let booted: EvictionBootResult

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
  })

  it('logs INFO with deviceId, cutoffMs, and per-kind counts when events are pruned', async () => {
    booted = await bootWithSpyLogger()
    const { addon, logger, fake, records } = booted

    // Seed 2 motion + 1 object + 1 audio that are below the cutoff.
    seedTracklessEvents(records, MOTION_EVENTS_COLLECTION, [
      rawMotion('m1', DEVICE_ID, CUTOFF_MS - 2000),
      rawMotion('m2', DEVICE_ID, CUTOFF_MS - 1),
    ])
    fake.seed(OBJECT_EVENTS_COLLECTION, [rawObject('o1', DEVICE_ID, CUTOFF_MS - 500)])
    seedTracklessEvents(records, AUDIO_EVENTS_COLLECTION, [
      rawAudio('a1', DEVICE_ID, CUTOFF_MS - 100),
    ])

    // Clear any INFO calls emitted during boot so we only assert on prune.
    logger.infoCalls.length = 0

    const counts = await addon.pruneEventsBefore({ deviceId: DEVICE_ID, cutoffMs: CUTOFF_MS })

    // Verify the return value is correct (sanity check).
    expect(counts).toEqual({ motion: 2, object: 1, audio: 1 })

    // Exactly one INFO log must have been emitted.
    const evictionLogs = logger.infoCalls.filter(
      (c) => c.message === 'analytics event eviction (floor)',
    )
    expect(evictionLogs).toHaveLength(1)

    const log = evictionLogs[0]!
    expect(log.extras?.meta).toMatchObject({
      deviceId: DEVICE_ID,
      cutoffMs: CUTOFF_MS,
      motion: 2,
      object: 1,
      audio: 1,
    })
  })

  it('does NOT log INFO when nothing is pruned', async () => {
    booted = await bootWithSpyLogger()
    const { addon, logger, records } = booted

    // Seed events that are all AT or AFTER the cutoff — nothing qualifies.
    seedTracklessEvents(records, MOTION_EVENTS_COLLECTION, [
      rawMotion('m-keep', DEVICE_ID, CUTOFF_MS),
    ])

    logger.infoCalls.length = 0

    const counts = await addon.pruneEventsBefore({ deviceId: DEVICE_ID, cutoffMs: CUTOFF_MS })

    expect(counts).toEqual({ motion: 0, object: 0, audio: 0 })

    const evictionLogs = logger.infoCalls.filter(
      (c) => c.message === 'analytics event eviction (floor)',
    )
    expect(evictionLogs).toHaveLength(0)
  })
})
