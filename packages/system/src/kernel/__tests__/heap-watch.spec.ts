import { describe, expect, it, vi } from 'vitest'

// The default RssAnon reader reads the HOST's /proc/self/status on Linux, so the
// gate would judge this machine's real anonymous memory instead of the
// `readMemory` fixture (macOS has no such split and keeps `rss`). The specs
// drive the gate with fixtures; pin the reader to the non-Linux answer so the
// result does not depend on the host. heap-reclaim-anon-rss.spec.ts covers the real reader.
vi.mock('../anon-rss.js', () => ({
  createAnonRssReader: (): (() => number | undefined) => () => undefined,
}))
import {
  buildHeapSample,
  createLoopDelayMeter,
  describeRss,
  HEAP_RECLAIM_MIN_INTERVAL_MS,
  HEAP_RECLAIM_TRIGGER_MB,
  HEAP_WATCH_DEESCALATE_RATIO,
  HEAP_WATCH_ESCALATE_RATIO,
  HEAP_WATCH_FAST_INTERVAL_MS,
  HEAP_WATCH_INTERVAL_MS,
  HEAP_WATCH_WARN_RATIO,
  heapCeilingOrigin,
  HUB_MAIN_RSS_BUDGET_MB,
  HUB_RSS_BUDGET_ENV,
  hubMainRssBudget,
  type LoopDelayMeter,
  type LoopDelaySample,
  nextMode,
  nextRssBudgetState,
  parseRssBudgetMb,
  RECLAIM_STEADY_STATE_PASSES,
  RSS_BUDGET_REANNOUNCE_MIN_MS,
  RUNNER_HEAP_WATCH_INTERVAL_MS,
  shouldReclaim,
  startHeapWatch,
  startRunnerHeapWatch,
  strandedMb,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

const MB = 1048576

function mem(over: Partial<NodeJS.MemoryUsage> = {}): NodeJS.MemoryUsage {
  return {
    rss: 2048 * MB,
    heapUsed: 600 * MB,
    heapTotal: 700 * MB,
    external: 400 * MB,
    arrayBuffers: 200 * MB,
    ...over,
  } as NodeJS.MemoryUsage
}

describe('heap sampling', () => {
  it('measures against the CEILING, not against heapTotal', () => {
    // hub-main runs with --max-old-space-size=1536. Comparing heapUsed to
    // heapTotal would read "86% full" while the process still had 900MB of
    // headroom, and would never warn at the moment that matters.
    const s = buildHeapSample(mem(), 1536 * MB)
    expect(s.heapLimitMb).toBe(1536)
    expect(s.usedRatio).toBeCloseTo(0.39, 2)
    expect(s.nearLimit).toBe(false)
  })

  it('warns once the heap approaches the ceiling', () => {
    const s = buildHeapSample(mem({ heapUsed: 1300 * MB }), 1536 * MB)
    expect(s.nearLimit).toBe(true)
    expect(s.usedRatio).toBeGreaterThanOrEqual(HEAP_WATCH_WARN_RATIO)
  })

  it('reports external and arrayBuffers, which the heap cap does NOT bound', () => {
    // Live hub-main: 1536MB cap but ~2.05GB RSS. Most of that gap is external
    // memory, so a report that omitted it would misread the process by ~500MB.
    const s = buildHeapSample(mem(), 1536 * MB)
    expect(s.externalMb).toBe(400)
    expect(s.arrayBuffersMb).toBe(200)
    expect(s.rssMb).toBeGreaterThan(s.heapLimitMb)
  })

  it('a missing heap limit never divides by zero', () => {
    expect(buildHeapSample(mem(), 0).usedRatio).toBe(0)
  })
})

describe('the heartbeat', () => {
  it('emits immediately, so a crash soon after boot still has one sample', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info, warn }, 60_000)
    try {
      // SAMPLES, not lines: boot also states the heap ceiling's origin once.
      const samples = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((l) => l.includes('rss='))
      expect(samples).toHaveLength(1)
      expect(samples[0]).toContain('[mem] hub-main')
    } finally {
      stop()
    }
  })

  it('keeps ticking, and stop() is idempotent', () => {
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info, warn }, 1_000)
    try {
      vi.advanceTimersByTime(3_000)
      expect(info.mock.calls.length + warn.mock.calls.length).toBeGreaterThanOrEqual(4)
    } finally {
      stop()
      expect(() => stop()).not.toThrow()
      vi.useRealTimers()
    }
  })
})

/**
 * The 2026-08-08 18:28:32Z fatal, as the watcher actually saw it.
 *
 * Last sample 18:27:30.433, `heapUsed=1086MB` (25%). FATAL 62 seconds later
 * with V8's own trace reading 4083MB. At a 60s interval there was NO sample in
 * between: the WARN this module exists to emit could not fire, because the
 * whole event fits inside one sampling gap. That is the defect these tests pin.
 */
const OOM_LAST_SAMPLE = mem({
  rss: 3178 * MB,
  heapUsed: 1086 * MB,
  heapTotal: 1258 * MB,
  external: 866 * MB,
  arrayBuffers: 622 * MB,
})
const HUB_HEAP_LIMIT = 4288 * MB

describe('escalation — the sampler must be able to SEE a sub-interval burst', () => {
  it('the 0.8 warn threshold sits above anything the 60s sampler has ever observed', () => {
    // 397 live samples on 2026-08-08: p50 1266MB, p95 1995MB, max 2847MB
    // (0.66 of the ceiling). A warn that only trips at 0.8 therefore never
    // trips in steady state — the only way to reach it is a burst, and a burst
    // is exactly what a 60s interval cannot catch. Escalation has to begin
    // ABOVE the routine max and BELOW the warn, or it is decoration.
    const routineMaxRatio = 2847 / 4288
    expect(HEAP_WATCH_ESCALATE_RATIO).toBeGreaterThan(routineMaxRatio)
    expect(HEAP_WATCH_ESCALATE_RATIO).toBeLessThan(HEAP_WATCH_WARN_RATIO)
    // Hysteresis, or the sawtooth flaps the mode every tick.
    expect(HEAP_WATCH_DEESCALATE_RATIO).toBeLessThan(HEAP_WATCH_ESCALATE_RATIO)
  })

  it('the fast interval brackets the gap the fatal hid in', () => {
    // The burst ran to completion inside 62s. Anything at or above ~60s cannot
    // place a single reading inside it.
    expect(HEAP_WATCH_FAST_INTERVAL_MS).toBeLessThan(62_000 / 10)
    expect(HEAP_WATCH_FAST_INTERVAL_MS).toBeLessThan(HEAP_WATCH_INTERVAL_MS)
  })

  it('stays steady through the routine sawtooth and escalates above it', () => {
    expect(nextMode('steady', 1266 / 4288)).toBe('steady')
    expect(nextMode('steady', 1995 / 4288)).toBe('steady')
    expect(nextMode('steady', 2847 / 4288)).toBe('steady')
    expect(nextMode('steady', 3200 / 4288)).toBe('escalated')
  })

  it('holds escalated across a dip, and only releases below the hysteresis floor', () => {
    expect(nextMode('escalated', 2900 / 4288)).toBe('escalated')
    expect(nextMode('escalated', 2000 / 4288)).toBe('steady')
  })

  it('samples the climb at fast cadence instead of missing it entirely', () => {
    // The discriminating test. Replay the fatal: one routine reading, then a
    // climb that would have run to the ceiling inside a single 60s gap. With
    // a fixed 60s interval this produces ONE line; the trajectory is invisible
    // and every hypothesis about it stays unfalsifiable.
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    const climb = [
      OOM_LAST_SAMPLE,
      mem({ heapUsed: 3100 * MB, heapTotal: 3200 * MB }),
      mem({ heapUsed: 3500 * MB, heapTotal: 3600 * MB }),
      mem({ heapUsed: 3900 * MB, heapTotal: 4000 * MB }),
      mem({ heapUsed: 4080 * MB, heapTotal: 4100 * MB }),
    ]
    let i = 0
    const stop = startHeapWatch('hub-main', { info, warn }, HEAP_WATCH_INTERVAL_MS, {
      reclaim: vi.fn(),
      readMemory: () => climb[Math.min(i++, climb.length - 1)]!,
      heapLimitBytes: HUB_HEAP_LIMIT,
    })
    try {
      // Well inside ONE steady-state interval.
      vi.advanceTimersByTime(HEAP_WATCH_INTERVAL_MS - 1_000)
      const lines = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0]))
      const samples = lines.filter((l) => l.includes('[mem] hub-main'))
      expect(samples.length).toBeGreaterThan(4)
      // and the ones above the warn ratio are shouted, not buried at info
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'APPROACHING HEAP LIMIT',
      )
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('a flat routine heap still logs at the SLOW cadence — escalation is not always-on', () => {
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info, warn }, HEAP_WATCH_INTERVAL_MS, {
      reclaim: vi.fn(),
      readMemory: () => mem({ heapUsed: 1266 * MB }),
      heapLimitBytes: HUB_HEAP_LIMIT,
    })
    try {
      vi.advanceTimersByTime(HEAP_WATCH_INTERVAL_MS - 1_000)
      // The immediate boot sample, and nothing else. A watcher that escalated
      // on the routine p50 would put 30 lines a minute in the log forever.
      const samples = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((l) => l.includes('rss='))
      expect(samples).toHaveLength(1)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})

/**
 * The numbers below are the LIVE hub readings from 2026-08-08, before and after
 * one forced `gc({ flavor: 'last-resort' })` on the production hub. They are the
 * whole justification for this feature, so they are the fixture: a threshold
 * that does not separate these two states is the wrong threshold.
 */
const LIVE_BEFORE = mem({
  rss: 3355 * MB,
  heapUsed: 695 * MB,
  heapTotal: 955 * MB,
  external: 169 * MB,
  arrayBuffers: 28 * MB,
})
const LIVE_AFTER = mem({
  rss: 1237 * MB,
  heapUsed: 651 * MB,
  heapTotal: 671 * MB,
  external: 148 * MB,
  arrayBuffers: 7 * MB,
})

describe('stranded-page reclaim', () => {
  it('measures what is stranded: RSS minus what the process is actually USING', () => {
    // heapTOTAL is the wrong subtrahend — the pages V8 committed and no longer
    // uses are exactly the thing being measured, and they are inside heapTotal.
    expect(strandedMb(buildHeapSample(LIVE_BEFORE, 4288 * MB))).toBe(3355 - 695 - 169)
    expect(strandedMb(buildHeapSample(LIVE_AFTER, 4288 * MB))).toBe(1237 - 651 - 148)
  })

  it('fires on the live pre-reclaim reading and NOT on the post-reclaim one', () => {
    // 2.1GB was returned to the OS by the real call. If the threshold cannot
    // tell these two apart the watcher either never fires or never stops.
    expect(shouldReclaim(buildHeapSample(LIVE_BEFORE, 4288 * MB))).toBe(true)
    expect(shouldReclaim(buildHeapSample(LIVE_AFTER, 4288 * MB))).toBe(false)
  })

  it('leaves a healthy floor alone — a reclaim that always fires is a 300ms stall every minute', () => {
    // ~440MB of native residue (sqlite, libvips, sharp, thread stacks, node's
    // own text) is this process's irreducible floor, not something to collect.
    expect(HEAP_RECLAIM_TRIGGER_MB).toBeGreaterThan(438)
  })

  it('runs the reclaimer when the sample qualifies, and reports what it returned', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const reclaim = vi.fn()
    const readings = [LIVE_BEFORE, LIVE_AFTER]
    let i = 0
    const stop = startHeapWatch('hub-main', { info, warn }, 60_000, {
      reclaim,
      readMemory: () => readings[Math.min(i++, readings.length - 1)]!,
      heapLimitBytes: 4288 * MB,
    })
    try {
      expect(reclaim).toHaveBeenCalledTimes(1)
      const reported = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n')
      expect(reported).toContain('[mem] reclaim')
      // A reclaim nobody can measure is indistinguishable from one that did
      // nothing — the before/after RSS has to be in the line.
      expect(reported).toContain('3355')
      expect(reported).toContain('1237')
    } finally {
      stop()
    }
  })

  it('never reclaims twice inside the minimum interval', () => {
    vi.useFakeTimers()
    const reclaim = vi.fn()
    const stop = startHeapWatch('hub-main', { info: vi.fn(), warn: vi.fn() }, 1_000, {
      reclaim,
      readMemory: () => LIVE_BEFORE,
      heapLimitBytes: 4288 * MB,
    })
    try {
      vi.advanceTimersByTime(HEAP_RECLAIM_MIN_INTERVAL_MS - 2_000)
      expect(reclaim).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(4_000)
      expect(reclaim).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  /**
   * Live hub, 2026-08-17, one reclaim on the record:
   *
   *   [mem] reclaim hub-main stranded=2365MB rss=4016MB→2368MB freed=1648MB took=654ms
   *
   * with `heapUsed` flat at 1.3-1.7GB across the surrounding samples while RSS
   * sat at 3.7-4.2GB. The host it runs on has NO swap and is OOM-killing a
   * neighbouring VM, so RSS the process is not using is not free — it is the
   * headroom something else needed.
   */
  const STRANDED_2365 = mem({ rss: 4016 * MB, heapUsed: 1500 * MB, external: 151 * MB })

  /** Halfway back up the ratchet: 1120MB stranded, ~2.5x the 438MB native floor. */
  const STRANDED_1120 = mem({ rss: 2771 * MB, heapUsed: 1500 * MB, external: 151 * MB })

  /** Immediately after a reclaim: the irreducible native floor, nothing to collect. */
  const STRANDED_AT_FLOOR = mem({ rss: 2089 * MB, heapUsed: 1500 * MB, external: 151 * MB })

  it('reclaims a mid-band strand instead of waiting for the ratchet to finish', () => {
    // A GiB of RSS the process is provably not using is worth one 650ms stall
    // on a box with no swap. Waiting until it is 1.5GiB means the peak — which
    // is what triggers the OOM — is 1.5GiB higher than it needs to be.
    expect(strandedMb(buildHeapSample(STRANDED_1120, 4288 * MB))).toBe(1120)
    expect(shouldReclaim(buildHeapSample(STRANDED_1120, 4288 * MB))).toBe(true)
  })

  it('still leaves the irreducible native floor alone', () => {
    // Reclaiming against ~438MB of sqlite pages, libvips, sharp and thread
    // stacks buys nothing and costs a stall every time it is sampled.
    expect(strandedMb(buildHeapSample(STRANDED_AT_FLOOR, 4288 * MB))).toBe(438)
    expect(shouldReclaim(buildHeapSample(STRANDED_AT_FLOOR, 4288 * MB))).toBe(false)
  })

  it('keeps up with a process that re-strands — the cadence bounds the PEAK, not the average', () => {
    vi.useFakeTimers()
    const reclaim = vi.fn()
    // Never falls back below the trigger: the worst case the floor has to
    // survive, and the case where a lazy floor lets the peak stand for minutes.
    const stop = startHeapWatch('hub-main', { info: vi.fn(), warn: vi.fn() }, 60_000, {
      reclaim,
      readMemory: () => STRANDED_2365,
      heapLimitBytes: 4288 * MB,
    })
    try {
      vi.advanceTimersByTime(10 * 60_000)
      // Ten minutes of a continuously stranded process must produce more than
      // the two passes a ten-minute floor allows.
      expect(reclaim.mock.calls.length).toBeGreaterThanOrEqual(5)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('a reclaimer that throws never takes down the process it is protecting', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info, warn }, 60_000, {
      reclaim: () => {
        throw new Error('v8 said no')
      },
      readMemory: () => LIVE_BEFORE,
      heapLimitBytes: 4288 * MB,
    })
    try {
      // Silence would read as "it was never needed" — the failure is on the record.
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('reclaim failed')
    } finally {
      expect(() => stop()).not.toThrow()
    }
  })

  it('with no reclaimer configured the heartbeat is exactly what it was before', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info, warn }, 60_000)
    try {
      const reported = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n')
      expect(reported).toContain('[mem] hub-main')
      expect(reported).not.toContain('[mem] reclaim')
    } finally {
      stop()
    }
  })
})

/**
 * The recorder runner measured 2122MB RSS against a ~50MB retained index — the
 * same stranded-pages shape hub-main had. Every heavy runner now carries an
 * old-space ceiling, and that does not retire this mechanism: what strands in
 * these processes is NATIVE (`external`, `arrayBuffers`, glibc arena free
 * lists), which no V8 flag bounds — `hub/pipeline-analytics` stranded 2552MB on
 * an 81MB heap under a ceiling that was in force throughout. hub-main's
 * reclaimer is proven live (11 passes in 4h, 375–1652MB back per pass), so
 * heavy runners get THAT mechanism — never a second one.
 */
describe('per-runner heap watch — heavy runners inherit the hub-main reclaimer', () => {
  it('a light runner starts NOTHING — a quiet runner never pays', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'light',
      label: 'hub/provider-rtsp',
      sink: { info, warn },
    })
    expect(stop).toBeUndefined()
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('an UNDECLARED profile starts nothing — the un-annotated default is light', () => {
    const stop = startRunnerHeapWatch({
      heapProfile: undefined,
      label: 'hub/some-addon',
      sink: { info: vi.fn(), warn: vi.fn() },
    })
    expect(stop).toBeUndefined()
  })

  it('a heavy runner runs the SAME stranded-over-trigger reclaim hub-main proved', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const reclaim = vi.fn()
    const readings = [LIVE_BEFORE, LIVE_AFTER]
    let i = 0
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/recorder',
      sink: { info, warn },
      reclaimOptions: {
        reclaim,
        readMemory: () => readings[Math.min(i++, readings.length - 1)]!,
        heapLimitBytes: 4288 * MB,
      },
    })
    try {
      expect(stop).toBeDefined()
      expect(reclaim).toHaveBeenCalledTimes(1)
      const reported = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n')
      // The label is the runner's nodeId, so the reclaim line groups per runner.
      expect(reported).toContain('[mem] reclaim hub/recorder')
    } finally {
      stop?.()
    }
  })

  it('a heavy runner at its native floor never pays a pass — the gate is the same trigger', () => {
    const reclaim = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/stream-broker',
      sink: { info: vi.fn(), warn: vi.fn() },
      reclaimOptions: {
        reclaim,
        readMemory: () => LIVE_AFTER,
        heapLimitBytes: 4288 * MB,
      },
    })
    try {
      expect(reclaim).not.toHaveBeenCalled()
    } finally {
      stop?.()
    }
  })

  it('CAMSTACK_RUNNER_HEAP_RECLAIM=off keeps the heartbeat and disables only the pass', () => {
    // The operator kill-switch for the media path: if a pass ever misbehaves in
    // a runner that finalizes segments, recovery must not need a rebuild.
    const info = vi.fn()
    const warn = vi.fn()
    const reclaim = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/recorder',
      sink: { info, warn },
      reclaimSwitch: 'off',
      reclaimOptions: {
        reclaim,
        readMemory: () => LIVE_BEFORE,
        heapLimitBytes: 4288 * MB,
      },
    })
    try {
      expect(stop).toBeDefined()
      expect(reclaim).not.toHaveBeenCalled()
      const reported = [...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n')
      expect(reported).toContain('[mem] hub/recorder')
      expect(reported).not.toContain('[mem] reclaim')
    } finally {
      stop?.()
    }
  })

  it('the runner heartbeat is slower than hub-main — many runners share ONE log stream', () => {
    // ~7 heavy runners at hub-main's 60s cadence would be 7 lines/min of
    // routine forever; the reclaim gate runs on the PROBE cadence either way,
    // so a slower steady heartbeat costs no reclaim latency.
    expect(RUNNER_HEAP_WATCH_INTERVAL_MS).toBeGreaterThan(HEAP_WATCH_INTERVAL_MS)
  })
})

/**
 * ## The stall was priced without ever measuring what it delays
 *
 * The reclaim pass is a stop-the-world on hub-main, and hub-main's event loop is
 * the cluster's ONLY queue (D181): every settings read from every runner and
 * every agent, every UDS handshake, every cross-runner cap call is served on it.
 * Measured live 2026-08-25 over 55 minutes: a reclaim every ~2 min, `took=`
 * 556-695ms (one at 2009ms) — and not one line in the record said what the loop
 * was doing on either side of it.
 *
 * `took=` prices the PASS. It cannot answer the question the operator actually
 * asks, which is whether 104ms per 120s is material against a loop that D181
 * profiled at 0.1% idle. So the heartbeat now carries the loop's own delay over
 * the window since the previous line: a 104ms pass against a p99 of 4ms is a
 * visible stall, and the same pass against a p99 of 900ms is noise inside a
 * queue that was already saturated. Those are opposite conclusions and the log
 * could not distinguish them.
 */
describe('event-loop delay — pricing the stall against the queue it stalls', () => {
  function fakeMeter(samples: readonly LoopDelaySample[]): {
    readonly meter: LoopDelayMeter
    readonly reads: () => number
  } {
    let i = 0
    return {
      meter: {
        read: () => samples[Math.min(i++, samples.length - 1)]!,
        stop: () => undefined,
      },
      reads: () => i,
    }
  }

  it('the heartbeat carries the loop delay for the window it covers', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const { meter } = fakeMeter([{ p50Ms: 3, p99Ms: 41, maxMs: 102 }])
    const stop = startHeapWatch('hub-main', { info, warn }, 60_000, undefined, meter)
    try {
      const line = String(info.mock.calls[0]?.[0] ?? warn.mock.calls[0]?.[0])
      expect(line).toContain('loopP50=3ms')
      expect(line).toContain('loopP99=41ms')
      expect(line).toContain('loopMax=102ms')
    } finally {
      stop()
    }
  })

  it('reads the meter ONCE PER LINE, not once per probe — the window is the line', () => {
    // Probe and log cadences are deliberately different (see startHeapWatch).
    // Reading — which resets the histogram — on every 2s probe would throw away
    // the 58 seconds the line is supposed to describe, and the reported max
    // would be the max of the last 2s. That is a different number wearing the
    // same name.
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    const { meter, reads } = fakeMeter([{ p50Ms: 1, p99Ms: 2, maxMs: 3 }])
    const stop = startHeapWatch('hub-main', { info, warn }, 60_000, undefined, meter)
    try {
      vi.advanceTimersByTime(59_000) // ~29 probes, still inside the first line
      expect(reads()).toBe(1)
      vi.advanceTimersByTime(2_000) // the second line is now due
      expect(reads()).toBe(2)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('stops the meter when the watch stops — a histogram left enabled is a leak', () => {
    const stopMeter = vi.fn()
    const meter: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: stopMeter }
    const stop = startHeapWatch(
      'hub-main',
      { info: vi.fn(), warn: vi.fn() },
      60_000,
      undefined,
      meter,
    )
    stop()
    expect(stopMeter).toHaveBeenCalledTimes(1)
    stop()
    expect(stopMeter).toHaveBeenCalledTimes(1)
  })

  it('the real meter reports zeros before the loop has turned, never a sentinel', () => {
    // An empty IntervalHistogram answers `min = 9223372036854776000`. A line
    // reading `loopMax=9223372036854ms` would be read as a catastrophe on the
    // first heartbeat of every boot.
    const meter = createLoopDelayMeter()
    expect(meter).toBeDefined()
    try {
      const s = meter!.read()
      expect(s.p50Ms).toBeGreaterThanOrEqual(0)
      expect(s.p99Ms).toBeLessThan(60_000)
      expect(s.maxMs).toBeLessThan(60_000)
    } finally {
      meter?.stop()
    }
  })
})

/**
 * ## A safety net that fires every time it is allowed to is not a safety net
 *
 * `HEAP_RECLAIM_MIN_INTERVAL_MS` was chosen as a FLOOR for a burst, on the
 * measured assumption that re-stranding the trigger takes ~20 minutes. Live
 * 2026-08-25 it takes under two: 13 passes in 30 minutes, every one of them at
 * the floor. The pass is no longer an exception the process reaches under load —
 * it is part of steady state, and the record never says so, because every
 * individual line looks exactly like the rare pass the design intended.
 */
describe('a permanently satisfied trigger says so', () => {
  /** The live shape: ~1.7GiB stranded again within one floor period, forever. */
  const ALWAYS_STRANDED = mem({ rss: 3500 * MB, heapUsed: 1200 * MB, external: 340 * MB })

  it('the FIRST passes stay quiet — a bounded burst is what the design is for', () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info: vi.fn(), warn }, 60_000, {
      reclaim: () => undefined,
      readMemory: () => ALWAYS_STRANDED,
      heapLimitBytes: HUB_HEAP_LIMIT,
    })
    try {
      vi.advanceTimersByTime(HEAP_RECLAIM_MIN_INTERVAL_MS * (RECLAIM_STEADY_STATE_PASSES - 2))
      const steady = warn.mock.calls.map((c) => String(c[0])).filter((l) => /steady state/i.test(l))
      expect(steady).toHaveLength(0)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('warns once the pass has fired at the floor for long enough to BE steady state', () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const stop = startHeapWatch('hub-main', { info: vi.fn(), warn }, 60_000, {
      reclaim: () => undefined,
      readMemory: () => ALWAYS_STRANDED,
      heapLimitBytes: HUB_HEAP_LIMIT,
    })
    try {
      vi.advanceTimersByTime(HEAP_RECLAIM_MIN_INTERVAL_MS * (RECLAIM_STEADY_STATE_PASSES + 1))
      const steady = warn.mock.calls.map((c) => String(c[0])).filter((l) => /steady state/i.test(l))
      expect(steady.length).toBeGreaterThanOrEqual(1)
      // The line has to carry the run length, or "is this new?" has no answer.
      expect(steady[0]).toContain(`${RECLAIM_STEADY_STATE_PASSES}`)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('a pass that had to WAIT for the strand to re-form resets the run', () => {
    // The distinction the warn exists to make: firing every floor period is
    // steady state; firing once an hour is the safety net behaving as designed.
    vi.useFakeTimers()
    const warn = vi.fn()
    let stranded = true
    const stop = startHeapWatch('hub-main', { info: vi.fn(), warn }, 60_000, {
      reclaim: () => {
        stranded = false
      },
      readMemory: () =>
        stranded
          ? ALWAYS_STRANDED
          : mem({ rss: 1900 * MB, heapUsed: 1200 * MB, external: 340 * MB }),
      heapLimitBytes: HUB_HEAP_LIMIT,
    })
    try {
      for (let i = 0; i < RECLAIM_STEADY_STATE_PASSES * 3; i += 1) {
        stranded = true
        vi.advanceTimersByTime(HEAP_RECLAIM_MIN_INTERVAL_MS * 4)
      }
      const steady = warn.mock.calls.map((c) => String(c[0])).filter((l) => /steady state/i.test(l))
      expect(steady).toHaveLength(0)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})

/**
 * ## hub-main is the one process whose ceiling nobody chose, and nothing said so
 *
 * Every forked runner carries V8 heap flags from `process-service.ts`
 * (`--max-old-space-size` on heavy, `--max-semi-space-size` on light). hub-main
 * carries none: `docker-entrypoint.sh` only adds `--max-old-space-size` when
 * `CAMSTACK_HUB_HEAP_MB` is set, and it is not set on the live container —
 * verified 2026-08-25 by reading pid 7's argv, which is a bare
 * `node .../starter.js`. The ceiling in force is therefore whatever V8 derives
 * from the host (4288MB here), and the ONLY record of that choice is a comment
 * in an image nobody rebuilds to read.
 *
 * That is a fact about the running process, so it belongs in the running
 * process's log. `execArgv` carries node's own options, so the question is
 * answerable at boot for free — and answering it once, at boot, is the
 * difference between "the operator can see the hub has no cap" and "someone has
 * to exec into the container to find out".
 */
describe('the heap ceiling says whether anyone CHOSE it', () => {
  it('an explicit --max-old-space-size is an explicit ceiling', () => {
    expect(heapCeilingOrigin(['--max-old-space-size=3072'])).toBe('explicit')
    expect(heapCeilingOrigin(['--max-semi-space-size=2', '--max-old-space-size=1024'])).toBe(
      'explicit',
    )
    // The space-separated spelling is the same flag.
    expect(heapCeilingOrigin(['--max-old-space-size', '2048'])).toBe('explicit')
    // …and so is the underscore alias node accepts.
    expect(heapCeilingOrigin(['--max_old_space_size=2048'])).toBe('explicit')
  })

  it('a young-generation cap alone is NOT an old-space ceiling', () => {
    // Light runners carry only --max-semi-space-size. Counting that as a chosen
    // ceiling would mean the line never fires on the processes that lack one.
    expect(heapCeilingOrigin(['--max-semi-space-size=2'])).toBe('v8-default')
  })

  it('a bare argv is V8 deciding, not the operator', () => {
    expect(heapCeilingOrigin([])).toBe('v8-default')
  })

  it('says so ONCE at boot, and never again — this is a boot fact', () => {
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub-main',
      { info, warn },
      1_000,
      undefined,
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
    )
    try {
      vi.advanceTimersByTime(10_000)
      const said = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((l) => l.includes('ceiling'))
      expect(said).toHaveLength(1)
      // The number has to be in it: "no cap" without the ceiling in force is
      // not actionable, and the ceiling is host-derived so it cannot be assumed.
      expect(said[0]).toMatch(/\d+MB/)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('names WHO chose the ceiling when the launcher said so (ADR 0970)', () => {
    vi.stubEnv('CAMSTACK_HEAP_CEILING_SOURCE', 'override')
    const info = vi.fn()
    const stop = startHeapWatch(
      'agent-main',
      { info, warn: vi.fn() },
      60_000,
      undefined,
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      ['--max-old-space-size=3072'],
    )
    try {
      const said = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ceiling'))
      expect(said).toHaveLength(1)
      expect(said[0]).toMatch(/heap ceiling = \d+MB, set by override/)
    } finally {
      stop()
      vi.unstubAllEnvs()
    }
  })

  it('a forked runner inheriting the env never claims the launcher chose ITS ceiling', () => {
    vi.stubEnv('CAMSTACK_HEAP_CEILING_SOURCE', 'override')
    const info = vi.fn()
    const stop = startHeapWatch(
      'recorder',
      { info, warn: vi.fn() },
      60_000,
      undefined,
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      ['--max-old-space-size=1024'],
    )
    try {
      expect(
        info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ceiling')),
      ).toHaveLength(0)
    } finally {
      stop()
      vi.unstubAllEnvs()
    }
  })

  it('the V8-default line carries the source too', () => {
    vi.stubEnv('CAMSTACK_HEAP_CEILING_SOURCE', 'v8-default')
    const info = vi.fn()
    const stop = startHeapWatch(
      'hub-main',
      { info, warn: vi.fn() },
      60_000,
      undefined,
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
    )
    try {
      expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/set by v8-default/)
    } finally {
      stop()
      vi.unstubAllEnvs()
    }
  })

  it('a process that WAS given a ceiling stays quiet', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'recorder',
      { info, warn },
      60_000,
      undefined,
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      ['--max-old-space-size=1024'],
    )
    try {
      const said = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((l) => l.includes('ceiling'))
      expect(said).toHaveLength(0)
    } finally {
      stop()
    }
  })
})

/**
 * ## …and a runner's MISSING ceiling is now an omission, not a declaration
 *
 * This line was silenced for runners on 2026-08-25 because it fired for
 * `hub/stream-broker` saying "Nothing here CHOSE that number" when something
 * had: the media path declared `execution.maxOldSpaceMb: 0` on purpose, after a
 * flat 1024MB cap killed recording twice.
 *
 * Later the same day that declaration was retired. 1024MB had not been "a cap",
 * it was a cap set BELOW the recorder's real working set (peak 1647MB heapUsed),
 * and `0` never meant "no ceiling" either — it selected V8's host-derived
 * 4288MB default, a number nothing in this repo chose. Every media addon now
 * declares a ceiling measured from its own peak, so no shipped manifest can
 * produce a runner without `--max-old-space-size` on argv.
 *
 * Which makes the absence informative again: it means the manifest drifted or
 * the runner is executing a stale deploy. The line is the only place either
 * would surface.
 */
describe('the ceiling line fires wherever no ceiling reached argv', () => {
  it('a heavy runner with NO ceiling on argv says so — no shipped manifest produces one', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/stream-broker',
      sink: { info, warn },
      reclaimOptions: { reclaim: vi.fn(), readMemory: () => mem(), heapLimitBytes: 4288 * MB },
    })
    try {
      const said = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((l) => l.includes('ceiling'))
      expect(said).toHaveLength(1)
    } finally {
      stop?.()
    }
  })

  it('hub-main still asks, because nothing upstream of it can declare one', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub-main',
      { info, warn },
      60_000,
      undefined,
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
    )
    try {
      const said = [...info.mock.calls, ...warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((l) => l.includes('ceiling'))
      expect(said).toHaveLength(1)
    } finally {
      stop()
    }
  })
})

/**
 * ## The growth that killed the host is the growth this module SUBTRACTS
 *
 * 2026-08-27 14:57Z the host's GLOBAL OOM killer took `hub/pipeline-analytics`
 * at 11.4GB of anon-rss (`dmesg`: `total-vm:13708084kB anon-rss:11397408kB`),
 * and every runner in the container recorded `loopMax` 152-158s in the same
 * sample — a ~154 second stall of the whole container. The profile of that
 * process shortly before:
 *
 *     rss=5735MB heapUsed=536MB external=4264MB arrayBuffers=2315MB
 *
 * **96% of the growth was never V8 heap**, and the watcher emitted not one
 * warning line in the whole climb.
 *
 * It could not. `strandedMb` is `rss − heapUsed − external`, so a process that
 * grows purely in `external` moves `rss` and the subtrahend by the SAME amount:
 * the number the alarm is built on is algebraically constant while the process
 * triples. That is not a threshold set too high — it is a quantity that cannot
 * represent the event.
 *
 * These tests pin both halves: the blindness (so nobody re-derives the alarm
 * from `strandedMb`), and the budget check that actually sees it.
 */
describe('a load that grows ONLY in external', () => {
  /**
   * The measured climb, in the shape it really had: `heapUsed` flat at its
   * floor, every added byte landing in `external`/`arrayBuffers`, `rss`
   * following one-for-one. This is `hub/pipeline-analytics` fetching a full
   * frame plus two copies per detection to iterate an array the only emitter
   * fills with `[]` (load ledger, defect 1).
   */
  const externalOnlyClimb = (externalMbNow: number): NodeJS.MemoryUsage =>
    mem({
      rss: (500 + externalMbNow) * MB,
      heapUsed: 536 * MB,
      heapTotal: 600 * MB,
      external: externalMbNow * MB,
      arrayBuffers: Math.round(externalMbNow * 0.54) * MB,
    })

  it('is INVISIBLE to stranded — the number is constant while rss quadruples', () => {
    const limit = 1024 * MB
    const early = buildHeapSample(externalOnlyClimb(200), limit)
    const late = buildHeapSample(externalOnlyClimb(4264), limit)

    // rss went from 700MB to 4764MB…
    expect(late.rssMb - early.rssMb).toBe(4064)
    // …and the quantity the alarm was built on did not move at all.
    expect(strandedMb(early)).toBe(strandedMb(late))
    // Nor could a lower trigger have helped: it is BELOW the trigger the whole
    // way, so no threshold on this number fires on this event.
    expect(shouldReclaim(late, HEAP_RECLAIM_TRIGGER_MB)).toBe(false)
    // The heap ceiling cannot see it either — 536MB of a 1024MB old space.
    expect(late.nearLimit).toBe(false)
  })

  it('WARNS against a declared RSS budget, which is the only number that moved', () => {
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    let externalMbNow = 200
    const stop = startHeapWatch(
      'hub/pipeline-analytics',
      { info, warn },
      60_000,
      {
        reclaim: () => undefined,
        readMemory: () => externalOnlyClimb(externalMbNow),
        heapLimitBytes: 1024 * MB,
      },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      ['--max-old-space-size=1024'],
      true,
      { budgetMb: 2048, source: 'manifest execution.rssBudgetMb' },
    )
    try {
      // Below budget: nothing to say.
      vi.advanceTimersByTime(10_000)
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /RSS BUDGET/.test(l))).toEqual(
        [],
      )

      // The climb the host died on.
      externalMbNow = 4264
      vi.advanceTimersByTime(10_000)
      const over = warn.mock.calls.map((c) => String(c[0])).filter((l) => /RSS BUDGET/.test(l))
      expect(over).toHaveLength(1)
      expect(over[0]).toContain('rss=4764MB')
      expect(over[0]).toContain('budget=2048MB')
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})

/**
 * ## The line has to say WHICH KIND of growth it is
 *
 * `smaps` on three live processes on 2026-08-27 found three different shapes,
 * and each one has a different lever — two of which cannot work on the others:
 *
 *   hub/recorder       1509.8MB in V8 256KB pages,  53.9MB brk  → v8-heap
 *   hub/stream-broker    242.6MB V8 pages,        1159.1MB brk  → external
 *   hub-main           1295.1MB V8 pages, 2.7GB in 13 anon maps → native-residue
 *
 * "It is big" leaves the operator choosing between them. The share of RSS each
 * part holds decides it on sight.
 */
describe('the breakdown names the shape', () => {
  it('the recorder is V8 heap — live retainers under an old-space ceiling', () => {
    const b = describeRss(
      buildHeapSample(mem({ rss: 1700 * MB, heapUsed: 1519 * MB, external: 8 * MB }), 3072 * MB),
      3584,
    )
    expect(b.shape).toBe('v8-heap')
    // Within budget: `overMb` must not go negative, or the line reads as a fault.
    expect(b.overMb).toBe(0)
  })

  it('stream-broker is external — Buffers no V8 flag has ever bounded', () => {
    const b = describeRss(
      buildHeapSample(
        mem({ rss: 1585 * MB, heapUsed: 224 * MB, external: 900 * MB, arrayBuffers: 829 * MB }),
        1024 * MB,
      ),
      2048,
    )
    expect(b.shape).toBe('external')
  })

  it('hub-main is native residue — freed memory the allocator kept', () => {
    const b = describeRss(
      buildHeapSample(mem({ rss: 4870 * MB, heapUsed: 1295 * MB, external: 360 * MB }), 3072 * MB),
      4096,
    )
    expect(b.shape).toBe('native-residue')
    expect(b.nativeResidueMb).toBe(3215)
    expect(b.overMb).toBe(774)
  })

  it('never reports a negative residue — the fields are read at different instants', () => {
    // heapUsed + external briefly exceeding rss is a sampling artefact, not a
    // process that owes memory; a negative residue would also misclassify it.
    const b = describeRss(
      buildHeapSample(mem({ rss: 100 * MB, heapUsed: 90 * MB, external: 60 * MB }), 1024 * MB),
      512,
    )
    expect(b.nativeResidueMb).toBe(0)
    expect(b.shape).toBe('v8-heap')
  })

  it('carries the shares and the source, because the shares ARE the diagnosis', () => {
    // The real profile: 9% heap / 74% external / 16% residue names the answer.
    const info = vi.fn()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub/pipeline-analytics',
      { info, warn },
      60_000,
      {
        reclaim: () => undefined,
        readMemory: () =>
          mem({
            rss: 5735 * MB,
            heapUsed: 536 * MB,
            external: 4264 * MB,
            arrayBuffers: 2315 * MB,
          }),
        heapLimitBytes: 1024 * MB,
      },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      ['--max-old-space-size=1024'],
      true,
      { budgetMb: 2048, source: 'manifest execution.rssBudgetMb' },
    )
    try {
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => /RSS BUDGET/.test(l))
      expect(line).toBeDefined()
      expect(line).toContain('shape=external')
      expect(line).toContain('heapUsed=536MB(9%)')
      expect(line).toContain('external=4264MB(74%)')
      expect(line).toContain('nativeResidue=935MB(16%)')
      // Which lever applies — the whole reason the shape is on the line.
      expect(line).toContain('NO V8 flag bounds this')
      // A budget that is wrong has to be traceable to whoever wrote it.
      expect(line).toContain('manifest execution.rssBudgetMb')
    } finally {
      stop()
    }
  })
})

/**
 * ## A watchdog that shouts is a watchdog that gets muted
 *
 * On 2026-08-27 two genuine alarms (`io/active`, device 3839) sat under 83,198
 * Hikvision heartbeat lines in 12 hours. The probe here runs every
 * `HEAP_WATCH_FAST_INTERVAL_MS`, so warning per SAMPLE would put 30 lines a
 * minute in the hub's shared log for a process that is legitimately large — and
 * the next real alarm would be buried the same way.
 */
describe('the budget alarm is a state change, not a level', () => {
  const OVER = mem({ rss: 5000 * MB, heapUsed: 500 * MB, external: 4000 * MB })

  it('says it ONCE, however long the process stays over', () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const stop = startHeapWatch(
      'hub/pipeline-analytics',
      { info: vi.fn(), warn },
      60_000,
      { reclaim: () => undefined, readMemory: () => OVER, heapLimitBytes: 1024 * MB },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
      false,
      { budgetMb: 2048, source: 'test' },
    )
    try {
      // An hour of probes at the fast cadence — 1800 samples, all over budget.
      vi.advanceTimersByTime(3_600_000)
      const over = warn.mock.calls.map((c) => String(c[0])).filter((l) => /RSS BUDGET/.test(l))
      expect(over).toHaveLength(1)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('does not flap on a process sawtoothing at the edge', () => {
    // Hysteresis: coming back under the budget by 1MB is not a recovery.
    expect(nextRssBudgetState('over', 2040, 2048)).toBe('over')
    expect(nextRssBudgetState('over', 1800, 2048)).toBe('within')
    expect(nextRssBudgetState('within', 2048, 2048)).toBe('within')
    expect(nextRssBudgetState('within', 2049, 2048)).toBe('over')
  })

  it('a genuine swing across the budget is ONE story per quarter-hour', () => {
    // The reclaim pass moves hub-main by ~1.6GB and may run every 2 minutes, so
    // hysteresis alone would still allow 30 pairs of lines an hour, forever.
    vi.useFakeTimers()
    const warn = vi.fn()
    let over = true
    const stop = startHeapWatch(
      'hub-main',
      { info: vi.fn(), warn },
      60_000,
      {
        reclaim: () => undefined,
        readMemory: () =>
          over ? OVER : mem({ rss: 1000 * MB, heapUsed: 500 * MB, external: 400 * MB }),
        heapLimitBytes: 4288 * MB,
      },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
      false,
      { budgetMb: 2048, source: 'test' },
    )
    try {
      // Ten full swings inside one re-announce window.
      for (let i = 0; i < 10; i += 1) {
        over = true
        vi.advanceTimersByTime(30_000)
        over = false
        vi.advanceTimersByTime(30_000)
      }
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /RSS BUDGET/.test(l))
      expect(lines).toHaveLength(1)
      expect(RSS_BUDGET_REANNOUNCE_MIN_MS).toBeGreaterThan(HEAP_RECLAIM_MIN_INTERVAL_MS)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('pairs a recovery with the warning that was actually said, and never alone', () => {
    vi.useFakeTimers()
    const info = vi.fn()
    const warn = vi.fn()
    let rssMb = 5000
    const stop = startHeapWatch(
      'hub-main',
      { info, warn },
      60_000,
      {
        reclaim: () => undefined,
        readMemory: () => mem({ rss: rssMb * MB, heapUsed: 500 * MB, external: 400 * MB }),
        heapLimitBytes: 4288 * MB,
      },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
      false,
      { budgetMb: 2048, source: 'test' },
    )
    try {
      vi.advanceTimersByTime(10_000)
      const over = warn.mock.calls.map((c) => String(c[0])).filter((l) => /RSS BUDGET/.test(l))
      expect(over).toHaveLength(1)
      rssMb = 900
      vi.advanceTimersByTime(10_000)
      const back = info.mock.calls.map((c) => String(c[0])).filter((l) => /back within/.test(l))
      expect(back).toHaveLength(1)
      expect(back[0]).toContain('rss=900MB')
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})

/**
 * ## A process with no budget is UNWATCHED, and says so
 *
 * The alternative — a class default — would be the same mistake in a new place:
 * a number nobody measured, applied to a process nobody profiled, producing
 * silence or noise with equal authority. Measurements exist for four processes,
 * so four processes carry a budget and the rest declare their own blindness.
 */
describe('an undeclared budget is declared', () => {
  it('a heavy runner whose manifests declare nothing announces it at boot', () => {
    const info = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/decoder-nodeav',
      sink: { info, warn: vi.fn() },
      reclaimOptions: { reclaim: vi.fn(), readMemory: () => mem(), heapLimitBytes: 4288 * MB },
    })
    try {
      const said = info.mock.calls.map((c) => String(c[0])).filter((l) => /NOT WATCHED/.test(l))
      expect(said).toHaveLength(1)
      expect(said[0]).toContain('hub/decoder-nodeav')
      // It must name the reason the other numbers cannot cover for it.
      expect(said[0]).toContain('subtracts external by construction')
    } finally {
      stop?.()
    }
  })

  it('a declared budget silences the unwatched line', () => {
    const info = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/stream-broker',
      rssBudgetMb: '2048',
      sink: { info, warn: vi.fn() },
      reclaimOptions: { reclaim: vi.fn(), readMemory: () => mem(), heapLimitBytes: 4288 * MB },
    })
    try {
      expect(info.mock.calls.map((c) => String(c[0])).filter((l) => /NOT WATCHED/.test(l))).toEqual(
        [],
      )
      const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('rss='))
      expect(line).toContain('rssBudget=2048MB')
    } finally {
      stop?.()
    }
  })

  it('the reclaim kill-switch turns off the PASS, never the reporting', () => {
    // `CAMSTACK_RUNNER_HEAP_RECLAIM=off` is the operator's escape hatch for the
    // stop-the-world on the media path. Losing the budget alarm with it would
    // mean the switch silently removes the only thing that sees a Buffer climb.
    const info = vi.fn()
    const stop = startRunnerHeapWatch({
      heapProfile: 'heavy',
      label: 'hub/stream-broker',
      reclaimSwitch: 'off',
      sink: { info, warn: vi.fn() },
    })
    try {
      const said = info.mock.calls.map((c) => String(c[0])).filter((l) => /NOT WATCHED/.test(l))
      expect(said).toHaveLength(1)
    } finally {
      stop?.()
    }
  })

  it('a malformed or zero budget is UNWATCHED, never rounded to a default', () => {
    expect(parseRssBudgetMb(undefined)).toBeUndefined()
    expect(parseRssBudgetMb('')).toBeUndefined()
    expect(parseRssBudgetMb('not-a-number')).toBeUndefined()
    expect(parseRssBudgetMb('0')).toBeUndefined()
    expect(parseRssBudgetMb('-512')).toBeUndefined()
    expect(parseRssBudgetMb('2048')).toBe(2048)
    expect(parseRssBudgetMb('2048.9')).toBe(2048)
  })

  it('hub-main declares its own, because it has no manifest to declare it in', () => {
    expect(hubMainRssBudget({}).budgetMb).toBe(HUB_MAIN_RSS_BUDGET_MB)
    // The operator can move it without a release, and the line says they did.
    const overridden = hubMainRssBudget({ [HUB_RSS_BUDGET_ENV]: '6144' })
    expect(overridden.budgetMb).toBe(6144)
    expect(overridden.source).toBe(HUB_RSS_BUDGET_ENV)
    // …including all the way off, which is still an explicit, reported choice.
    expect(hubMainRssBudget({ [HUB_RSS_BUDGET_ENV]: '0' }).budgetMb).toBeUndefined()
  })
})
