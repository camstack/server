/**
 * The reclaim gate, and the two processes it has to be right about at once.
 *
 * Every fixture is a live reading from 2026-08-29:
 *
 *  - **hub-main** — `stranded` 1031–2313 MB for a whole boot against a 1024 MB
 *    trigger, i.e. the gate never once said no; nine minutes out of nine that
 *    contained a reclaim show `loopMax` ≈ the pass's own 555–869 ms, against
 *    107–435 ms for every minute without one.
 *  - **`hub/recorder`** — ONE pass in six hours, `stranded=1029MB`,
 *    `freed=507MB`, and that single line is the only cheap proof anyone has that
 *    its 1.4 GB is retained rather than churn.
 *
 * A change that silences the recorder destroys a production probe; a change that
 * leaves hub-main's 120 s timer alone leaves a self-inflicted stall on the
 * process that mediates every cross-runner call. Both are asserted here.
 */
import { describe, expect, it, vi } from 'vitest'

// The default RssAnon reader reads the HOST's /proc/self/status on Linux, so the
// gate would judge this machine's real anonymous memory instead of the
// `readMemory` fixture (macOS has no such split and keeps `rss`). Pin the reader
// to the non-Linux answer so the result does not depend on the host.
vi.mock('../anon-rss.js', () => ({
  createAnonRssReader: (): (() => number | undefined) => () => undefined,
}))
import {
  createLoopDelayMeter,
  HEAP_RECLAIM_MIN_INTERVAL_MS,
  HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS,
  HEAP_RECLAIM_TRIGGER_MB,
  HEAP_WATCH_FAST_INTERVAL_MS,
  type LoopDelayMeter,
  RECLAIM_STEADY_STATE_PASSES,
  reclaimIntervalMs,
  shouldReclaim,
  startHeapWatch,
  strandedMb,
  buildHeapSample,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

const MB = 1048576
const HUB_HEAP_LIMIT = 4288 * MB
const QUIET_LOOP: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => {} }

function mem(over: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 3081 * MB,
    heapUsed: 1400 * MB,
    heapTotal: 1600 * MB,
    external: 650 * MB,
    arrayBuffers: 542 * MB,
    ...over,
  } as NodeJS.MemoryUsage
}

/** hub-main, every sample of the 2026-08-29 boot: stranded 1031–2313MB. */
const HUB_MAIN_STRANDED = mem({ rss: 3081 * MB, heapUsed: 1400 * MB, external: 650 * MB })

describe('why a threshold in `stranded` cannot discriminate on hub-main', () => {
  it('the trigger is satisfied by every sample of the boot — it is not a gate', () => {
    // 3081 − 1400 − 650 = 1031, the LOWEST stranded reading of the boot. The
    // highest was 2313. If the smallest one already clears the trigger, no
    // sample can fail it, and the only thing left deciding is the timer.
    const sample = buildHeapSample(HUB_MAIN_STRANDED, HUB_HEAP_LIMIT)
    expect(strandedMb(sample)).toBe(1031)
    expect(strandedMb(sample)).toBeGreaterThan(HEAP_RECLAIM_TRIGGER_MB)
    expect(shouldReclaim(sample)).toBe(true)
  })

  it('and the recorder clears it too — the LEVEL is not what separates them', () => {
    // 2478 − 1439 − 10 = 1029, two megabytes from hub-main's minimum. Any fix
    // that raises the trigger to quieten hub-main silences the recorder's only
    // probe, which is why the fix is not the trigger.
    const recorder = buildHeapSample(
      mem({ rss: 2478 * MB, heapUsed: 1439 * MB, external: 10 * MB }),
      HUB_HEAP_LIMIT,
    )
    expect(strandedMb(recorder)).toBe(1029)
    expect(shouldReclaim(recorder)).toBe(true)
  })
})

describe('the cadence, once the pass has proven it is steady state', () => {
  it('a rescue keeps the 120s floor — a burst must still be bounded fast', () => {
    for (let passes = 0; passes < RECLAIM_STEADY_STATE_PASSES; passes += 1) {
      expect(reclaimIntervalMs(passes)).toBe(HEAP_RECLAIM_MIN_INTERVAL_MS)
    }
  })

  it('a proven steady state backs off to the period the burst argument never covered', () => {
    expect(reclaimIntervalMs(RECLAIM_STEADY_STATE_PASSES)).toBe(
      HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS,
    )
    expect(reclaimIntervalMs(99)).toBe(HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS)
  })

  it('never SHORTENS a floor the caller chose', () => {
    // An operator or a test asking for an hour must not silently get ten minutes.
    expect(reclaimIntervalMs(99, 3_600_000)).toBe(3_600_000)
  })

  it('the backed-off period costs the router a fifth of what the timer did', () => {
    // ~700ms per pass, measured 555–869ms. 700/120000 = 0.58% of wall clock;
    // 700/600000 = 0.12%. The pass keeps running — it is still the only
    // measurement of this process's live ArrayBuffer set.
    const stallMs = 700
    expect(stallMs / HEAP_RECLAIM_MIN_INTERVAL_MS).toBeCloseTo(0.0058, 4)
    expect(stallMs / HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS).toBeCloseTo(0.0012, 4)
  })
})

interface ReclaimRun {
  readonly passes: number
  readonly warns: readonly string[]
}

/**
 * Drive a process that NEVER falls back under the trigger, for `durationMs` of
 * virtual time, and count the passes.
 */
function runPermanentlyStranded(durationMs: number): ReclaimRun {
  vi.useFakeTimers()
  const warns: string[] = []
  let clock = 0
  let passes = 0
  const stop = startHeapWatch(
    'hub-main',
    { info: () => {}, warn: (l) => warns.push(l) },
    60_000,
    {
      reclaim: () => {
        passes += 1
      },
      readMemory: () => HUB_MAIN_STRANDED,
      heapLimitBytes: HUB_HEAP_LIMIT,
      now: () => clock,
    },
    QUIET_LOOP,
    ['--max-old-space-size=3072'],
    false,
  )
  try {
    for (let elapsed = 0; elapsed < durationMs; elapsed += HEAP_WATCH_FAST_INTERVAL_MS) {
      clock += HEAP_WATCH_FAST_INTERVAL_MS
      vi.advanceTimersByTime(HEAP_WATCH_FAST_INTERVAL_MS)
    }
  } finally {
    stop()
    vi.useRealTimers()
  }
  return { passes, warns }
}

describe('hub-main, driven for an hour of virtual time', () => {
  it('fires at 120s until the run is proven, then at 600s — not 30 times', () => {
    const run = runPermanentlyStranded(3_600_000)
    // 6 passes at the 120s floor (12 min), then the rest at 600s: 6 + ~4 in the
    // remaining 48 minutes. The unfixed timer would have fired ~30 times.
    expect(run.passes).toBeGreaterThanOrEqual(9)
    expect(run.passes).toBeLessThanOrEqual(12)
    expect(3_600_000 / HEAP_RECLAIM_MIN_INTERVAL_MS).toBe(30)
  })

  it('says what it did, and why, exactly once', () => {
    const run = runPermanentlyStranded(3_600_000)
    const announcements = run.warns.filter((l) => l.includes('STEADY STATE'))
    expect(announcements).toHaveLength(1)
    const line = announcements[0] ?? ''
    expect(line).toContain('BACKING OFF to every 600000ms')
    expect(line).toContain('not discriminating on this process')
    // The pass is NOT removed — it is the only measurement of the live
    // ArrayBuffer set anyone has.
    expect(line).toContain('the pass keeps running')
  })
})

describe('hub/recorder is untouched, by construction', () => {
  it('a strand that takes six hours to re-form never reaches the steady-state run', () => {
    vi.useFakeTimers()
    const info: string[] = []
    const warns: string[] = []
    let clock = 0
    let passes = 0
    // The recorder's shape: stranded over the trigger only occasionally, and by
    // the time it fires again the previous pass is hours old.
    let stranded = true
    const stop = startHeapWatch(
      'hub/recorder',
      { info: (l) => info.push(l), warn: (l) => warns.push(l) },
      300_000,
      {
        reclaim: () => {
          passes += 1
          // A pass on the recorder genuinely returns it under the trigger.
          stranded = false
        },
        readMemory: () =>
          stranded
            ? mem({ rss: 2478 * MB, heapUsed: 1439 * MB, external: 10 * MB })
            : mem({ rss: 1971 * MB, heapUsed: 1439 * MB, external: 10 * MB }),
        heapLimitBytes: HUB_HEAP_LIMIT,
        now: () => clock,
      },
      QUIET_LOOP,
      ['--max-old-space-size=3072'],
      false,
    )
    try {
      // Six hours, with the strand re-forming once an hour.
      for (let elapsed = 0; elapsed < 6 * 3_600_000; elapsed += HEAP_WATCH_FAST_INTERVAL_MS) {
        clock += HEAP_WATCH_FAST_INTERVAL_MS
        if (clock % 3_600_000 === 0) stranded = true
        vi.advanceTimersByTime(HEAP_WATCH_FAST_INTERVAL_MS)
      }
    } finally {
      stop()
      vi.useRealTimers()
    }
    // It reclaimed every time it needed to — the probe is intact...
    expect(passes).toBeGreaterThanOrEqual(6)
    // ...and it was NEVER declared steady state, so its cadence never changed.
    expect(warns.filter((l) => l.includes('STEADY STATE'))).toHaveLength(0)
    expect(info.some((l) => l.includes('[mem] reclaim hub/recorder'))).toBe(true)
  })

  it('and a process that RECOVERS gets its 120s floor straight back', () => {
    // The run resets the moment the strand falls under the trigger, so a burst
    // that subsides is bounded at 120s exactly as before.
    expect(reclaimIntervalMs(RECLAIM_STEADY_STATE_PASSES)).toBe(
      HEAP_RECLAIM_STEADY_STATE_INTERVAL_MS,
    )
    expect(reclaimIntervalMs(0)).toBe(HEAP_RECLAIM_MIN_INTERVAL_MS)
  })
})

describe('loopP50=20ms was the sampler, not the loop', () => {
  it('a quiet loop reports a small delay, not the histogram resolution', async () => {
    // Raw, this histogram reads ~20ms at EVERY percentile on a quiet loop, and
    // every `[mem]` line this cluster ever emitted said `loopP50=20ms` because
    // of it — read, repeatedly, as "hub-main is chronically 20ms behind".
    const coarse = createLoopDelayMeter(20)
    const fine = createLoopDelayMeter(5)
    expect(coarse).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const a = coarse?.read() ?? ZERO_LOOP_DELAY
    const b = fine?.read() ?? ZERO_LOOP_DELAY
    coarse?.stop()
    fine?.stop()
    // Well under the 20ms resolution, which uncorrected is the FLOOR of every
    // reading this histogram can produce.
    expect(a.p50Ms).toBeLessThan(10)
    // …and the discriminating half: two histograms watching the SAME loop must
    // agree. Uncorrected they differ by 20 − 5 = 15ms at every percentile, by
    // construction; corrected they describe one loop.
    expect(Math.abs(a.p50Ms - b.p50Ms)).toBeLessThan(5)
  })

  it('a REAL block is still reported, and two resolutions now agree on it', async () => {
    const coarse = createLoopDelayMeter(20)
    const fine = createLoopDelayMeter(5)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const until = Date.now() + 120
    while (Date.now() < until) {
      // block the loop
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const a = coarse?.read() ?? ZERO_LOOP_DELAY
    const b = fine?.read() ?? ZERO_LOOP_DELAY
    coarse?.stop()
    fine?.stop()
    expect(a.maxMs).toBeGreaterThan(90)
    expect(b.maxMs).toBeGreaterThan(90)
    // Uncorrected the two disagree by the difference of their resolutions;
    // corrected they describe the same event.
    expect(Math.abs(a.maxMs - b.maxMs)).toBeLessThan(25)
  })
})
