/**
 * The dead-device eviction tier, and the gate that decides whether it may run.
 *
 * Two properties here are load-bearing and the SECOND is the one that matters:
 *
 *   1. Footage of a camera the registry no longer knows is evicted before a
 *      LIVE camera's older footage. That is the operator's decision.
 *   2. A registry read that fails, comes back empty, or contradicts itself
 *      evicts EXACTLY as this provider did before the tier existed, and
 *      orphans nothing. That is D49/D72: a fallible read may never be the
 *      thing that deletes a live camera's footage.
 *
 * The fake archive answers the device-scoped read the tier needs, so a
 * regression to "sort the oldest page and hope the orphan is in it" fails
 * here — every orphan row in these fixtures is NEWER than the live camera's.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type DeviceRegistryRead, ORPHAN_CONFIRMATIONS_REQUIRED } from '../orphan-device-lane.js'
import { RecordingIndex } from '../recording-index.js'
import { segmentRelPath } from '../segment-path.js'
import { SegmentStore } from '../segment-store.js'
import {
  type EvictableArchive,
  type EvictionDeviceSummary,
  StorageEvictableProvider,
} from '../storage-evictable-provider.js'
import type { Accounting, OldestSegments, SegmentRow } from '../types.js'

const LOCATION = 'recordings:default'
/** A live camera. Its footage is the OLDEST on the disk in every fixture. */
const LIVE = 101
/** A camera the operator deleted. Its footage is the NEWEST on the disk. */
const GONE = 104

function capturingLogger(sink: { warn: string[]; info: string[] }): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: (m: string) => sink.info.push(m),
    warn: (m: string) => sink.warn.push(m),
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function row(deviceId: number, startMs: number, bytes = 100): SegmentRow {
  return {
    deviceId,
    profile: 'high',
    startMs,
    durMs: 2_000,
    bytes,
    path: segmentRelPath(deviceId, 'high', startMs, 2_000, bytes),
    locationId: LOCATION,
  }
}

/** An archive that answers both bounded reads over a fixed row set, and
 *  records WHICH question it was asked — the device-scoped read is the tier
 *  running, so "was it asked at all" is directly observable. */
class FakeArchive implements EvictableArchive {
  constructor(
    private readonly rows: readonly SegmentRow[],
    private readonly asks: string[],
  ) {}

  async accountingForLocations(locationIds: ReadonlySet<string>): Promise<Accounting> {
    const on = this.rows.filter((r) => locationIds.has(r.locationId))
    if (on.length === 0) return { bytes: 0, count: 0, oldestMs: null, newestMs: null }
    return {
      bytes: on.reduce((a, r) => a + r.bytes, 0),
      count: on.length,
      oldestMs: Math.min(...on.map((r) => r.startMs)),
      newestMs: Math.max(...on.map((r) => r.startMs)),
    }
  }

  async oldestSegments(
    locationIds: ReadonlySet<string>,
    targetBytes: number,
  ): Promise<OldestSegments> {
    this.asks.push('oldestSegments')
    return this.bounded(
      this.rows.filter((r) => locationIds.has(r.locationId)),
      targetBytes,
    )
  }

  async oldestSegmentsForDevices(
    locationIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<number>,
    targetBytes: number,
  ): Promise<OldestSegments> {
    this.asks.push('oldestSegmentsForDevices')
    if (deviceIds.size === 0) return { rows: [], exhausted: true }
    return this.bounded(
      this.rows.filter((r) => locationIds.has(r.locationId) && deviceIds.has(r.deviceId)),
      targetBytes,
    )
  }

  devicesWithFootage(locationIds: ReadonlySet<string>): ReadonlySet<number> {
    const out = new Set<number>()
    for (const r of this.rows) if (locationIds.has(r.locationId)) out.add(r.deviceId)
    return out
  }

  /** Oldest-first, and never more rows than the target needs. */
  private bounded(candidates: readonly SegmentRow[], targetBytes: number): OldestSegments {
    if (targetBytes <= 0) return { rows: [], exhausted: true }
    const out: SegmentRow[] = []
    let covered = 0
    for (const r of candidates.toSorted((a, b) => a.startMs - b.startMs)) {
      if (covered >= targetBytes) break
      out.push(r)
      covered += r.bytes
    }
    return { rows: out, exhausted: covered < targetBytes }
  }
}

interface Harness {
  readonly provider: StorageEvictableProvider
  readonly deleted: string[]
  readonly summaries: EvictionDeviceSummary[]
  readonly warns: string[]
  /** Every archive question this provider asked, in order. */
  readonly asks: string[]
  readonly reads: number
  /** Move the injected clock so the next read is a FRESH one. */
  advance(ms: number): void
}

interface HarnessOptions {
  /** Answers the registry enumeration, one call at a time. The last entry is
   *  reused once the script runs out — a steady state, not a cliff. */
  readonly registry: readonly DeviceRegistryRead[]
}

function harness(rows: readonly SegmentRow[], options: HarnessOptions): Harness {
  const index = new RecordingIndex()
  for (const r of rows) index.addSegment(r)
  const deleted: string[] = []
  const store = new SegmentStore({
    index,
    list: async () => [],
    deletePath: async ({ relativePath }) => {
      deleted.push(relativePath)
    },
    statBytes: async () => 0,
    moveFile: async () => {},
    removeDir: async () => {},
    logger: { warn: () => {}, info: () => {} },
  })
  const sink = { warn: [] as string[], info: [] as string[] }
  const asks: string[] = []
  const summaries: EvictionDeviceSummary[] = []
  let nowMs = 1_000_000
  const state = { reads: 0 }
  const provider = new StorageEvictableProvider({
    archive: () => new FakeArchive(rows, asks),
    logger: capturingLogger(sink),
    store,
    deviceRegistry: async () => {
      const answer =
        options.registry[Math.min(state.reads, options.registry.length - 1)] ??
        ({ status: 'unanswered', detail: 'no script' } satisfies DeviceRegistryRead)
      state.reads += 1
      return answer
    },
    now: () => nowMs,
    orphanConfirmGapMs: 1,
    onEvicted: (out) => summaries.push(...out),
  })
  return {
    provider,
    deleted,
    summaries,
    warns: sink.warn,
    asks,
    get reads() {
      return state.reads
    },
    advance: (ms) => {
      nowMs += ms
    },
  }
}

const answered = (ids: readonly number[]): DeviceRegistryRead => ({
  status: 'answered',
  deviceIds: new Set(ids),
})
const unanswered = (detail: string): DeviceRegistryRead => ({ status: 'unanswered', detail })

/**
 * The disk holds a live camera's OLD footage and a gone camera's NEW footage.
 * Plain oldest-first takes the live camera's rows and never reaches the
 * orphan's; the tier must invert exactly that.
 */
const LIVE_OLD_GONE_NEW: readonly SegmentRow[] = [
  row(LIVE, 1_000),
  row(LIVE, 3_000),
  row(LIVE, 5_000),
  row(GONE, 90_000),
  row(GONE, 92_000),
]

/** Bring the lane to its confirmed state: `ORPHAN_CONFIRMATIONS_REQUIRED`
 *  answered reads, each separated in time, that omit the gone camera. */
async function armLane(h: Harness): Promise<void> {
  for (let i = 0; i < ORPHAN_CONFIRMATIONS_REQUIRED - 1; i++) {
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    h.advance(60_000)
  }
  h.deleted.length = 0
  h.summaries.length = 0
}

describe("an orphaned device's footage is evicted before a live camera's OLDER footage", () => {
  it('takes the gone camera first even though every one of its segments is newer', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([LIVE])] })
    await armLane(h)

    // 200 bytes = two segments. Oldest-first would take the two OLDEST rows,
    // which both belong to the live camera 101.
    const res = await h.provider.evict({ locationId: LOCATION, targetBytes: 200 })

    expect(h.deleted).toEqual([
      segmentRelPath(GONE, 'high', 90_000, 2_000, 100),
      segmentRelPath(GONE, 'high', 92_000, 2_000, 100),
    ])
    expect(res.reclaimedBytes).toBe(200)
    // Not one byte of the live camera, despite it holding all the oldest rows.
    expect(h.deleted.every((p) => p.startsWith(`${String(GONE)}/`))).toBe(true)
  })

  it('is oldest-first WITHIN the dead-device tier', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([LIVE])] })
    await armLane(h)
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    // One segment's worth of target — the gone camera's OLDER row, not its newer.
    expect(h.deleted).toEqual([segmentRelPath(GONE, 'high', 90_000, 2_000, 100)])
  })

  it('falls through to oldest-first once the gone camera is drained, in ONE round', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([LIVE])] })
    await armLane(h)
    // 400 bytes: the orphan holds only 200, so the remaining 200 must come
    // oldest-first from the live camera. The AMOUNT is what oldest-first alone
    // would have freed — only the order changed.
    const res = await h.provider.evict({ locationId: LOCATION, targetBytes: 400 })
    expect(res.reclaimedBytes).toBe(400)
    expect(h.deleted).toEqual([
      segmentRelPath(GONE, 'high', 90_000, 2_000, 100),
      segmentRelPath(GONE, 'high', 92_000, 2_000, 100),
      segmentRelPath(LIVE, 'high', 1_000, 2_000, 100),
      segmentRelPath(LIVE, 'high', 3_000, 2_000, 100),
    ])
  })

  it('records the two reasons separately, so the activity history can tell them apart', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([LIVE])] })
    await armLane(h)
    await h.provider.evict({ locationId: LOCATION, targetBytes: 400 })
    expect(h.summaries.find((s) => s.deviceId === GONE)?.reason).toBe('orphaned-device')
    expect(h.summaries.find((s) => s.deviceId === LIVE)?.reason).toBe('oldest-first')
  })

  it('never hands the same segment to both tiers when the orphan also holds the oldest footage', async () => {
    // The GONE camera owns the oldest rows too, so the oldest-first stream
    // returns exactly what the dead-device tier already took. A target the
    // orphan cannot cover (300 against its 200) is what makes the second tier
    // run at all — without the overlap filter it would re-select the orphan's
    // first row and the round would delete one path twice.
    const rows = [row(GONE, 1_000), row(GONE, 3_000), row(LIVE, 90_000)]
    const h = harness(rows, { registry: [answered([LIVE])] })
    await armLane(h)
    const res = await h.provider.evict({ locationId: LOCATION, targetBytes: 300 })
    expect(h.deleted).toEqual([
      segmentRelPath(GONE, 'high', 1_000, 2_000, 100),
      segmentRelPath(GONE, 'high', 3_000, 2_000, 100),
    ])
    expect(new Set(h.deleted).size).toBe(h.deleted.length)
    expect(res.reclaimedBytes).toBe(200)
  })
})

describe('a registry read that cannot be believed evicts exactly as before, and orphans nothing', () => {
  /** What plain oldest-first does to this fixture, as a fact rather than a
   *  claim: the two OLDEST rows, both the live camera's. */
  const OLDEST_FIRST_VICTIMS = [
    segmentRelPath(LIVE, 'high', 1_000, 2_000, 100),
    segmentRelPath(LIVE, 'high', 3_000, 2_000, 100),
  ]

  it('a read that THROWS evicts oldest-first and says so', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [unanswered('ECONNREFUSED')] })
    // Two rounds, so a lane that "corroborated" a failure would have fired.
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    h.advance(60_000)
    h.deleted.length = 0
    h.summaries.length = 0
    h.asks.length = 0

    const res = await h.provider.evict({ locationId: LOCATION, targetBytes: 200 })

    expect(h.deleted).toEqual(OLDEST_FIRST_VICTIMS)
    expect(res.reclaimedBytes).toBe(200)
    // The sharpest statement of "orphans nothing": the device-scoped read IS
    // the tier running, and it was never issued. A gate that turned the
    // failure into "the registry knows nobody" would have asked it — and,
    // because everything then looks orphaned, would have deleted the very
    // same rows while filing them as dead-device evictions.
    expect(h.asks).toEqual(['oldestSegments'])
    expect(h.summaries.every((s) => s.reason === 'oldest-first')).toBe(true)
    expect(
      h.warns.some((w) => w.includes('the device registry did not answer')),
      'a branch that drops the operator ordering has to say so',
    ).toBe(true)
  })

  it('an EMPTY enumeration is refused — it is what an empty store snapshot looks like', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([])] })
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    h.advance(60_000)
    h.deleted.length = 0
    h.asks.length = 0

    await h.provider.evict({ locationId: LOCATION, targetBytes: 200 })

    expect(h.deleted).toEqual(OLDEST_FIRST_VICTIMS)
    expect(h.asks.includes('oldestSegmentsForDevices')).toBe(false)
    expect(h.warns.some((w) => w.includes('came back empty'))).toBe(true)
  })

  it('a read that knows NONE of the cameras holding footage is a defect report, not a fleet wipe', async () => {
    // The D72 shape: a SYSTEMATICALLY wrong id space. Repetition cannot catch
    // it — both reads agree — so the size of the disagreement has to.
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([90_001, 90_002])] })
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    h.advance(60_000)
    h.deleted.length = 0
    h.asks.length = 0

    await h.provider.evict({ locationId: LOCATION, targetBytes: 200 })

    expect(h.deleted).toEqual(OLDEST_FIRST_VICTIMS)
    expect(h.asks.includes('oldestSegmentsForDevices')).toBe(false)
    expect(h.warns.some((w) => w.includes('knows NONE of the cameras'))).toBe(true)
  })

  it('ONE negative read never authorises a deletion — the cold start after a restart', async () => {
    // A fresh provider is a fresh process: the streak memory is RAM-only and
    // deliberately not durable, so nothing survives a restart to shortcut this.
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([LIVE])] })
    await h.provider.evict({ locationId: LOCATION, targetBytes: 200 })
    expect(h.deleted).toEqual(OLDEST_FIRST_VICTIMS)
    expect(h.summaries.every((s) => s.reason === 'oldest-first')).toBe(true)
  })

  it('a device seen PRESENT again resets its streak immediately — an absence is never latched', async () => {
    const h = harness(LIVE_OLD_GONE_NEW, {
      // absent, then BACK (a transient store blip), then absent again.
      registry: [answered([LIVE]), answered([LIVE, GONE]), answered([LIVE])],
    })
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    h.advance(60_000)
    await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    h.advance(60_000)
    h.deleted.length = 0

    // Read 3 is the FIRST negative since the reset, so it arms and does not fire.
    await h.provider.evict({ locationId: LOCATION, targetBytes: 200 })
    expect(h.deleted).toEqual(OLDEST_FIRST_VICTIMS)
  })

  it('takes ONE registry read per sweep, not one per relief round', async () => {
    // Eight reads inside one transient window are one read, not corroboration.
    const h = harness(LIVE_OLD_GONE_NEW, { registry: [answered([LIVE])] })
    for (let round = 0; round < 8; round++) {
      await h.provider.evict({ locationId: LOCATION, targetBytes: 1 })
    }
    expect(h.reads).toBe(1)
    // …and nothing was orphaned by those eight rounds.
    expect(h.deleted.every((p) => p.startsWith(`${String(LIVE)}/`))).toBe(true)
  })
})
