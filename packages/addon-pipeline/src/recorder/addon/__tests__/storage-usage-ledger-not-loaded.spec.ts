/**
 * D674 review C1 — `getStorageUsage` never labels a ledger that has not LOADED
 * as the archive.
 *
 * The recorder registers its providers in `onInitialize`; the ledger loads
 * later, in `onHubReachable`, and a failed load used to last the runner's
 * life. In both windows the mirror holds only the rows written since boot, and
 * the answer said `devicesRead: 'archive'`. The retention floor is read from
 * that answer (pipeline-analytics, D674), so every follow-recordings camera was
 * swept on a floor that was too young. These tests drive a REAL ledger through
 * the same two functions the recorder wires (`archiveDeviceUsageOf`,
 * `archiveUsageComplete`) into the real provider.
 */
import { recordingsLocationOfMode } from '../roots.js'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentStore } from '../../segment-store.js'
import type { SegmentRow } from '../../types.js'
import type { RecordingConfigsState } from '../config-store.js'
import { archiveDeviceUsageOf, archiveUsageComplete } from '../device-storage-usage.js'
import { buildRecordingProvider } from '../recording-provider.js'
import { SegmentHourLedger } from '../segment-hour-ledger.js'

const HOUR_MS = 3_600_000
const HOUR0 = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS
const LOCATION = 'recordings:default'

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
} as unknown as IScopedLogger

function fakeStore(): SettingsStoreClient {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const declared = new Set<string>()
  const ensure = (collection: string): Map<string, Record<string, unknown>> => {
    let m = tables.get(collection)
    if (!m) {
      m = new Map()
      tables.set(collection, m)
    }
    return m
  }
  return {
    declareCollection: {
      mutate: async (input: { collection: string }) => {
        declared.add(input.collection)
        ensure(input.collection)
      },
    },
    set: {
      mutate: async (input: { collection: string; key: string; value: unknown }) => {
        ensure(input.collection).set(input.key, input.value as Record<string, unknown>)
      },
    },
    delete: {
      mutate: async (input: { collection: string; key: string }) => {
        tables.get(input.collection)?.delete(input.key)
      },
    },
    query: {
      query: async (input: { collection: string; filter?: { limit?: number } }) => {
        const rows = [...(tables.get(input.collection)?.entries() ?? [])].map(([id, data]) => ({
          id,
          data,
        }))
        const limit = input.filter?.limit
        return limit === undefined ? rows : rows.slice(0, limit)
      },
    },
  } as unknown as SettingsStoreClient
}

function segment(startMs: number, deviceId = 104): SegmentRow {
  return {
    deviceId,
    profile: 'low',
    startMs,
    durMs: 10_000,
    bytes: 100,
    path: segmentRelPath(deviceId, 'low', startMs, 10_000, 100),
    locationId: LOCATION,
  }
}

/** A store already holding `hours` hours of 104's archive, written by an earlier boot. */
async function archivedStore(hours: number): Promise<SettingsStoreClient> {
  const store = fakeStore()
  const earlier = new SegmentHourLedger({ store, logger: silentLogger })
  await earlier.declare()
  for (let i = 0; i < hours; i++) await earlier.recordSegment(segment(HOUR0 + i * HOUR_MS + 1_000))
  return store
}

function usageOf(ledger: SegmentHourLedger | null, locations = [LOCATION]) {
  return buildRecordingProvider({
    index: new RecordingIndex(),
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'hub',
    logger: silentLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () =>
      locations.map((id) =>
        recordingsLocationOfMode({ id, type: 'recordings', root: '/mnt/rec' }, 'active'),
      ),
    refreshLocations: async () => [],
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    archiveDeviceUsage: (ids) => archiveDeviceUsageOf(ledger, ids),
    archiveUsageComplete: (ids) => archiveUsageComplete(ledger, ids),
  }).getStorageUsage({})
}

describe('getStorageUsage — a ledger that has not loaded is not the archive (D674 C1)', () => {
  it('BEFORE the load: unavailable, even though this boot already wrote a row', async () => {
    const store = await archivedStore(48)
    const ledger = new SegmentHourLedger({ store, logger: silentLogger })
    await ledger.declare()
    // The writer appends to the live hour before `onHubReachable` loads.
    await ledger.recordSegment(segment(HOUR0 + 48 * HOUR_MS + 1_000))
    const usage = await usageOf(ledger)
    expect(usage.devicesRead).toBe('unavailable')
    expect(usage.devices).toEqual([])
    expect(usage.complete).toBe(false)
  })

  it('DURING the load: unavailable between chunks', async () => {
    const store = await archivedStore(12)
    const seen: string[] = []
    const ledger: SegmentHourLedger = new SegmentHourLedger({
      store,
      logger: silentLogger,
      loadPacing: {
        chunkSize: 5,
        yieldBetween: async () => {
          seen.push((await usageOf(ledger)).devicesRead ?? 'absent')
        },
      },
    })
    await ledger.declare()
    await ledger.load()
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set(['unavailable']))
  })

  it("AFTER a failed load: unavailable — and it is retried, never for the runner's life", async () => {
    const store = await archivedStore(3)
    let failNext = true
    const query = store.query.query.bind(store.query)
    const flaky = {
      ...store,
      query: {
        query: (input: Parameters<typeof query>[0]) => {
          if (failNext) {
            failNext = false
            return Promise.reject(new Error('store down'))
          }
          return query(input)
        },
      },
    } as unknown as SettingsStoreClient
    let t = 0
    const ledger = new SegmentHourLedger({ store: flaky, logger: silentLogger, now: () => t })
    await ledger.declare()
    await ledger.load()
    expect((await usageOf(ledger)).devicesRead).toBe('unavailable')
    // A reader a minute later TRIGGERS the retry (fire-and-forget) — nothing
    // else here loads — and the next read is the archive.
    t += 60_000
    await usageOf(ledger)
    await new Promise((r) => setTimeout(r, 0))
    const usage = await usageOf(ledger)
    expect(usage.devicesRead).toBe('archive')
    expect(usage.complete).toBe(true)
    expect(usage.devices[0]?.oldestMs).toBe(HOUR0 + 1_000)
  })

  it('no resolved location: unavailable, never "no camera has footage"', async () => {
    const ledger = new SegmentHourLedger({ store: await archivedStore(2), logger: silentLogger })
    await ledger.declare()
    await ledger.load()
    const usage = await usageOf(ledger, [])
    expect(usage.devicesRead).toBe('unavailable')
    expect(usage.complete).toBe(false)
  })

  it('a load cut at its row cap answers the archive but says it is NOT complete', async () => {
    const ledger = new SegmentHourLedger({
      store: await archivedStore(6),
      logger: silentLogger,
      loadPacing: { rowCap: 4 },
    })
    await ledger.declare()
    await ledger.load()
    const usage = await usageOf(ledger)
    expect(usage.devicesRead).toBe('archive')
    expect(usage.complete).toBe(false)
  })

  it('a whole load is complete', async () => {
    const ledger = new SegmentHourLedger({ store: await archivedStore(6), logger: silentLogger })
    await ledger.declare()
    await ledger.load()
    const usage = await usageOf(ledger)
    expect(usage.devicesRead).toBe('archive')
    expect(usage.complete).toBe(true)
  })
})
