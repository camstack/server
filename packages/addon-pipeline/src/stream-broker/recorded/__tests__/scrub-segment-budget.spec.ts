import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'
import { ScrubFragmentCache } from '../scrub-fragment-cache'
import {
  SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES,
  scrubWholeSegmentCeilingBytes,
} from '../scrub-read-budget'

/**
 * THE SCRUB READ UNIT SCALES WITH THE STREAM, UNDER THE SESSION BUDGET.
 *
 * Measured on camera 1441 (2026-11-18): its `low` profile is HEVC 1200x536 at
 * ~1.47 Mbps, so a 8-12 s segment is 1.5-2.4 MB. The old fixed 1.5 MB ceiling
 * called almost every one "oversize" (44 `scrub-feeder:oversize-segment` in one
 * session) and the drag fell back to keyframe-only GOP reads at ~250 ms per
 * seek, against ~7 ms on a 200 KB-segment camera. The ceiling is now derived
 * from the session fragment-cache budget (a segment is read whole when enough
 * of its size stay resident), under a hard bound that still refuses a
 * mis-pinned `high`; and the warm walk spends at most that budget per fill, so
 * a fat stream cannot evict its own warm.
 */

const SEG_MS = 12_000
/** ~1.47 Mbps over 12 s: camera 1441's measured `low` shape. */
const FAT_SEG_BYTES = 2_200_000

const AU = (ptsMs: number, key: boolean, size: number) => ({
  data: new Uint8Array(size),
  ptsMs,
  keyframe: key,
  codec: 'H265' as const,
})
/** 12 s at 25 fps, I-frame every 4 s, ~2 MB demuxed in total. */
const FAT_AUS = Array.from({ length: 300 }, (_, i) => AU(i * 40, i % 100 === 0, 6_600))

const segStart = (epochMs: number) => Math.floor(epochMs / SEG_MS) * SEG_MS
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) return
    await sleep(5)
  }
}

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

function harness(segBytes: number, cache: ScrubFragmentCache = new ScrubFragmentCache()) {
  const logs: LogLine[] = []
  const reads: number[] = []
  const deps = {
    deviceId: 1441,
    profile: 'low',
    locate: vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: segStart(epochMs),
          durMs: SEG_MS,
          bytes: segBytes,
        }) as const,
    ),
    readBytes: vi.fn(async ({ startMs }: { startMs: number }) => {
      reads.push(startMs)
      return new Uint8Array(segBytes)
    }),
    readGop: vi.fn(async ({ segmentStartMs }: { segmentStartMs: number }) => ({
      bytes: new Uint8Array([1, 2, 3]),
      gopStartMs: segmentStartMs,
      gopDurMs: 4_000,
    })),
    demux: vi.fn(async () => FAT_AUS),
    sink: { pushAccessUnit: () => {} },
    onState: () => {},
    onPosition: () => {},
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    fragmentCache: cache,
    idleWarmGapMs: 1,
    scrubDeadline: { tickMs: 1_000, firstTickMs: 1_000 },
  }
  return { deps, logs, reads, cache }
}

const linesOf = (logs: readonly LogLine[], msg: string) => logs.filter((l) => l.msg === msg)

describe('scrub read unit scales with the stream', () => {
  it('reads a 2.2 MB segment of a ~1.5 Mbps `low` stream WHOLE and memoises it', async () => {
    const h = harness(FAT_SEG_BYTES)
    const feeder = new RecordedFeeder(h.deps)
    const T = 3_600_000
    feeder.beginScrub()
    feeder.scrubTo(T)
    await until(() => h.reads.includes(segStart(T)))
    feeder.dispose()

    expect(h.reads).toContain(segStart(T))
    expect(h.cache.covering('low', T)).toBeTruthy()
    expect(linesOf(h.logs, 'scrub-feeder:oversize-segment')).toHaveLength(0)
  })

  it('still refuses a segment above the hard bound, and names budget vs size', async () => {
    const pathological = SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES + 1_000_000
    const h = harness(pathological)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(3_600_000)
    await until(() => h.deps.readGop.mock.calls.length > 0)
    await sleep(20)
    feeder.dispose()

    const line = linesOf(h.logs, 'scrub-feeder:oversize-segment')[0]
    expect(line?.data.bytes).toBe(pathological)
    expect(line?.data.ceilingBytes).toBe(scrubWholeSegmentCeilingBytes(h.cache.budgetBytes('low')))
    expect(line?.data.hardMaxBytes).toBe(SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES)
    expect(line?.data.cacheBudgetBytes).toBe(h.cache.budgetBytes('low'))
    expect(h.deps.readGop).toHaveBeenCalled()
  })

  it('the ceiling shrinks with a smaller session budget, never past the hard bound', () => {
    expect(scrubWholeSegmentCeilingBytes(48 * 1024 * 1024)).toBe(SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES)
    expect(scrubWholeSegmentCeilingBytes(12 * 1024 * 1024)).toBeLessThan(FAT_SEG_BYTES)
    expect(scrubWholeSegmentCeilingBytes(1024 * 1024 * 1024)).toBe(
      SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES,
    )
  })

  it('the warm walk spends at most the cache budget per fill, so memory stays bounded', async () => {
    // Large enough that a 2.2 MB segment is a read unit (12 of them fit).
    const budget = 30 * 1024 * 1024
    const h = harness(FAT_SEG_BYTES, new ScrubFragmentCache(budget))
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(3_600_000)
    await until(() => linesOf(h.logs, 'scrub-feeder:warm-done').length > 0)
    feeder.dispose()

    expect(linesOf(h.logs, 'scrub-feeder:warm-done').length).toBeGreaterThan(0)
    // The seek's own read plus a warm that stops once it has read the budget:
    // ±15 min of 12 s segments would otherwise be ~150 reads of 2.2 MB, each
    // evicting the one before it.
    const warmCap = Math.ceil(budget / FAT_SEG_BYTES)
    expect(h.reads.length).toBeGreaterThan(1)
    expect(h.reads.length).toBeLessThanOrEqual(warmCap + 1)
    expect(h.cache.byteSizeFor('low')).toBeLessThanOrEqual(budget)
  })
})
