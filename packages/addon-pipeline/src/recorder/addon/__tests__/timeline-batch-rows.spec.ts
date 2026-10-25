/**
 * The OWNER half of the batched recorder timeline reads.
 *
 * `getAvailabilityBatch` / `getDaysWithRecordingsBatch` exist so a multi-camera
 * timeline pays ONE round trip per day change instead of one per camera. The
 * per-camera work is unchanged — the same calendar walk, the same index
 * fallback — so the only things worth pinning are the two a batch destroys:
 *
 *  1. every requested id gets a row, including the ones that failed;
 *  2. a camera the recorder could NOT read is marked `'unreadable'`, never
 *     answered with `ranges: []` / `days: []`, which is the claim "read, and
 *     there is no footage".
 *
 * Plus the third thing a batch invites: a ceiling that quietly truncates. It
 * refuses instead.
 */
import { recordingsLocationOfMode } from '../roots.js'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { RECORDING_TIMELINE_BATCH_MAX } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentStore } from '../../segment-store.js'
import type { Range, SegmentRow } from '../../types.js'
import type { RecordingConfigsState } from '../config-store.js'
import {
  buildRecordingProvider,
  type CalendarIndexLike,
  type RecordingProviderDeps,
} from '../recording-provider.js'
import { buildRecordingSourceProvider } from '../recording-source-provider.js'

interface Warning {
  readonly message: string
  readonly deviceId: unknown
}

function makeLogger(warnings: Warning[]): IScopedLogger {
  const log: IScopedLogger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    error: (): void => undefined,
    warn: (message: string, extras?: LogExtras): void => {
      warnings.push({ message, deviceId: extras?.tags?.['deviceId'] })
    },
    child: (): IScopedLogger => log,
    withTags: (): IScopedLogger => log,
  }
  return log
}

const DAY_15 = Date.UTC(2026, 5, 15, 8, 0, 0)
const DAY_16 = Date.UTC(2026, 5, 16, 1, 0, 0)
const MONTH_FROM = Date.UTC(2026, 5, 1, 0, 0, 0)
const MONTH_TO = Date.UTC(2026, 5, 30, 0, 0, 0)

function seg(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    deviceId: 101,
    profile: 'mid',
    startMs: DAY_15,
    durMs: 4_000,
    bytes: 2_048,
    path: '101/mid/2026/06/15/08/seg.m4s',
    locationId: 'loc-a',
    ...over,
  }
}

/**
 * A calendar that answers for some cameras and REFUSES for others — the shape
 * of a real failure here (an unmounted location, a rung read that throws).
 * `refuse` is the set of cameras nobody can read.
 */
function calendarOver(
  rows: ReadonlyMap<number, readonly Range[]>,
  refuse: ReadonlySet<number>,
): CalendarIndexLike {
  const guard = (deviceId: number): void => {
    if (refuse.has(deviceId)) throw new Error(`calendar rung unavailable for ${deviceId}`)
  }
  return {
    localDays: async (deviceId, _fromMs, _toMs, _tz): Promise<number[]> => {
      guard(deviceId)
      return (rows.get(deviceId) ?? []).map((r) => r.startMs)
    },
    dayRanges: async (deviceId): Promise<Range[]> => {
      guard(deviceId)
      return [...(rows.get(deviceId) ?? [])]
    },
    rangesIn: async (deviceId): Promise<Range[]> => {
      guard(deviceId)
      return [...(rows.get(deviceId) ?? [])]
    },
    availabilityProfileFor: async (deviceId): Promise<string | null> => {
      guard(deviceId)
      return rows.has(deviceId) ? 'mid' : null
    },
    servedProfileFor: async (deviceId, requested): Promise<string | null> => {
      guard(deviceId)
      if (!rows.has(deviceId)) return null
      return requested !== undefined && requested !== '' ? requested : 'mid'
    },
    profilesWithFootageFor: async (deviceId): Promise<readonly string[]> => {
      guard(deviceId)
      return rows.has(deviceId) ? ['mid'] : []
    },
  }
}

interface Harness {
  readonly deps: RecordingProviderDeps
  readonly warnings: Warning[]
}

function harness(
  opts: { segments?: readonly SegmentRow[]; calendar?: CalendarIndexLike } = {},
): Harness {
  const index = new RecordingIndex()
  for (const s of opts.segments ?? []) index.addSegment(s)
  const warnings: Warning[] = []
  const locations = [
    recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root: '/recordings/a' }, 'active'),
  ]
  const deps: RecordingProviderDeps = {
    index,
    // Documented type boundary: these specs drive the read methods only, and
    // the read methods never touch the segment store or the config store. A
    // fake with methods would be a fake that could answer something production
    // never asked it.
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: makeLogger(warnings),
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => locations,
    refreshLocations: async () => locations,
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    ...(opts.calendar ? { calendar: opts.calendar } : {}),
  }
  return { deps, warnings }
}

// ── getAvailabilityBatch ─────────────────────────────────────────────────────

describe('recording.getAvailabilityBatch — every id gets a row', () => {
  it('separates "no footage in the window" from "could not be read"', async () => {
    const calendar = calendarOver(
      new Map([[101, [{ startMs: DAY_15, endMs: DAY_15 + 4_000 }]]]),
      new Set([102]),
    )
    const { deps } = harness({ calendar })
    const provider = buildRecordingProvider(deps)

    const rows = await provider.getAvailabilityBatch({
      deviceIds: [101, 616, 102],
      fromMs: MONTH_FROM,
      toMs: MONTH_TO,
    })

    // Never fewer rows than ids, and in the order asked.
    expect(rows.map((r) => r.deviceId)).toEqual([101, 616, 102])
    const byId = new Map(rows.map((r) => [r.deviceId, r]))
    expect(byId.get(101)?.read).toBe('read')
    expect(byId.get(101)?.ranges).toEqual([
      { profile: 'mid', startMs: DAY_15, endMs: DAY_15 + 4_000 },
    ])
    // 616 ANSWERED: it genuinely has no footage in this window.
    expect(byId.get(616)?.read).toBe('read')
    expect(byId.get(616)?.ranges).toEqual([])
    // 102 was NOT read. Same empty `ranges`, entirely different fact.
    expect(byId.get(102)?.read).toBe('unreadable')
    expect(byId.get(102)?.ranges).toEqual([])
  })

  it('says so, per camera, when it cannot read one', async () => {
    const calendar = calendarOver(new Map(), new Set([101, 616]))
    const { deps, warnings } = harness({ calendar })
    const provider = buildRecordingProvider(deps)

    await provider.getAvailabilityBatch({ deviceIds: [101, 616], fromMs: 0, toMs: MONTH_TO })

    // A branch that drops work silently reads as "it never happened", and every
    // question asked of this is per-camera.
    expect(warnings.map((w) => w.deviceId)).toEqual([101, 616])
  })

  it('answers each camera exactly what the SINGULAR method answers', async () => {
    const { deps } = harness({
      segments: [seg({ deviceId: 101 }), seg({ deviceId: 616, startMs: DAY_16 })],
    })
    const provider = buildRecordingProvider(deps)
    // The SINGULAR read moved to the `recording` collection (D625); the batch
    // stayed on the archive. They must still answer the same thing, which is
    // exactly why both call `readRecordingCoverage`.
    const source = buildRecordingSourceProvider(deps)
    const window = { fromMs: MONTH_FROM, toMs: MONTH_TO }

    const rows = await provider.getAvailabilityBatch({ deviceIds: [101, 616], ...window })

    for (const row of rows) {
      const single = await source.getAvailability({
        deviceId: row.deviceId,
        provider: 'recorder',
        ...window,
      })
      // Every field, not a chosen pair: this case exists to catch a row that
      // quietly answers LESS than the singular method, and `profilesWithFootage`
      // was exactly such a field on the day it was added (D433).
      expect({
        deviceId: row.deviceId,
        read: row.read,
        ranges: row.ranges,
        profilesWithFootage: row.profilesWithFootage,
      }).toEqual(single)
    }
  })

  /**
   * 2026-09-10: the operator asked for a timelapse off the LOW stream and
   * `getAvailability` answered twenty `high` ranges, because it picks ONE
   * profile for the timeline's single bar. `profilesWithFootage` says what
   * exists; this says a caller can ASK for one of them (D433).
   */
  it('describes the profile ASKED for, not only the preferred one', async () => {
    // BOTH profiles recorded — the real shape on this hub, where `high` and
    // `low` live on different storage locations.
    const { deps } = harness({
      segments: [
        seg({ deviceId: 101 }),
        seg({ deviceId: 101, profile: 'low', path: '101/low/2026/06/15/08/seg.m4s' }),
      ],
    })
    const provider = buildRecordingSourceProvider(deps)
    const window = { fromMs: MONTH_FROM, toMs: MONTH_TO, provider: 'recorder' }

    const preferred = await provider.getAvailability({ deviceId: 101, ...window })
    expect(
      [...new Set(preferred.profilesWithFootage)].sort(),
      'the answer did not name the profiles it chose FROM',
    ).toEqual(['low', 'mid'])

    const asked = await provider.getAvailability({ deviceId: 101, ...window, profile: 'low' })
    expect(
      asked.ranges.map((r) => r.profile),
      'the answer ignored the profile the caller asked for',
    ).toEqual(['low'])
  })

  it('REFUSES an over-cap ask instead of truncating it', async () => {
    const { deps } = harness()
    const provider = buildRecordingProvider(deps)
    const deviceIds = Array.from({ length: RECORDING_TIMELINE_BATCH_MAX + 1 }, (_, i) => 600 + i)

    await expect(
      provider.getAvailabilityBatch({ deviceIds, fromMs: 0, toMs: MONTH_TO }),
    ).rejects.toThrow(String(RECORDING_TIMELINE_BATCH_MAX))
  })
})

// ── getDaysWithRecordingsBatch ───────────────────────────────────────────────

describe('recording.getDaysWithRecordingsBatch — every id gets a row', () => {
  it('separates "no days" from "could not be read"', async () => {
    const calendar = calendarOver(
      new Map([[101, [{ startMs: DAY_15, endMs: DAY_15 + 4_000 }]]]),
      new Set([102]),
    )
    const { deps } = harness({ calendar })
    const provider = buildRecordingProvider(deps)

    const rows = await provider.getDaysWithRecordingsBatch({
      deviceIds: [101, 616, 102],
      fromMs: MONTH_FROM,
      toMs: MONTH_TO,
      tzOffsetMinutes: 0,
    })

    expect(rows.map((r) => r.deviceId)).toEqual([101, 616, 102])
    const byId = new Map(rows.map((r) => [r.deviceId, r]))
    expect(byId.get(101)?.read).toBe('read')
    expect(byId.get(101)?.days).toEqual([DAY_15])
    expect(byId.get(616)?.read).toBe('read')
    expect(byId.get(616)?.days).toEqual([])
    expect(byId.get(102)?.read).toBe('unreadable')
    expect(byId.get(102)?.days).toEqual([])
  })

  it('answers each camera exactly what the SINGULAR method answers', async () => {
    const { deps } = harness({
      segments: [seg({ deviceId: 101 }), seg({ deviceId: 616, startMs: DAY_16 })],
    })
    const provider = buildRecordingProvider(deps)
    const source = buildRecordingSourceProvider(deps)
    const window = { fromMs: MONTH_FROM, toMs: MONTH_TO, tzOffsetMinutes: 0 }

    const rows = await provider.getDaysWithRecordingsBatch({ deviceIds: [101, 616], ...window })

    for (const row of rows) {
      const single = await source.getDaysWithRecordings({
        deviceId: row.deviceId,
        provider: 'recorder',
        ...window,
      })
      expect({ deviceId: row.deviceId, read: row.read, days: row.days }).toEqual(single)
    }
  })

  it('REFUSES an over-cap ask instead of truncating it', async () => {
    const { deps } = harness()
    const provider = buildRecordingProvider(deps)
    const deviceIds = Array.from({ length: RECORDING_TIMELINE_BATCH_MAX + 1 }, (_, i) => 600 + i)

    await expect(
      provider.getDaysWithRecordingsBatch({
        deviceIds,
        fromMs: 0,
        toMs: MONTH_TO,
        tzOffsetMinutes: 0,
      }),
    ).rejects.toThrow(String(RECORDING_TIMELINE_BATCH_MAX))
  })
})
