import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'
import { ScrubFragmentCache } from '../scrub-fragment-cache'

/**
 * A DRAG SPECULATES NOTHING. The disk it would speculate on is the one the
 * finger is waiting for.
 *
 * ## What was here, and why it is gone
 *
 * This file used to pin a directional predictor: track the drag's recent
 * direction, and once it ran two ticks the same way, read ahead by one more
 * step of the size the drag was actually taking. It replaced an older rule
 * (probe the ADJACENT fragment) that was measurably wrong for a fast drag, and
 * it passed every test below.
 *
 * It was still wrong. Measured on the operator's own drags (2026-08-26):
 *
 *     25 speculative reads → 3 hits (12%), ~60% of all disk work in the gesture
 *
 * The tests it passed drove a drag at CONSTANT step size, which is the one
 * regime where direction predicts position. A real backward scrub is
 * exploratory — 26 of 29 jumps backward, the step set by wherever the operator
 * decided to look next — so the premise never held in the field. A green suite
 * proved the predictor worked on the gesture nobody makes.
 *
 * The reference design, which does not stutter here, has no predictive
 * prefetch at all: a stream `highWaterMark` for read-ahead, and fast-forward
 * on an open fd instead
 * of a seek for short forward moves. There was no mechanism to adopt.
 *
 * ## The rule these tests pin now
 *
 * 1. **A live drag issues zero speculative reads.** Every read is one a tick
 *    asked for.
 * 2. **The counter survives the removal.** `prefetchReads` is still emitted on
 *    `drag-end`, still reading zero. If speculation ever comes back — in any
 *    form — it lands in the census on its first drag instead of hiding for
 *    three months, which is exactly how the last two versions of it survived.
 * 3. **The careful drag did not regress**, because it never depended on
 *    speculation: it is served by the MEMO (the fragment the previous tick
 *    demuxed), at zero I/O.
 *
 * What remains, and is NOT speculation: the IDLE warm (`runScrubFillLoop`),
 * a sequential fill that runs when no drag is live. It competes with nothing.
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H264' as const,
})

/** The real `low` shape: 10 s segment files, ~4 s fragments, 25 fps. */
const FRAG_MS = 4_000
const FRAG_AUS = Array.from({ length: 100 }, (_, i) => AU(i * 40, i === 0))

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

/** Every GOP read the feeder issues, tick and prefetch alike. */
interface ReadRecord {
  readonly epochMs: number
  readonly gopStartMs: number
}

function fragmentDeps() {
  const logs: LogLine[] = []
  const reads: ReadRecord[] = []
  const positions: Array<{ epochMs: number; seq: number | undefined }> = []
  const fragStart = (epochMs: number) => Math.floor(epochMs / FRAG_MS) * FRAG_MS
  const deps = {
    deviceId: 104,
    profile: 'low',
    locate: vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          // 10 s segment files, as the recorder writes them.
          startMs: Math.floor(epochMs / 10_000) * 10_000,
          durMs: 10_000,
          bytes: 1_000_000,
        }) as const,
    ),
    // Since D163 the scrub unit for `low` is the whole segment, so the read
    // ledger has to count BOTH doors — the point of these tests is where
    // speculation aims, not which call carries it.
    readBytes: vi.fn(async ({ startMs }: { startMs: number }) => {
      reads.push({ epochMs: startMs, gopStartMs: fragStart(startMs) })
      return new Uint8Array(230_000)
    }),
    readGop: vi.fn(async ({ epochMs }: { epochMs: number }) => {
      const gopStartMs = fragStart(epochMs)
      reads.push({ epochMs, gopStartMs })
      return { gopStartMs, gopDurMs: FRAG_MS, bytes: new Uint8Array(134_800) }
    }),
    demux: vi.fn(async () => FRAG_AUS),
    sink: { pushAccessUnit: () => {} },
    onState: () => {},
    onPosition: (epochMs: number, seq?: number) => positions.push({ epochMs, seq }),
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    fragmentCache: new ScrubFragmentCache(),
  }
  return { deps, logs, reads, positions, fragStart }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 5))

function dragEnd(logs: readonly LogLine[]): Record<string, unknown> {
  const line = logs.find((l) => l.msg === 'scrub-feeder:drag-end')
  if (!line) throw new Error('no scrub-feeder:drag-end line')
  return line.data
}

/**
 * The operator's gesture, as measured: a steady drag whose consecutive targets
 * are `stepMs` apart — tens of seconds, because the tick is slow and the
 * timeline maps ~8.8 s per CSS pixel.
 */
async function driveSteadyDrag(
  feeder: RecordedFeeder,
  positions: ReadonlyArray<{ epochMs: number; seq: number | undefined }>,
  opts: { from: number; stepMs: number; ticks: number },
): Promise<void> {
  let acked = 0
  let target = opts.from
  for (let i = 0; i < opts.ticks; i++) {
    feeder.scrubTo(target)
    await flush()
    await flush()
    while (acked < positions.length) {
      feeder.scrubAck(positions[acked]?.seq)
      acked += 1
    }
    await flush()
    target += opts.stepMs
  }
}

describe('scrub prefetch — a drag speculates nothing', () => {
  it('a long-step drag reads ONLY what a tick asked for — zero speculation', async () => {
    const h = fragmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    // The measured gesture: ~26 s per tick, because the timeline maps ~8.8 s
    // per CSS pixel and a slow tick lets the finger travel.
    await driveSteadyDrag(feeder, h.positions, {
      from: 10_000_000,
      stepMs: 26_000,
      ticks: 8,
    })
    // Counted BEFORE the commit, which pays its own read and is not part of the
    // gesture. Everything after this line is the commit's business.
    const readsDuringDrag = h.reads.length
    await feeder.seek(10_000_000 + 26_000 * 8)

    const end = dragEnd(h.logs)
    expect(Number(end.prefetchReads)).toBe(0)
    // The claim, straight from the DOOR rather than from the number the feeder
    // reports about itself: one read per tick, no more. A read the census does
    // not see is exactly how the last two predictors hid.
    // 0 === 0 is not a passing test. The drag has to have HAPPENED.
    expect(Number(end.ticks)).toBeGreaterThan(3)
    expect(readsDuringDrag).toBe(Number(end.ticks))
  })

  it('every speculative read is COUNTED — a prefetch that returns can never hide again', async () => {
    const h = fragmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    await driveSteadyDrag(feeder, h.positions, {
      from: 10_000_000,
      stepMs: 26_000,
      ticks: 6,
    })
    const readsDuringDrag = h.reads.length
    await feeder.seek(10_000_000)

    const end = dragEnd(h.logs)
    // `prefetchReads` stays on the drag-end line even at zero. It is the seat
    // kept warm for the next person who thinks they can guess where a finger is
    // going: the counter is already wired, so their first drag on real footage
    // prints the hit rate instead of hiding it for three months.
    expect(end.prefetchReads).toBeTypeOf('number')
    // Speculation is reads MINUS the ticks that asked for them. Zero, and it is
    // zero at the door, not merely zero in the counter.
    expect(Number(end.ticks)).toBeGreaterThan(3)
    expect(readsDuringDrag - Number(end.ticks)).toBe(0)
    expect(Number(end.prefetchReads)).toBe(0)
  })

  it('a slow, careful drag is served by the MEMO — it never depended on speculation', async () => {
    const h = fragmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    // 800 ms per tick: several ticks inside one fragment, then the edge.
    await driveSteadyDrag(feeder, h.positions, {
      from: 10_000_000,
      stepMs: 800,
      ticks: 10,
    })
    await feeder.seek(10_000_000)

    const end = dragEnd(h.logs)
    // This is the number that made the removal safe: a drag with locality is
    // already answered at zero I/O by the fragment the previous tick demuxed.
    // Whatever the predictor was worth, it was not worth it HERE.
    expect(Number(end.coverMemo)).toBeGreaterThanOrEqual(5)
    expect(Number(end.prefetchReads)).toBe(0)
    // The 8 s the drag covers span 2-3 fragments, and nothing beyond is read.
    expect(new Set(h.reads.map((r) => r.gopStartMs)).size).toBeLessThanOrEqual(3)
  })

  it('a drag that keeps reversing spends NOTHING — the case the predictor was built for', async () => {
    const h = fragmentDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    let acked = 0
    const base = 10_000_000
    // Forward, back, forward, back — no sustained direction to bet on.
    for (const delta of [0, 30_000, -28_000, 26_000, -31_000, 27_000]) {
      feeder.scrubTo(base + delta)
      await flush()
      await flush()
      while (acked < h.positions.length) {
        feeder.scrubAck(h.positions[acked]?.seq)
        acked += 1
      }
      await flush()
    }
    await feeder.seek(base)

    expect(Number(dragEnd(h.logs).prefetchReads)).toBe(0)
  })
})
