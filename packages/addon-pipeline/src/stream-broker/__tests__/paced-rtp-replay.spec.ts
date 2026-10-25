import { describe, it, expect } from 'vitest'
import {
  PacedRtpReplay,
  PACED_REPLAY_DEFAULTS,
  computeReplayChunkSize,
  type PacedReplayStats,
} from '../paced-rtp-replay.js'

/** Manual-step scheduler: ticks fire only when the test calls `step()`. */
function makeManualScheduler() {
  let pending: (() => void) | null = null
  let cancelCount = 0
  const schedule = (fn: () => void, _ms: number): (() => void) => {
    pending = fn
    return () => {
      cancelCount++
      pending = null
    }
  }
  const step = (): boolean => {
    const fn = pending
    if (!fn) return false
    pending = null
    fn()
    return true
  }
  return {
    schedule,
    step,
    get hasPending(): boolean {
      return pending !== null
    },
    get cancelCount(): number {
      return cancelCount
    },
  }
}

function makeReplay(options?: {
  schedule?: (fn: () => void, ms: number) => () => void
  sendResult?: (item: number) => boolean
  tuning?: Partial<typeof PACED_REPLAY_DEFAULTS>
}) {
  const sentItems: number[] = []
  let stats: PacedReplayStats | null = null
  const replay = new PacedRtpReplay<number>(
    (item) => {
      sentItems.push(item)
      return options?.sendResult ? options.sendResult(item) : true
    },
    (s) => {
      stats = s
    },
    {
      schedule: options?.schedule,
      tuning: options?.tuning,
      now: () => 0,
    },
  )
  return {
    replay,
    sentItems,
    getStats: (): PacedReplayStats | null => stats,
  }
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

describe('computeReplayChunkSize', () => {
  const t = PACED_REPLAY_DEFAULTS

  it('sends bursts at or below singleShotMax as one chunk', () => {
    expect(computeReplayChunkSize(1, t)).toBe(1)
    expect(computeReplayChunkSize(64, t)).toBe(64)
  })

  it('clamps medium bursts to the minimum chunk size', () => {
    // 651 packets (measured live low end): ceil(651/60 ticks) = 11 → min 32.
    expect(computeReplayChunkSize(651, t)).toBe(32)
  })

  it('scales chunk size so large bursts finish within the target window', () => {
    // 2273 packets (measured live high end): ceil(2273/60) = 38 → 60 ticks ≈ 300 ms.
    expect(computeReplayChunkSize(2273, t)).toBe(38)
  })

  it('caps the per-tick chunk size for extreme bursts', () => {
    expect(computeReplayChunkSize(100_000, t)).toBe(t.maxChunkSize)
  })
})

describe('PacedRtpReplay', () => {
  it('sends a small burst synchronously in one chunk', () => {
    const sched = makeManualScheduler()
    const { replay, sentItems, getStats } = makeReplay({ schedule: sched.schedule })

    replay.start(range(10))

    expect(sentItems).toEqual(range(10))
    expect(sched.hasPending).toBe(false)
    expect(replay.active).toBe(false)
    const stats = getStats()
    expect(stats).toMatchObject({ packets: 10, sent: 10, chunks: 1, aborted: false })
  })

  it('paces a large burst in order across ticks and completes', () => {
    const sched = makeManualScheduler()
    const { replay, sentItems, getStats } = makeReplay({ schedule: sched.schedule })
    const total = 100 // chunkSize = min clamp 32 → chunks of 32/32/32/4

    replay.start(range(total))

    // First chunk is synchronous.
    expect(sentItems.length).toBe(32)
    expect(replay.active).toBe(true)
    expect(getStats()).toBeNull()

    while (sched.step()) {
      /* drain ticks */
    }

    expect(sentItems).toEqual(range(total)) // order preserved
    expect(replay.active).toBe(false)
    expect(getStats()).toMatchObject({
      packets: total,
      sent: total,
      chunks: 4,
      chunkSize: 32,
      aborted: false,
    })
  })

  it('abort cancels the pending tick and stops sending', () => {
    const sched = makeManualScheduler()
    const { replay, sentItems, getStats } = makeReplay({ schedule: sched.schedule })

    replay.start(range(100))
    expect(sentItems.length).toBe(32)

    replay.abort()

    expect(sched.cancelCount).toBe(1)
    expect(sched.hasPending).toBe(false)
    expect(replay.active).toBe(false)
    expect(getStats()).toMatchObject({ packets: 100, sent: 32, chunks: 1, aborted: true })

    // A stray step after abort must not resurrect the replay.
    expect(sched.step()).toBe(false)
    expect(sentItems.length).toBe(32)
  })

  it('abort is idempotent and onDone fires exactly once', () => {
    const sched = makeManualScheduler()
    let doneCount = 0
    const replay = new PacedRtpReplay<number>(
      () => true,
      () => {
        doneCount++
      },
      { schedule: sched.schedule, now: () => 0 },
    )
    replay.start(range(100))
    replay.abort()
    replay.abort()
    expect(doneCount).toBe(1)
  })

  it('enqueued live packets drain after the initial burst, order preserved', () => {
    const sched = makeManualScheduler()
    const { replay, sentItems, getStats } = makeReplay({ schedule: sched.schedule })

    replay.start(range(100)) // chunkSize 32: first chunk 0..31, 68 remain queued
    expect(replay.enqueue(1000)).toBe(true)
    expect(replay.enqueue(1001)).toBe(true)

    while (sched.step()) {
      /* drain */
    }

    expect(sentItems).toEqual([...range(100), 1000, 1001])
    expect(getStats()).toMatchObject({ packets: 100, enqueuedLive: 2, sent: 102, aborted: false })
  })

  it('enqueue is rejected when the replay is not active', () => {
    const sched = makeManualScheduler()
    const { replay } = makeReplay({ schedule: sched.schedule })

    expect(replay.enqueue(1)).toBe(false) // before start

    replay.start(range(5)) // single shot → completes synchronously
    expect(replay.active).toBe(false)
    expect(replay.enqueue(2)).toBe(false) // after completion
  })

  it('start is a no-op after abort and when called twice', () => {
    const sched = makeManualScheduler()
    const { replay, sentItems } = makeReplay({ schedule: sched.schedule })

    replay.abort()
    replay.start(range(10))
    expect(sentItems.length).toBe(0)

    const second = makeReplay({ schedule: sched.schedule })
    second.replay.start(range(5))
    second.replay.start(range(5))
    expect(second.sentItems.length).toBe(5)
  })

  it('counts only successful sends in `sent`', () => {
    const sched = makeManualScheduler()
    const { replay, getStats } = makeReplay({
      schedule: sched.schedule,
      sendResult: (item) => item % 2 === 0,
    })

    replay.start(range(10))

    expect(getStats()).toMatchObject({ packets: 10, sent: 5 })
  })

  it('stops the current chunk when `send` aborts the replay', () => {
    // The RTSP join path aborts from inside `send` when the peer's socket
    // backlogs mid-burst. `finish` empties the queue, so a chunk that kept
    // going would read past its end and hand `send` an undefined item.
    const sched = makeManualScheduler()
    const sent: Array<number | undefined> = []
    let replay: PacedRtpReplay<number> | null = null
    replay = new PacedRtpReplay<number>(
      (item) => {
        sent.push(item)
        if (item === 4) {
          replay?.abort()
          return false
        }
        return true
      },
      () => {},
      { schedule: sched.schedule, now: () => 0 },
    )
    replay.start(range(100)) // chunkSize 32 — abort lands mid-chunk

    expect(sent).toEqual([0, 1, 2, 3, 4])
    expect(sent.every((v) => v !== undefined)).toBe(true)
    expect(replay.active).toBe(false)
    expect(sched.hasPending).toBe(false)
  })

  it('uses the real timer by default (integration smoke)', async () => {
    const sent: number[] = []
    const done = new Promise<PacedReplayStats>((resolve) => {
      const replay = new PacedRtpReplay<number>(
        (item) => {
          sent.push(item)
          return true
        },
        resolve,
        { tuning: { tickMs: 1 } },
      )
      replay.start(range(100))
    })
    const stats = await done
    expect(sent).toEqual(range(100))
    expect(stats.chunks).toBe(4)
    expect(stats.aborted).toBe(false)
  })
})

// ── Pair-class-aware pacing map ─────────────────────────────────────────────
// Pinned so a future "just make it faster" edit can't silently loosen the
// remote-link protection: relay/public MUST keep the safe defaults.
import { replayTuningForPairClass } from '../webrtc/session.js'

describe('replayTuningForPairClass', () => {
  it('tightens the drain on lan-direct', () => {
    expect(replayTuningForPairClass('lan-direct')).toEqual({
      targetDurationMs: 100,
      maxChunkSize: 256,
    })
  })
  it('moderately tightens on cgnat-vpn (Tailscale overlay)', () => {
    expect(replayTuningForPairClass('cgnat-vpn')).toEqual({ targetDurationMs: 200 })
  })
  it('keeps the safe defaults on relay and public', () => {
    expect(replayTuningForPairClass('relay')).toBeUndefined()
    expect(replayTuningForPairClass('public')).toBeUndefined()
  })
})
