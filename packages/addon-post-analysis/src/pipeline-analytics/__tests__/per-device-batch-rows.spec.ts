/**
 * The OWNER half of the batched per-camera reads.
 *
 * The hook spec (`per-camera-feeds-are-one-query.spec.tsx`) mocks the tRPC
 * client, so it can prove the UI issues one request instead of N — and it
 * cannot reach these providers at all. Disarming the provider branches left
 * that spec entirely green, which is exactly the kind of test this repo has
 * been burned by twice. This file arms the other half.
 *
 * One rule, stated twice: **a batch answers for every id it was asked about,
 * and a camera it could not read is MARKED, never answered with emptiness.**
 * Fanned out per camera that distinction was free — one query rejected while
 * the others resolved — and collapsing to a batch is the moment it can be lost
 * silently.
 */
import type { DeviceProxy, IScopedLogger, SceneCondition, StationaryObject } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeAnalyticsRecords } from './fake-records.js'
import { SceneMonitorProvider } from '../scene/scene-monitor-provider.js'
import { SceneStore } from '../scene/scene-store.js'
import { ZoneAnalyticsProvider } from '../zone-analytics-provider.js'

interface Warning {
  readonly message: string
  readonly deviceId: unknown
}

function makeLogger(warnings: Warning[]): IScopedLogger {
  const log: IScopedLogger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    error: (): void => undefined,
    warn: (message: string, extras?: { readonly tags?: Record<string, unknown> }): void => {
      warnings.push({ message, deviceId: extras?.tags?.['deviceId'] })
    },
    child: (): IScopedLogger => log,
    withTags: (): IScopedLogger => log,
  }
  return log
}

// ── zone-analytics ──────────────────────────────────────────────────────────

const NO_DEVICE_PROXY = async (): Promise<DeviceProxy> => {
  throw new Error('no device proxy in this fixture')
}

const PARKED: StationaryObject = {
  id: 'park-1',
  className: 'car',
  firstSeenAt: 900,
  becameStationaryAt: 1_000,
  lastConfirmedAt: 1_000,
  frameWidth: 1920,
  frameHeight: 1080,
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
}

describe('zoneAnalytics.getCurrentSnapshotBatch — every id gets a row', () => {
  it('separates "no reading yet" from "could not be read"', async () => {
    const warnings: Warning[] = []
    // 101 has a parked object; 616 has none; 102's parked-object registry
    // refuses — the read `hydrateFromRegistry` cannot degrade around. (A zone
    // resolve that fails is DIFFERENT and stays a `read`: the parked entries
    // are still known, they just carry no per-zone breakdown.)
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(warnings),
      fetchDevice: NO_DEVICE_PROXY,
      listStationaryObjects: (deviceId): readonly StationaryObject[] => {
        if (deviceId === 102) throw new Error('parked-object registry unavailable')
        return deviceId === 101 ? [PARKED] : []
      },
      resolveZones: async () => [],
    })

    const rows = await provider.getCurrentSnapshotBatch({ deviceIds: [101, 616, 102] })

    // Never fewer rows than ids — a caller that asked for three and got two
    // cannot tell which one is missing, or that any is.
    expect(rows.map((r) => r.deviceId)).toEqual([101, 616, 102])

    const byId = new Map(rows.map((r) => [r.deviceId, r]))
    // Read, with a reading.
    expect(byId.get(101)?.read).toBe('read')
    expect(byId.get(101)?.snapshot?.stationaryObjects?.length).toBe(1)
    // Read, and there is genuinely nothing parked.
    expect(byId.get(616)?.read).toBe('read')
    expect(byId.get(616)?.snapshot).toBeNull()
    // NOT read. This row must never be mistaken for 616's.
    expect(byId.get(102)?.read).toBe('unreadable')
    expect(byId.get(102)?.snapshot).toBeNull()
  })

  it('says so, per camera, when it cannot read one', async () => {
    // A branch that drops work silently reads as "it never happened", and every
    // question asked of this is per-camera.
    const warnings: Warning[] = []
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(warnings),
      fetchDevice: NO_DEVICE_PROXY,
      listStationaryObjects: (): readonly StationaryObject[] => {
        throw new Error('parked-object registry unavailable')
      },
      resolveZones: async () => [],
    })

    await provider.getCurrentSnapshotBatch({ deviceIds: [101, 616] })

    expect(warnings.map((w) => w.deviceId)).toEqual([101, 616])
  })
})

// ── scene-monitor ───────────────────────────────────────────────────────────

async function makeSceneProvider(
  warnings: Warning[],
): Promise<{ provider: SceneMonitorProvider; store: SceneStore }> {
  const world = await makeAnalyticsRecords()
  const store = new SceneStore({
    records: world.records,
    logger: makeLogger(warnings),
  })
  await store.load()
  const provider = new SceneMonitorProvider({
    store,
    encoder: {
      encode: async () => ({ embedding: [1, 0, 0], inferenceMs: 1 }),
      getInfo: async () => ({ modelId: 'clip-vit-b32', embeddingDim: 3, ready: true }),
    },
    getSnapshot: async () => null,
    mirrorSlice: (): void => undefined,
    emitStateChanged: (): void => undefined,
    currentCondition: async (): Promise<SceneCondition> => 'day',
    logger: makeLogger(warnings),
    now: () => 1_000,
  })
  return { provider, store }
}

describe('sceneMonitor.listScenesBatch — every id gets a row', () => {
  it('gives a camera with no scenes an EMPTY list, not a missing row', async () => {
    const warnings: Warning[] = []
    const { provider } = await makeSceneProvider(warnings)
    await provider.createScene({
      deviceId: 101,
      label: 'front door',
      roi: { kind: 'rect', x: 0, y: 0, width: 1, height: 1 },
      check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 1 },
    })

    const rows = await provider.listScenesBatch({ deviceIds: [101, 616] })

    expect(rows.map((r) => r.deviceId)).toEqual([101, 616])
    expect(rows[0]?.status?.monitors.length).toBe(1)
    // 616 ANSWERED, and the answer is "none configured". That is a real claim
    // about a camera that was read, and it must not be `null`.
    expect(rows[1]?.status).not.toBeNull()
    expect(rows[1]?.status?.monitors).toEqual([])
  })

  it('marks a camera it could not read as UNKNOWN, and names it', async () => {
    const warnings: Warning[] = []
    const { provider, store } = await makeSceneProvider(warnings)
    // The durable read behind `statusFor`. Replacing it is the only way to make
    // the read fail the way an absent provider makes it fail in production.
    store.listScenes = (): never => {
      throw new Error('scene store unavailable')
    }
    warnings.length = 0

    const rows = await provider.listScenesBatch({ deviceIds: [101, 616] })

    // Both rows present, both null — "we could not look", which is NOT the same
    // fact as "nothing is configured" and must never render as it.
    expect(rows.map((r) => r.deviceId)).toEqual([101, 616])
    expect(rows.every((r) => r.status === null)).toBe(true)
    expect(warnings.map((w) => w.deviceId)).toEqual([101, 616])
  })
})

// ── pipeline-analytics: timeline heatmap density ────────────────────────────

import { EVENT_DENSITY_BATCH_MAX } from '@camstack/types'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import type { EventDensityBucket, EventStore } from '../store/event-store.js'

const BUCKET: EventDensityBucket = { bucketStart: 0, motion: 3, object: 1, audio: 0 }

/**
 * An event store that answers `densityByKind` for some cameras and REFUSES for
 * others — the shape of a real failure here (a store read that rejects).
 *
 * The bucket STARTS are derived from the query (`since + i * bucketMs`), the
 * way a real histogram derives them. Without that the fake answers the same
 * thing for every window, and the "same as the singular method" test below
 * passes even when the batch asks a DIFFERENT question — which is exactly how
 * a fake makes a suite green for the wrong reason.
 *
 * Documented type boundary: the density path touches exactly one method of
 * `EventStore`, and a fake carrying more would be a fake able to answer
 * something production never asked it.
 */
function densityStore(
  rows: ReadonlyMap<number, readonly EventDensityBucket[]>,
  refuse: ReadonlySet<number>,
): EventStore {
  const store = {
    densityByKind: async (q: {
      deviceId: number
      since: number
      bucketMs: number
    }): Promise<readonly EventDensityBucket[]> => {
      if (refuse.has(q.deviceId)) throw new Error(`event store unavailable for ${q.deviceId}`)
      return (rows.get(q.deviceId) ?? []).map((b, i) => ({
        ...b,
        bucketStart: q.since + i * q.bucketMs,
      }))
    },
  }
  return store as unknown as EventStore
}

function densityFacade(store: EventStore, warnings: Warning[]): AnalyticsQueryFacade {
  const logger = makeLogger(warnings)
  return new AnalyticsQueryFacade({
    trackStore: () => null,
    eventStore: () => store,
    mediaStore: () => null,
    sensorEventStore: () => null,
    opsLog: () => null,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/pa/event-media',
    logger: () => logger,
  })
}

const WINDOW = { since: 0, until: 86_400_000, bucketMs: 3_600_000 }

describe('pipelineAnalytics.getEventDensityBatch — every id gets a row', () => {
  it('separates "read, no events" from "could not be read"', async () => {
    const warnings: Warning[] = []
    const facade = densityFacade(densityStore(new Map([[101, [BUCKET]]]), new Set([102])), warnings)

    const rows = await facade.getEventDensityBatch({ deviceIds: [101, 616, 102], ...WINDOW })

    expect(rows.map((r) => r.deviceId)).toEqual([101, 616, 102])
    const byId = new Map(rows.map((r) => [r.deviceId, r]))
    expect(byId.get(101)?.read).toBe('read')
    expect(byId.get(101)?.buckets).toEqual([BUCKET])
    // 616 ANSWERED: read, and nothing happened in the window. The timeline
    // draws an empty bar and that is correct.
    expect(byId.get(616)?.read).toBe('read')
    expect(byId.get(616)?.buckets).toEqual([])
    // 102 was NOT read. Identical emptiness, entirely different fact — the
    // timeline must draw unknown, not quiet.
    expect(byId.get(102)?.read).toBe('unreadable')
    expect(byId.get(102)?.buckets).toEqual([])
  })

  it('says so, per camera, when it cannot read one', async () => {
    const warnings: Warning[] = []
    const facade = densityFacade(densityStore(new Map(), new Set([101, 616])), warnings)

    await facade.getEventDensityBatch({ deviceIds: [101, 616], ...WINDOW })

    expect(warnings.map((w) => w.deviceId)).toEqual([101, 616])
  })

  it('answers each camera exactly what the SINGULAR method answers', async () => {
    const warnings: Warning[] = []
    const facade = densityFacade(
      densityStore(
        // TWO buckets per camera: with one, `since + 0 * bucketMs` is the same
        // number whatever `bucketMs` is, and the comparison below could not see
        // a batch that passed a different window.
        new Map([
          [101, [BUCKET, { bucketStart: 0, motion: 1, object: 1, audio: 1 }]],
          [
            616,
            [
              { bucketStart: 0, motion: 0, object: 9, audio: 2 },
              { bucketStart: 0, motion: 4, object: 0, audio: 0 },
            ],
          ],
        ]),
        new Set(),
      ),
      warnings,
    )

    const rows = await facade.getEventDensityBatch({ deviceIds: [101, 616], ...WINDOW })

    for (const row of rows) {
      const single = await facade.getEventDensity({ deviceId: row.deviceId, ...WINDOW })
      expect(row.buckets).toEqual(single)
    }
  })

  it('REFUSES an over-cap ask instead of truncating it', async () => {
    const warnings: Warning[] = []
    const facade = densityFacade(densityStore(new Map(), new Set()), warnings)
    const deviceIds = Array.from({ length: EVENT_DENSITY_BATCH_MAX + 1 }, (_, i) => 600 + i)

    await expect(facade.getEventDensityBatch({ deviceIds, ...WINDOW })).rejects.toThrow(
      String(EVENT_DENSITY_BATCH_MAX),
    )
  })
})
