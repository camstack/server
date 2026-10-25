/**
 * The open-loop pacer's ONE non-negotiable property: the offered load is a
 * function of the SCHEDULE, never of the node. A driver that silently
 * self-throttles under a slow node (or while itself stalled) measures
 * nothing — and that failure is invisible in a green run, so it is pinned
 * here from every direction:
 *
 *   - slow node        → offered stays exact, the deficit shows up as
 *                        droppedByDriver (never as fewer offered ticks);
 *   - driver stall     → overdue ticks are caught up and counted;
 *   - fast node        → offered === completed, zero drops;
 *   - busy camera      → the tick is DROPPED, never queued (queueing turns
 *                        open-loop back into closed-loop);
 *   - per-camera bound → at most ONE call in flight per camera, ever.
 *
 * Plus the accounting seams: settle-window exclusion, shed/error/abort
 * bookkeeping, the SLO gate and the N_max fold.
 */
import { describe, expect, it } from 'vitest'
import {
  type CapacityDispatchOutcome,
  type CapacityStallWindow,
  type CapacityStepRaw,
  computeNMax,
  DEFAULT_CAPACITY_SLO,
  evaluateCapacityStep,
  executeCapacityRamp,
  percentile,
  runCapacityStep,
} from '../capacity-runner.js'
import { VirtualClock } from './virtual-clock.js'

const OK: CapacityDispatchOutcome = { kind: 'ok', inferMs: 10, predictMs: 5, detections: 2 }

const NO_STALLS: CapacityStallWindow = { count: 0, maxMs: 0, gcMs: 0, syncCount: 0 }

interface StepHarnessOptions {
  readonly cameras?: number
  readonly fpsPerCamera?: number
  readonly settleMs?: number
  readonly measureMs?: number
  readonly drainTimeoutMs?: number
  readonly dispatch: (clock: VirtualClock, cameraIndex: number) => Promise<CapacityDispatchOutcome>
  readonly shouldStop?: (clock: VirtualClock) => boolean
}

async function runStep(opts: StepHarnessOptions): Promise<CapacityStepRaw> {
  const clock = new VirtualClock()
  const settleMs = opts.settleMs ?? 0
  const measureMs = opts.measureMs ?? 1000
  const drainTimeoutMs = opts.drainTimeoutMs ?? 1000
  const promise = runCapacityStep({
    cameras: opts.cameras ?? 1,
    fpsPerCamera: opts.fpsPerCamera ?? 10,
    settleMs,
    measureMs,
    drainTimeoutMs,
    dispatch: (cameraIndex) => opts.dispatch(clock, cameraIndex),
    now: clock.now,
    sleepUntil: clock.sleepUntil,
    shouldStop: () => opts.shouldStop?.(clock) ?? false,
  })
  await clock.run(settleMs + measureMs + drainTimeoutMs + 1000)
  return promise
}

describe('runCapacityStep — open-loop pacing', () => {
  it('fast node: offered === schedule === completed, zero drops', async () => {
    const raw = await runStep({
      cameras: 2,
      fpsPerCamera: 10,
      measureMs: 1000,
      // Instant dispatch — resolves within the same tick.
      dispatch: async () => OK,
    })
    // 2 cameras × 10 fps × 1 s — exact, not approximate.
    expect(raw.offered).toBe(20)
    expect(raw.dispatched).toBe(20)
    expect(raw.completed).toBe(20)
    expect(raw.droppedByDriver).toBe(0)
    expect(raw.shed).toBe(0)
    expect(raw.errors).toBe(0)
    expect(raw.unresolvedAtDrain).toBe(0)
    expect(raw.e2eMsList).toHaveLength(20)
  })

  it('SLOW node: offered load NEVER shrinks — the deficit is droppedByDriver (anti-self-throttle)', async () => {
    // Each call takes 250ms against a 100ms tick interval.
    const raw = await runStep({
      cameras: 1,
      fpsPerCamera: 10,
      measureMs: 1000,
      dispatch: (clock) => clock.sleepUntil(clock.now() + 250).then(() => OK),
    })
    // THE invariant: offered is exactly the schedule (10 ticks), however
    // slow the node is. A closed-loop (self-throttling) driver would report
    // offered ≈ completed ≈ 4 here and the regression would look green.
    expect(raw.offered).toBe(10)
    // Ticks at 0,300,600,900 dispatch; 100,200,400,500,700,800 hit a busy
    // camera and are dropped — that IS the measurement.
    expect(raw.dispatched).toBe(4)
    expect(raw.droppedByDriver).toBe(6)
    expect(raw.completed).toBe(4)
    expect(raw.dispatched + raw.droppedByDriver).toBe(raw.offered)
  })

  it('a busy tick is DROPPED, never queued: in-flight per camera never exceeds 1', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const raw = await runStep({
      cameras: 3,
      fpsPerCamera: 10,
      measureMs: 1000,
      dispatch: (clock) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        return clock.sleepUntil(clock.now() + 350).then(() => {
          inFlight -= 1
          return OK
        })
      },
    })
    // 3 cameras, each with ≤1 in flight ⇒ global bound is the camera count.
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(raw.offered).toBe(30)
    expect(raw.dispatched + raw.droppedByDriver).toBe(30)
  })

  it('driver stall: overdue ticks are caught up and counted, not skipped', async () => {
    let dispatches = 0
    const raw = await runStep({
      cameras: 1,
      fpsPerCamera: 10,
      measureMs: 1000,
      dispatch: async (clock) => {
        dispatches += 1
        // First call synchronously "blocks the loop" for 450ms: ticks
        // 100..400 become overdue before the driver can sleep for them.
        if (dispatches === 1) clock.block(450)
        return OK
      },
    })
    // Every scheduled tick is accounted — the stall converts ticks into
    // drops/dispatches but never makes them vanish.
    expect(raw.offered).toBe(10)
    expect(raw.dispatched + raw.droppedByDriver).toBe(10)
  })

  it('settle window is load without accounting: only measure-window ticks count', async () => {
    let calls = 0
    const raw = await runStep({
      cameras: 1,
      fpsPerCamera: 10,
      settleMs: 500,
      measureMs: 1000,
      dispatch: async () => {
        calls += 1
        return OK
      },
    })
    // Offered counts ONLY the 10 measure-window ticks…
    expect(raw.offered).toBe(10)
    expect(raw.completed).toBe(10)
    // …but the node saw settle traffic too (5 settle ticks + 10 measured).
    expect(calls).toBe(15)
  })

  it('sheds and errors are counted apart from driver drops, with the shed signal split', async () => {
    let n = 0
    const raw = await runStep({
      cameras: 1,
      fpsPerCamera: 10,
      measureMs: 1000,
      dispatch: async () => {
        n += 1
        if (n % 3 === 0) return { kind: 'shed', shedSignal: 'first-class' }
        if (n % 4 === 0) return { kind: 'shed', shedSignal: 'zero-detections-fallback' }
        if (n === 7) throw new Error('transport broke')
        return OK
      },
    })
    expect(raw.offered).toBe(10)
    expect(raw.shed).toBe(raw.firstClassShed + raw.fallbackShed)
    expect(raw.firstClassShed).toBeGreaterThan(0)
    expect(raw.fallbackShed).toBeGreaterThan(0)
    expect(raw.errors).toBe(1)
    expect(raw.completed + raw.shed + raw.errors + raw.droppedByDriver).toBe(raw.offered)
  })

  it('abort stops offering promptly and marks the step aborted', async () => {
    const raw = await runStep({
      cameras: 1,
      fpsPerCamera: 10,
      measureMs: 1000,
      dispatch: async () => OK,
      shouldStop: (clock) => clock.now() >= 500,
    })
    expect(raw.aborted).toBe(true)
    // Ticks from t=500 on were never offered.
    expect(raw.offered).toBeLessThanOrEqual(5)
  })

  it('a wedged call is bounded by the drain timeout and reported unresolved', async () => {
    const raw = await runStep({
      cameras: 1,
      fpsPerCamera: 10,
      measureMs: 500,
      drainTimeoutMs: 300,
      // Never resolves inside the run window.
      dispatch: (clock) => clock.sleepUntil(clock.now() + 60_000).then(() => OK),
    })
    expect(raw.unresolvedAtDrain).toBe(1)
    expect(raw.completed).toBe(0)
  })
})

describe('evaluateCapacityStep — the SLO gate', () => {
  const baseRaw = (over: Partial<CapacityStepRaw>): CapacityStepRaw => ({
    offered: 1000,
    dispatched: 1000,
    completed: 1000,
    droppedByDriver: 0,
    shed: 0,
    firstClassShed: 0,
    fallbackShed: 0,
    errors: 0,
    unresolvedAtDrain: 0,
    e2eMsList: [50, 60, 70],
    inferMsList: [20, 25, 30],
    predictMsList: [10, 12, 14],
    detectionCounts: [2, 2, 2],
    wallMs: 120_000,
    aborted: false,
    ...over,
  })

  it('passes a clean step', () => {
    const v = evaluateCapacityStep(baseRaw({}), NO_STALLS, DEFAULT_CAPACITY_SLO)
    expect(v.pass).toBe(true)
    expect(v.failReasons).toHaveLength(0)
  })

  it('drop ratio counts BOTH driver drops and pool sheds against the 1% budget', () => {
    const v = evaluateCapacityStep(
      baseRaw({ droppedByDriver: 6, shed: 5 }),
      NO_STALLS,
      DEFAULT_CAPACITY_SLO,
    )
    expect(v.dropRatio).toBeCloseTo(0.011, 5)
    expect(v.pass).toBe(false)
    expect(v.failReasons.some((r) => r.includes('dropRatio'))).toBe(true)
  })

  it('exactly at the 1% budget still passes (threshold is ≤, not <)', () => {
    const v = evaluateCapacityStep(baseRaw({ shed: 10 }), NO_STALLS, DEFAULT_CAPACITY_SLO)
    expect(v.dropRatio).toBeCloseTo(0.01, 5)
    expect(v.pass).toBe(true)
  })

  it('e2e p95 over budget fails the step', () => {
    const v = evaluateCapacityStep(
      baseRaw({ e2eMsList: Array.from({ length: 100 }, (_, i) => (i < 90 ? 100 : 400)) }),
      NO_STALLS,
      DEFAULT_CAPACITY_SLO,
    )
    expect(v.pass).toBe(false)
    expect(v.failReasons.some((r) => r.includes('e2e p95'))).toBe(true)
  })

  it('ANY event-loop stall is a validity failure regardless of drop ratio', () => {
    const v = evaluateCapacityStep(
      baseRaw({}),
      { count: 1, maxMs: 3100, gcMs: 4, syncCount: 1 },
      DEFAULT_CAPACITY_SLO,
    )
    expect(v.pass).toBe(false)
    expect(v.failReasons.some((r) => r.includes('stalls'))).toBe(true)
  })

  it('errors and unresolved calls invalidate the step (never "just drops")', () => {
    const errs = evaluateCapacityStep(baseRaw({ errors: 1 }), NO_STALLS, DEFAULT_CAPACITY_SLO)
    expect(errs.pass).toBe(false)
    const wedged = evaluateCapacityStep(
      baseRaw({ unresolvedAtDrain: 2 }),
      NO_STALLS,
      DEFAULT_CAPACITY_SLO,
    )
    expect(wedged.pass).toBe(false)
  })
})

describe('computeNMax', () => {
  it('is the last passing step before the first failure', () => {
    expect(
      computeNMax([
        { cameras: 2, pass: true },
        { cameras: 4, pass: true },
        { cameras: 8, pass: false },
      ]),
    ).toEqual({ nMax: 4, failedStep: 8 })
  })

  it('is null when even the first step fails', () => {
    expect(computeNMax([{ cameras: 2, pass: false }])).toEqual({ nMax: null, failedStep: 2 })
  })

  it('a later pass never resurrects the number past the first failure', () => {
    expect(
      computeNMax([
        { cameras: 2, pass: true },
        { cameras: 4, pass: false },
        { cameras: 8, pass: true },
      ]),
    ).toEqual({ nMax: 2, failedStep: 4 })
  })

  it('all passing ⇒ nMax is the last step, no failed step', () => {
    expect(
      computeNMax([
        { cameras: 2, pass: true },
        { cameras: 4, pass: true },
      ]),
    ).toEqual({ nMax: 4, failedStep: null })
  })
})

describe('percentile', () => {
  it('nearest-rank on small lists', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20)
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40)
    expect(percentile([], 0.95)).toBe(0)
  })
})

describe('executeCapacityRamp', () => {
  it('stops at the first failing step and folds nMax; step counters stay per-step', async () => {
    const clock = new VirtualClock()
    // Node degrades sharply past 2 cameras: with 4+ cameras every call
    // takes 3 intervals, shedding >1% is guaranteed via driver drops.
    const dispatch = (cameraIndex: number): Promise<CapacityDispatchOutcome> => {
      void cameraIndex
      const latency = activeCameras <= 2 ? 10 : 320
      return clock.sleepUntil(clock.now() + latency).then(() => OK)
    }
    let activeCameras = 0
    const promise = executeCapacityRamp({
      ramp: [1, 2, 4, 8],
      fpsPerCamera: 10,
      settleMs: 0,
      measureMs: 1000,
      drainTimeoutMs: 500,
      slo: DEFAULT_CAPACITY_SLO,
      stopOnFirstFail: true,
      dispatch,
      now: clock.now,
      sleepUntil: clock.sleepUntil,
      shouldStop: () => false,
      stallSnapshot: () => NO_STALLS,
      rssMb: () => 100,
      onStep: (info) => {
        if (info.phase === 'settle') activeCameras = info.cameras
      },
    })
    await clock.run(4 * 1500 + 5000)
    const outcome = await promise
    expect(outcome.steps).toHaveLength(3) // 1, 2, then 4 fails ⇒ stop
    expect(outcome.nMax).toBe(2)
    expect(outcome.failedStep).toBe(4)
    expect(outcome.steps[2]?.verdict.pass).toBe(false)
    expect(outcome.aborted).toBe(false)
  })

  it('reports the aggregate shed signal across steps', async () => {
    const clock = new VirtualClock()
    let n = 0
    const promise = executeCapacityRamp({
      ramp: [1],
      fpsPerCamera: 10,
      settleMs: 0,
      measureMs: 1000,
      drainTimeoutMs: 200,
      slo: { ...DEFAULT_CAPACITY_SLO, dropRatioMax: 1 },
      stopOnFirstFail: true,
      dispatch: async () => {
        n += 1
        return n % 2 === 0 ? { kind: 'shed', shedSignal: 'first-class' } : OK
      },
      now: clock.now,
      sleepUntil: clock.sleepUntil,
      shouldStop: () => false,
      stallSnapshot: () => NO_STALLS,
      rssMb: () => 100,
    })
    await clock.run(3000)
    const outcome = await promise
    expect(outcome.shedSignal).toBe('first-class')
  })

  it('diffs the stall window at the settle/measure boundary (settle stalls excluded)', async () => {
    const clock = new VirtualClock()
    // Stall counters: 2 stalls happen during settle, 1 more during measure.
    let stallCount = 0
    const promise = executeCapacityRamp({
      ramp: [1],
      fpsPerCamera: 10,
      settleMs: 500,
      measureMs: 1000,
      drainTimeoutMs: 200,
      slo: DEFAULT_CAPACITY_SLO,
      stopOnFirstFail: true,
      dispatch: async () => {
        // Settle window (t<500): pump the fake stall counter.
        if (clock.now() < 500) stallCount = 2
        if (clock.now() >= 900) stallCount = 3
        return OK
      },
      now: clock.now,
      sleepUntil: clock.sleepUntil,
      shouldStop: () => false,
      stallSnapshot: () => ({ count: stallCount, maxMs: 0, gcMs: 0, syncCount: stallCount }),
      rssMb: () => 100,
    })
    await clock.run(3000)
    const outcome = await promise
    // Only the measure-window stall (3 − 2 = 1) counts against the step.
    expect(outcome.steps[0]?.stall.count).toBe(1)
    expect(outcome.steps[0]?.verdict.pass).toBe(false)
  })
})
