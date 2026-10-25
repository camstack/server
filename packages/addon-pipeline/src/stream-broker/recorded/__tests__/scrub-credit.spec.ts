import { describe, it, expect, vi, afterEach } from 'vitest'
import { RecordedFeeder } from '../recorded-feeder'

/**
 * RECEIVER CREDIT — the unit the credit is spent and repaid in.
 *
 * The operator's signature: from live, the first seconds of a drag are
 * instant, and at the first slow-down the granularity collapses and never
 * comes back. The mechanism is an accounting mismatch, not an I/O cost:
 *
 *  - a drag opens in `jump` mode (no previous target ⇒ no delta), one AU per
 *    push, one position per push, one ack per position — credit recycles per
 *    round trip and the drag flies;
 *  - slowing down puts consecutive targets inside the 4 s sweep window, so a
 *    push becomes a SWEEP of N access units — but it is still ONE position
 *    message, so a viewer that acks per position (every platform without
 *    `requestVideoFrameCallback`) still sends exactly ONE ack;
 *  - the old `scrubAck` settled one FRAME per ack and only returned the credit
 *    when the head reached zero frames. Two sweeps therefore drained
 *    `SCRUB_CREDIT_CAP` and nothing ever repaid it: the drag parked for good,
 *    and nothing timed the park out.
 *
 * These tests pin the unit: a push costs one credit and is repaid by the FIRST
 * ack that names it, whatever it put on the wire.
 */

const AU = (ptsMs: number, key = false) => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H264' as const,
})

/** Real `low` shape: 4 s fragments, 25 fps — a 1 s step sweeps ~25 AUs. */
const GOP_MS = 4_000
const AUS = Array.from({ length: 100 }, (_, i) => AU(i * 40, i === 0))

interface LogLine {
  readonly msg: string
  readonly data: Record<string, unknown>
}

interface Position {
  readonly epochMs: number
  readonly seq: number | undefined
}

function sweepDeps() {
  const logs: LogLine[] = []
  const positions: Position[] = []
  const pushedAus: number[] = []
  const deps = {
    deviceId: 101,
    profile: 'low',
    locate: vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: Math.floor(epochMs / GOP_MS) * GOP_MS,
          durMs: GOP_MS,
          bytes: 3,
        }) as const,
    ),
    readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    demux: vi.fn(async () => AUS),
    sink: {
      pushAccessUnit: (_d: Uint8Array, ts: number, _c: 'H264' | 'H265') => pushedAus.push(ts),
    },
    onState: () => {},
    onPosition: (epochMs: number, seq?: number) => positions.push({ epochMs, seq }),
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
  }
  return { deps, logs, positions, pushedAus }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 5))
const linesOf = (logs: readonly LogLine[], msg: string) => logs.filter((l) => l.msg === msg)

/** The drag census the feeder emits on exit — the one line D70 reads. */
function dragEnd(logs: readonly LogLine[]): Record<string, unknown> {
  const line = logs.find((l) => l.msg === 'scrub-feeder:drag-end')
  if (!line) throw new Error('no scrub-feeder:drag-end line — the drag reported nothing')
  return line.data
}

/**
 * The viewer WITHOUT `requestVideoFrameCallback`: its only receiver-side signal
 * is the position message, so it acks exactly once per position, echoing the
 * push sequence that position carried. This is the client half of the bug.
 */
function ackPerPosition(feeder: RecordedFeeder, positions: readonly Position[], seen: number[]) {
  for (let i = seen[0] ?? 0; i < positions.length; i++) {
    feeder.scrubAck(positions[i]?.seq)
  }
  seen[0] = positions.length
}

afterEach(() => {
  vi.useRealTimers()
})

describe('scrub receiver credit — a PUSH is the unit, not a frame', () => {
  it('a slowed drag that sweeps keeps pushing: one ack per position repays the whole push', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    const seen = [0]

    // The drag lands (jump), then slows to 1 s steps inside one fragment —
    // every step a sweep of ~25 AUs under ONE position message.
    const base = 1_000_000
    for (let i = 0; i < 8; i++) {
      feeder.scrubTo(base + i * 1_000)
      await flush()
      ackPerPosition(feeder, h.positions, seen)
      await flush()
    }
    await feeder.seek(base)

    const end = dragEnd(h.logs)
    // The whole point: the drag did not stop. Pre-fix this parked after the
    // second sweep and `ticks` stuck at 3 with `parks` climbing.
    expect(Number(end.ticks)).toBeGreaterThanOrEqual(7)
    expect(Number(end.sweeps)).toBeGreaterThanOrEqual(6)
    expect(Number(end.parks)).toBe(0)
    expect(linesOf(h.logs, 'scrub-feeder:parked')).toHaveLength(0)
    feeder.dispose()
  })

  it('the granularity after the slow-down matches the granularity before it', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    const seen = [0]
    const base = 2_000_000

    // Phase 1 — the fast opening: far-apart targets, one AU per push.
    for (let i = 0; i < 4; i++) {
      feeder.scrubTo(base + i * 20_000)
      await flush()
      ackPerPosition(feeder, h.positions, seen)
      await flush()
    }
    const fastPushes = h.positions.length

    // Phase 2 — the operator slows down: same number of targets, now sweeps.
    const slowBase = base + 100_000
    for (let i = 0; i < 4; i++) {
      feeder.scrubTo(slowBase + i * 500)
      await flush()
      ackPerPosition(feeder, h.positions, seen)
      await flush()
    }
    const slowPushes = h.positions.length - fastPushes

    expect(fastPushes).toBeGreaterThanOrEqual(4)
    // One position per target in BOTH phases — the slow phase is where the
    // drag used to die at 2.
    expect(slowPushes).toBeGreaterThanOrEqual(4)
    feeder.dispose()
  })

  it('a viewer that acks per RENDERED FRAME cannot over-repay: the surplus acks name a settled push', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    const base = 3_000_000

    feeder.scrubTo(base)
    await flush()
    const firstSeq = h.positions[0]?.seq
    feeder.scrubTo(base + 1_000)
    await flush()
    // Two pushes outstanding ⇒ zero credit. An rvfc viewer renders the ~25
    // frames of the FIRST push and acks each one, every ack naming that same
    // push. Only the first may settle it; the surplus must repay nothing — the
    // second push is still on the wire and still owes its credit.
    const pushesBefore = h.positions.length
    expect(pushesBefore).toBe(2)
    for (let i = 0; i < 40; i++) feeder.scrubAck(firstSeq)

    // Exactly ONE credit came back, so exactly one further push may go out.
    for (let i = 0; i < 6; i++) {
      feeder.scrubTo(base + 2_000 + i * 200)
      await flush()
    }
    expect(h.positions.length - pushesBefore).toBe(1)
    feeder.dispose()
  })

  it('an ack that names a push from a PREVIOUS drag settles nothing', async () => {
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(4_000_000)
    await flush()
    const staleSeq = h.positions[h.positions.length - 1]?.seq
    await feeder.seek(4_000_000)

    feeder.beginScrub()
    feeder.scrubTo(5_000_000)
    await flush()
    feeder.scrubTo(5_000_500)
    await flush()
    const pushesBefore = h.positions.length
    // The late ack from the drag that already ended must not release credit.
    for (let i = 0; i < 5; i++) feeder.scrubAck(staleSeq)
    for (let i = 0; i < 4; i++) {
      feeder.scrubTo(5_001_000 + i * 200)
      await flush()
    }
    expect(h.positions.length).toBe(pushesBefore)
    feeder.dispose()
  })
})

describe('scrub receiver credit — the ack timeout', () => {
  it('a lost ack unparks the drag instead of stranding it forever', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    })
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    const base = 6_000_000

    // Two pushes, no ack at all — the mute-receiver signature.
    feeder.scrubTo(base)
    await vi.advanceTimersByTimeAsync(20)
    feeder.scrubTo(base + 1_000)
    await vi.advanceTimersByTimeAsync(20)
    const stranded = h.positions.length
    expect(stranded).toBeGreaterThanOrEqual(2)

    // A third target parks: zero credit, nothing outstanding has been acked.
    feeder.scrubTo(base + 2_000)
    await vi.advanceTimersByTimeAsync(20)
    expect(h.positions.length).toBe(stranded)
    expect(linesOf(h.logs, 'scrub-feeder:parked')).toHaveLength(1)

    // The bound: after the ack timeout the outstanding pushes are written off,
    // the credit returns, and the PARKED target is served.
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.positions.length).toBeGreaterThan(stranded)
    // ONE line per drag (each push ages out on its own schedule — a line each
    // would be the flood the instrument exists to avoid); the COUNT is on the
    // census, and it must account for every stranded push.
    const timeouts = linesOf(h.logs, 'scrub-feeder:ack-timeout')
    expect(timeouts).toHaveLength(1)
    expect(Number(timeouts[0]?.data.pushes)).toBeGreaterThanOrEqual(1)
    await feeder.seek(base)
    expect(Number(dragEnd(h.logs).ackTimeouts)).toBeGreaterThanOrEqual(2)
    feeder.dispose()
  })

  it('the write-off is counted on the drag census, never silent', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    })
    const h = sweepDeps()
    const feeder = new RecordedFeeder(h.deps)
    feeder.beginScrub()
    feeder.scrubTo(7_000_000)
    await vi.advanceTimersByTimeAsync(20)
    await vi.advanceTimersByTimeAsync(2_500)
    await feeder.seek(7_000_000)

    expect(Number(dragEnd(h.logs).ackTimeouts)).toBeGreaterThanOrEqual(1)
    feeder.dispose()
  })
})
