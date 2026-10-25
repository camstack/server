import { describe, it, expect, vi } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'

/**
 * SCRUB FRAME DEADLINE + SINGLE-FLIGHT RETARGETING.
 *
 * The operator's report — "scrub provato, quasi 0 frame, playback parte dopo
 * una vita", worse on wide windows — has one mechanism behind it, and it is
 * not the number of frames we ask for. It is that a scrub frame had no
 * deadline: the tick's only bound was `SEGMENT_TIMEOUT_MS = 8000`, against a
 * measured cold read of p50 531 ms, p95 1.4–2 s and a 9.2 s max (census
 * 2026-08-25). The feeder WAITED where the reference design would have
 * dropped four frames and drawn the fifth, and the frame it finally drew was
 * for a finger position from seconds ago.
 *
 * Three properties are pinned here, and each one is a thing the drag used to
 * do wrong:
 *
 *  1. a frame that cannot be produced inside its deadline is DROPPED — the
 *     tick returns, the drag continues, and the miss is counted (never a
 *     silent stall, per CLAUDE.md's dropped-work rule);
 *  2. the abandoned read is not wasted: it completes into the session
 *     fragment cache, so the tick that follows is a HIT and pays nothing;
 *  3. a target that arrives while a read is in flight RIDES that read instead
 *     of queueing a second one behind it, and when the read lands the frame is
 *     pushed at the NEWEST target the fragment covers — the picture stops
 *     chasing the finger.
 */

const AU = (ptsMs: number, key: boolean) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H264' as const,
})

const SEG_MS = 10_000
/** 10 s at 25 fps with a 4 s GOP — the real `low` shape. */
const AUS = Array.from({ length: 250 }, (_, i) => AU(i * 40, i % 100 === 0))

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

interface Position {
  readonly epochMs: number
  readonly seq: number | undefined
}

/** A feeder whose segment read takes `readMs`, with every phase observable. */
function slowReadDeps(readMs: number, ack = false) {
  const acker: { feeder: RecordedFeeder | null } = { feeder: null }
  const logs: LogLine[] = []
  const positions: Position[] = []
  const concurrency = { now: 0, max: 0 }
  const readBytes = vi.fn(async () => {
    concurrency.now += 1
    concurrency.max = Math.max(concurrency.max, concurrency.now)
    try {
      await sleep(readMs)
      return new Uint8Array([1, 2, 3])
    } finally {
      concurrency.now -= 1
    }
  })
  const locate = vi.fn(
    async ({ epochMs }: { epochMs: number }) =>
      ({
        kind: 'segment',
        startMs: Math.floor(epochMs / SEG_MS) * SEG_MS,
        durMs: SEG_MS,
        bytes: 230_000,
      }) as const,
  )
  const deps = {
    deviceId: 101,
    profile: 'low',
    locate,
    readBytes,
    demux: vi.fn(async () => AUS),
    sink: { pushAccessUnit: () => {} },
    onState: () => {},
    onPosition: (epochMs: number, seq?: number) => {
      positions.push({ epochMs, seq })
      // A viewer that acks what it painted: without it the credit gate parks
      // the drag after two pushes and no scenario below gets past its opening.
      if (ack && seq !== undefined) setTimeout(() => acker.feeder?.scrubAck(seq), 5)
    },
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    // Tiny budgets so the spec runs in milliseconds; production takes the
    // SCRUB_TICK_DEADLINE_MS / SCRUB_FIRST_TICK_DEADLINE_MS defaults.
    scrubDeadline: { tickMs: 40, firstTickMs: 40 },
  }
  return { deps, logs, positions, readBytes, locate, concurrency, acker }
}

/** Pushes only — a position WITHOUT a seq is a report, not a painted frame. */
const pushesOf = (positions: readonly Position[]) => positions.filter((p) => p.seq !== undefined)
const linesOf = (logs: readonly LogLine[], msg: string) => logs.filter((l) => l.msg === msg)

function dragEnd(logs: readonly LogLine[]): Record<string, unknown> {
  const line = logs.find((l) => l.msg === 'scrub-feeder:drag-end')
  if (!line) throw new Error('no scrub-feeder:drag-end line — the drag reported nothing')
  return line.data
}

describe('scrub frame deadline', () => {
  it('drops the frame instead of waiting when the read outlives the deadline', async () => {
    const h = slowReadDeps(400)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)

    // Well past the 40 ms deadline and well before the 400 ms read: with a
    // deadline the tick has already given up; without one it is still awaiting.
    await sleep(150)
    expect(pushesOf(h.positions)).toHaveLength(0)
    expect(linesOf(h.logs, 'scrub-feeder:deadline-miss').length).toBeGreaterThan(0)

    feeder.dispose()
    expect(dragEnd(h.logs).deadlineMisses).toBeGreaterThan(0)
  })

  it('does not kill the drag: the read it abandoned lands in the cache and the next tick is free', async () => {
    const h = slowReadDeps(300)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)
    await sleep(120)
    expect(pushesOf(h.positions)).toHaveLength(0)

    // The abandoned read completes on its own and is cached. A later target in
    // the same segment must be served from RAM — no second read, no locate.
    await sleep(400)
    const readsAfterLanding = h.readBytes.mock.calls.length
    feeder.scrubTo(1_000_000 + 120)
    await sleep(80)

    expect(pushesOf(h.positions).length).toBeGreaterThan(0)
    expect(h.readBytes.mock.calls.length).toBe(readsAfterLanding)

    feeder.dispose()
    const end = dragEnd(h.logs)
    // Free means free: the frames this drag painted came from coverage, not
    // from a second trip to the disk.
    expect(Number(end.coverMemo) + Number(end.coverCache)).toBeGreaterThan(0)
  })

  it('retargets the landing to where the finger IS, never pushing the instant the read started for', async () => {
    // A deadline generous enough that ONE tick spans the whole read: the
    // finger moves while the bytes are on the wire, and the frame that lands
    // must be the finger's CURRENT instant, not the one it left.
    const h = slowReadDeps(300)
    const feeder = new RecordedFeeder({
      ...h.deps,
      scrubDeadline: { tickMs: 1_000, firstTickMs: 1_000 },
    })
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)
    await sleep(60)
    feeder.scrubTo(1_000_000 + 4_000)
    await sleep(500)

    expect(h.readBytes.mock.calls.length).toBe(1)
    const pushed = pushesOf(h.positions)
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed[0]?.epochMs).toBe(1_000_000 + 4_000)

    feeder.dispose()
    expect(dragEnd(h.logs).retargets).toBeGreaterThan(0)
  })

  it('a tick that arrives while a read is in flight rides it — one read, not two', async () => {
    const h = slowReadDeps(300)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)
    await sleep(120) // deadline miss — the read is still running
    feeder.scrubTo(1_000_000 + 4_000)
    await sleep(500)

    expect(h.readBytes.mock.calls.length).toBe(1)
    const pushed = pushesOf(h.positions)
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed[pushed.length - 1]?.epochMs).toBe(1_000_000 + 4_000)

    feeder.dispose()
    expect(Number(dragEnd(h.logs).resolveJoins)).toBeGreaterThan(0)
  })

  it('gives the FIRST frame of a drag a longer deadline — a blank screen is worse than a late frame', async () => {
    const h = slowReadDeps(200)
    const feeder = new RecordedFeeder({
      ...h.deps,
      scrubDeadline: { tickMs: 40, firstTickMs: 1_000 },
    })
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)
    await sleep(400)

    expect(pushesOf(h.positions).length).toBe(1)
    expect(linesOf(h.logs, 'scrub-feeder:deadline-miss')).toHaveLength(0)
    feeder.dispose()
  })

  it('reads AHEAD of the finger on a steady drag, by about what a read costs', async () => {
    // The frame a drag paints is the frame a read STARTED for, one read time
    // ago. On this disk that is 531 ms of wall clock — which on a wide window
    // is twenty minutes of timeline, and it is the whole of "l'immagine
    // insegue il dito". A steady drag has a measurable media velocity and the
    // feeder has a measured read cost, so the target it READS is the one the
    // finger will be on when the bytes land.
    const h = slowReadDeps(200, true)
    const feeder = new RecordedFeeder({
      ...h.deps,
      scrubDeadline: { tickMs: 1_000, firstTickMs: 1_000 },
    })
    h.acker.feeder = feeder
    feeder.beginScrub()
    const base = 1_000_000
    let last = base
    for (let i = 0; i < 24; i++) {
      last = base + i * 4_000 // 100 ms of timeline per ms of wall clock
      feeder.scrubTo(last)
      await sleep(40)
    }
    await sleep(300)
    // Leading is unmistakable: a locate issued for an instant the finger has
    // not reached can only be deliberate. The census carries how far.
    const maxLocate = Math.max(...h.locate.mock.calls.map((c) => c[0]?.epochMs ?? 0))
    const fingerTargets = new Set(Array.from({ length: 24 }, (_, i) => base + i * 4_000))
    // Leading is unmistakable: the feeder asked the disk for an instant AHEAD
    // of the last frame it painted. That gap is the whole of "l'immagine
    // insegue il dito" — closed on purpose, at read time.
    //
    // Measured against what it PAINTED, not against `last`. The finger emits 24
    // samples in ~960 ms and an ack-gated drag on a 200 ms disk serves 6 ticks,
    // so `last` is a position no tick was ever handed. Comparing to it used to
    // pass only because the deleted directional prefetch fired extra locates
    // further out — the assertion was measuring speculation, not the lead.
    // Every instant the finger actually named is in `fingerTargets`. A locate
    // for anything else can only be `target + lead` — the feeder aiming past
    // the finger on purpose.
    const aheadOfFinger = h.locate.mock.calls
      .map((c) => c[0]?.epochMs ?? 0)
      .filter((e) => !fingerTargets.has(e))
    expect(aheadOfFinger.length).toBeGreaterThan(0)
    expect(maxLocate).toBeGreaterThan(Math.min(...fingerTargets))
    feeder.dispose()
    expect(Number(dragEnd(h.logs).leadMsMax)).toBeGreaterThan(0)
  })

  it('never runs more than the in-flight bound of concurrent reads, however many frames it drops', async () => {
    // A read far slower than the deadline, with the finger crossing a new
    // segment every tick: every tick misses, and each one is tempted to start
    // its own read. The bound is what keeps a drag from becoming a read storm
    // on a disk that is the bottleneck in the first place.
    const h = slowReadDeps(600)
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    for (let i = 0; i < 10; i++) {
      feeder.scrubTo(1_000_000 + i * 60_000)
      await sleep(50)
    }
    await sleep(100)
    // The bound is on CONCURRENT reads, not on reads per drag: a long drag over
    // cold footage legitimately reads many segments, one after another.
    expect(h.concurrency.max).toBeLessThanOrEqual(2)
    feeder.dispose()
  })
})

/**
 * THE TWO SILENT DEGRADATIONS — both named in the 2026-08-25 teardown as
 * branches that drop the scrub design's guarantees without saying so.
 *
 * They are here rather than in their own file because they share the harness
 * and, more to the point, they share a cause: the scrub optimisations are all
 * gated on facts (`profile === 'low'`, `bytes <= ceiling`) that can stop being
 * true at runtime, leaving a drag that still "works" and is six times more
 * expensive per frame.
 */
describe('scrub degradations are reported, never inferred', () => {
  it('says so when a `low` segment is too big to read whole', async () => {
    const h = slowReadDeps(10)
    const feeder = new RecordedFeeder({
      ...h.deps,
      // Above SCRUB_WHOLE_SEGMENT_MAX_BYTES: the read unit degrades from the
      // whole segment to a GOP range, which is the exact break a 10 s → 60 s
      // segment change makes silent.
      locate: async ({ epochMs }: { epochMs: number }) => ({
        kind: 'segment' as const,
        startMs: Math.floor(epochMs / SEG_MS) * SEG_MS,
        durMs: SEG_MS,
        bytes: 4_800_000,
      }),
      readGop: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        gopStartMs: 1_000_000,
        gopDurMs: 4_000,
      }),
      scrubDeadline: { tickMs: 1_000, firstTickMs: 1_000 },
    })
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)
    await sleep(120)
    feeder.dispose()

    const line = linesOf(h.logs, 'scrub-feeder:oversize-segment')[0]
    expect(line?.data.bytes).toBe(4_800_000)
    expect(line?.data.bytesPerSecond).toBe(480_000)
    expect(Number(dragEnd(h.logs).oversizeSegments)).toBeGreaterThan(0)
  })

  it('says so when the drag is not on the scrub profile at all', async () => {
    const h = slowReadDeps(10)
    const feeder = new RecordedFeeder({ ...h.deps, profile: 'high' })
    feeder.beginScrub()
    feeder.scrubTo(1_000_000)
    await sleep(120)
    feeder.dispose()

    expect(linesOf(h.logs, 'scrub-feeder:profile-degraded')).toHaveLength(1)
    expect(dragEnd(h.logs).degradedProfile).toBe('high')
  })
})
