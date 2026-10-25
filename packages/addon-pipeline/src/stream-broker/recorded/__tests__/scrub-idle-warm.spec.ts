import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'
import { ScrubFragmentCache } from '../scrub-fragment-cache'

/**
 * IDLE WARM — the fill loop must survive the gesture.
 *
 * Measured regime this exists for (2026-08-25, live hub): a cold `low` read
 * costs p50 531 ms / p95 seconds on the USB spindle, a warm one 28 ms — a 19×
 * ratio. The entry warm-up used to run ONLY while `scrubbing` was true: it was
 * starved during the drag (the finger's own ticks own the spindle) and killed
 * at commit — precisely when the operator sits on the landed frame deciding
 * where to drag next, which is the one moment the spindle is free. 48 h census:
 * 135 whole reads for 144 cover misses — the warm fetched almost nothing.
 *
 * These specs pin the new contract: a seek (a timeline tap, or a scrub commit)
 * KEEPS filling the ±window around the landing, in the background, paced, until
 * the window is covered or the feeder dies. Memory is bounded by the SAME
 * session cache budget as before (48 MB LRU) — idle warm adds no new store.
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array(key ? 800 : 120),
  ptsMs,
  keyframe: key,
  codec: 'H264' as const,
})

const SEG_MS = 10_000
const SEG_AUS = Array.from({ length: 250 }, (_, i) => AU(i * 40, i % 100 === 0))
const SEG_BYTES = 230_000

const segStart = (epochMs: number) => Math.floor(epochMs / SEG_MS) * SEG_MS

function harness(opts: { profile?: string } = {}) {
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
  const reads: number[] = []
  const cache = new ScrubFragmentCache()
  const deps = {
    deviceId: 104,
    profile: opts.profile ?? 'low',
    locate: vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: segStart(epochMs),
          durMs: SEG_MS,
          bytes: SEG_BYTES,
        }) as const,
    ),
    readBytes: vi.fn(async ({ startMs }: { startMs: number }) => {
      reads.push(startMs)
      return new Uint8Array(SEG_BYTES)
    }),
    demux: vi.fn(async () => SEG_AUS),
    sink: { pushAccessUnit: () => {} },
    onState: () => {},
    onPosition: () => {},
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    fragmentCache: cache,
    idleWarmGapMs: 1,
  }
  return { deps, logs, reads, cache }
}

/**
 * These specs wait on a BACKGROUND paced loop. Waiting a fixed number of
 * milliseconds for it made them flaky under load — the budget was a guess at
 * how fast a laptop schedules a timer, not a fact about the loop, and 120 ms
 * was enough on an idle machine and not enough beside a full vitest run. A
 * flaky spec in a 12k-test suite is worse than no spec: it trains everyone to
 * re-run instead of read.
 *
 * So: poll the CONDITION, with a ceiling generous enough that reaching it means
 * the loop is genuinely broken rather than merely slow. A passing run still
 * costs a few ms, because the condition is usually true on the first poll.
 */
const until = async (cond: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) return
    await new Promise<void>((r) => setTimeout(r, 5))
  }
}

/** For the two specs that assert something must NOT happen — there is no
 *  condition to poll, only a quiet window to observe. */
const quiet = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('idle warm — the fill survives the gesture', () => {
  it('a paused seek (a timeline tap) warms the window around the landing', async () => {
    const h = harness()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    const T = 3_600_000
    await feeder.seek(T)
    // The landing's own read happened synchronously with the seek.
    const atSeek = h.reads.length
    await until(() => h.reads.includes(segStart(T) - SEG_MS) && h.reads.length > atSeek)
    // The walk fetched NEIGHBOURS the seek itself never asked for, into the
    // session cache — backward first (the operator looks at what happened).
    expect(h.reads.length).toBeGreaterThan(atSeek)
    expect(h.reads).toContain(segStart(T) - SEG_MS)
    expect(h.cache.covering('low', T - SEG_MS)).toBeTruthy()
    feeder.dispose()
  })

  it('a scrub COMMIT keeps warming after the drag ends', async () => {
    const h = harness()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    const T = 7_200_000
    feeder.beginScrub()
    feeder.scrubTo(T)
    await until(() => h.reads.length > 0)
    await feeder.seek(T) // the commit
    const atCommit = h.reads.length
    await until(() => h.reads.length > atCommit && !!h.cache.covering('low', T - 2 * SEG_MS))
    expect(h.reads.length).toBeGreaterThan(atCommit)
    expect(h.cache.covering('low', T - 2 * SEG_MS)).toBeTruthy()
    feeder.dispose()
  })

  it('dispose stops the idle fill', async () => {
    const h = harness()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(3_600_000)
    await until(() => h.reads.length > 1)
    feeder.dispose()
    await quiet(30)
    const after = h.reads.length
    await quiet(200)
    expect(h.reads.length).toBe(after)
  })

  it('idle warm never runs for a non-low profile (a high window would be hundreds of MB)', async () => {
    const h = harness({ profile: 'high' })
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    const T = 3_600_000
    await feeder.seek(T)
    const atSeek = h.reads.length
    await quiet(200)
    expect(h.reads.length).toBe(atSeek)
    feeder.dispose()
  })

  it('a completed fill window says so — one warm-done line with the fetch count', async () => {
    const h = harness()
    const feeder = new RecordedFeeder(h.deps)
    feeder.setRate(0)
    await feeder.seek(3_600_000)
    await until(() => h.logs.some((l) => l.msg === 'scrub-feeder:warm-done'))
    const done = h.logs.filter((l) => l.msg === 'scrub-feeder:warm-done')
    expect(done.length).toBeGreaterThanOrEqual(1)
    expect(typeof done[0]!.data.fetched).toBe('number')
    feeder.dispose()
  })
})
