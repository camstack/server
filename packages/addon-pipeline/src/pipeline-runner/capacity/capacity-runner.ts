/**
 * Open-loop capacity pacer — the load driver of `runCapacityRamp`.
 *
 * Every existing bench loop in this repo is CLOSED-loop: when the node slows
 * down, the driver slows down with it, so it can only ever find a throughput
 * ceiling — never "N cameras at a fixed rate", because there is no offered
 * load to fall behind. This module is the missing OPEN-loop driver: each
 * simulated camera ticks on an ABSOLUTE schedule at `fpsPerCamera`,
 * regardless of how the node is doing, and every tick is accounted for:
 *
 *   - tick fires, camera idle  → dispatch ONE single-frame call
 *   - tick fires, camera busy  → counted `offered` + `droppedByDriver`;
 *     the tick is NOT queued (queuing converts open-loop back into
 *     closed-loop) — this mirrors the live runner's latest-frame-only queue
 *   - dispatch resolves shed   → counted `shed` (the pool said no)
 *   - dispatch rejects         → counted `errors`
 *
 * The tick schedule is derived from tick INDEX (`start + k·interval`), never
 * from arrival time — after an event-loop stall the loop catches up through
 * every overdue tick and counts each one, so a driver that was itself frozen
 * still reports the load it failed to offer. A pacer that silently
 * self-throttles measures nothing, and that failure is invisible in a green
 * run; the unit tests pin `offered === cameras × fps × measureSec` under a
 * slow node, a stalled clock and a fast node alike.
 *
 * Everything time-related is injected (`now`, `sleepUntil`) so the whole
 * pacer is deterministic under test.
 */

/** How one dispatched call resolved, as far as capacity accounting cares. */
export type CapacityOutcomeKind = 'ok' | 'shed' | 'error'

/** Which signal identified a shed — first-class marker vs the fragile
 *  empty-detections convention (only used against a pre-marker executor). */
export type ShedSignal = 'first-class' | 'zero-detections-fallback'

export interface CapacityDispatchOutcome {
  readonly kind: CapacityOutcomeKind
  /** Pool-side total inference ms for the frame (`debug.totalInferenceMs`). */
  readonly inferMs?: number
  /** Pool-side pure predict ms (`debug.predictMs`). */
  readonly predictMs?: number
  /** Detections on the frame (ok outcomes). */
  readonly detections?: number
  /** For `kind: 'shed'` — which signal identified the shed. */
  readonly shedSignal?: ShedSignal
}

export interface CapacityStepOptions {
  /** Simulated cameras — independent 1-in-flight pacers. */
  readonly cameras: number
  /** Offered rate per camera (default live rate is 10). */
  readonly fpsPerCamera: number
  /** Warm-in window before accounting starts. Load runs, counters do not. */
  readonly settleMs: number
  /** Accounting window. `offered` is exact over this window by schedule. */
  readonly measureMs: number
  /** Bound on waiting for still-in-flight calls after the last tick. */
  readonly drainTimeoutMs: number
  /**
   * Issue ONE single-frame call (the production dispatch shape). Never
   * called concurrently for the same camera index. Must not throw
   * synchronously.
   */
  readonly dispatch: (cameraIndex: number) => Promise<CapacityDispatchOutcome>
  /** Wall clock in ms — injected for test determinism. */
  readonly now: () => number
  /** Sleep until an absolute clock value (no-op when already past). */
  readonly sleepUntil: (t: number) => Promise<void>
  /** Cooperative stop — polled every tick; true ⇒ stop offering + drain. */
  readonly shouldStop: () => boolean
  /** Fired once when the settle window ends (stall/RSS snapshot hook). */
  readonly onMeasureStart?: () => void
}

/** Raw per-step counters. All counts refer to the MEASURE window only. */
export interface CapacityStepRaw {
  /** Ticks scheduled inside the measure window — the offered load. */
  readonly offered: number
  /** Offered ticks that actually dispatched a call. */
  readonly dispatched: number
  /** Dispatched calls that resolved with real inference (`kind: 'ok'`). */
  readonly completed: number
  /** Offered ticks skipped because the camera was still in flight. */
  readonly droppedByDriver: number
  /** Dispatched calls the pool shed (flow control). */
  readonly shed: number
  /** Sheds identified by the first-class `FrameResult.shed` marker. */
  readonly firstClassShed: number
  /** Sheds inferred from an empty detections array (pre-marker executor). */
  readonly fallbackShed: number
  /** Dispatched calls that rejected — anything but flow control. */
  readonly errors: number
  /** Calls still unresolved when the drain timeout expired. */
  readonly unresolvedAtDrain: number
  /** Driver-side wall latency of each completed (ok) call. */
  readonly e2eMsList: readonly number[]
  /** Pool-side inference ms per completed call (0 when absent). */
  readonly inferMsList: readonly number[]
  /** Pool-side predict ms per completed call (0 when absent). */
  readonly predictMsList: readonly number[]
  /** Detections per completed call. */
  readonly detectionCounts: readonly number[]
  /** Wall clock of the whole step (settle + measure + drain). */
  readonly wallMs: number
  /** True when the step ended via `shouldStop`, not the schedule. */
  readonly aborted: boolean
}

interface MutableCounters {
  offered: number
  dispatched: number
  completed: number
  droppedByDriver: number
  shed: number
  firstClassShed: number
  fallbackShed: number
  errors: number
  aborted: boolean
  outstanding: number
  e2eMsList: number[]
  inferMsList: number[]
  predictMsList: number[]
  detectionCounts: number[]
}

/**
 * Run ONE ramp step: `cameras` independent open-loop pacers for
 * `settleMs + measureMs`, then a bounded drain of in-flight calls.
 */
export async function runCapacityStep(opts: CapacityStepOptions): Promise<CapacityStepRaw> {
  const cameras = Math.max(1, Math.floor(opts.cameras))
  const fps = Math.max(0.1, opts.fpsPerCamera)
  const intervalMs = 1000 / fps
  const start = opts.now()
  const measureStart = start + Math.max(0, opts.settleMs)
  const end = measureStart + Math.max(0, opts.measureMs)

  const c: MutableCounters = {
    offered: 0,
    dispatched: 0,
    completed: 0,
    droppedByDriver: 0,
    shed: 0,
    firstClassShed: 0,
    fallbackShed: 0,
    errors: 0,
    aborted: false,
    outstanding: 0,
    e2eMsList: [],
    inferMsList: [],
    predictMsList: [],
    detectionCounts: [],
  }

  const recordOutcome = (
    counted: boolean,
    outcome: CapacityDispatchOutcome,
    e2eMs: number,
  ): void => {
    if (!counted) return
    if (outcome.kind === 'ok') {
      c.completed += 1
      c.e2eMsList.push(e2eMs)
      c.inferMsList.push(outcome.inferMs ?? 0)
      c.predictMsList.push(outcome.predictMs ?? 0)
      c.detectionCounts.push(outcome.detections ?? 0)
      return
    }
    if (outcome.kind === 'shed') {
      c.shed += 1
      if (outcome.shedSignal === 'zero-detections-fallback') c.fallbackShed += 1
      else c.firstClassShed += 1
      return
    }
    c.errors += 1
  }

  // Fires the measure-start hook at the settle/measure boundary — a time,
  // not a tick, so it is exact regardless of per-camera phase offsets.
  const measureMarker =
    opts.onMeasureStart !== undefined && opts.settleMs > 0
      ? opts.sleepUntil(measureStart).then(() => opts.onMeasureStart?.())
      : (opts.onMeasureStart?.(), Promise.resolve())

  const cameraLoop = async (cameraIndex: number): Promise<void> => {
    // Phase offset spreads the fleet's ticks uniformly across one interval —
    // live cameras are not phase-aligned, and aligning them would offer a
    // synthetic burst pattern production does not have.
    const offset = (cameraIndex / cameras) * intervalMs
    let inFlight = false
    for (let k = 0; ; k++) {
      const tickAt = start + offset + k * intervalMs
      if (tickAt >= end) break
      if (opts.shouldStop()) {
        c.aborted = true
        break
      }
      // Absolute schedule: an overdue tick (event-loop stall, slow node)
      // is processed immediately — never silently skipped.
      if (tickAt > opts.now()) await opts.sleepUntil(tickAt)
      if (opts.shouldStop()) {
        c.aborted = true
        break
      }
      const counted = tickAt >= measureStart
      if (counted) c.offered += 1
      if (inFlight) {
        // Camera busy — the live latest-frame-only queue drops this frame.
        if (counted) c.droppedByDriver += 1
        continue
      }
      inFlight = true
      if (counted) c.dispatched += 1
      const t0 = opts.now()
      c.outstanding += 1
      void opts
        .dispatch(cameraIndex)
        .then(
          (outcome) => recordOutcome(counted, outcome, opts.now() - t0),
          () => {
            if (counted) c.errors += 1
          },
        )
        .finally(() => {
          inFlight = false
          c.outstanding -= 1
        })
    }
  }

  await Promise.all(Array.from({ length: cameras }, (_, i) => cameraLoop(i)))
  await measureMarker

  // Bounded drain: wait for in-flight calls to settle, but never hang the
  // step on a wedged dispatch — leftovers are reported, not awaited forever.
  const drainDeadline = opts.now() + Math.max(0, opts.drainTimeoutMs)
  while (c.outstanding > 0 && opts.now() < drainDeadline) {
    await opts.sleepUntil(Math.min(drainDeadline, opts.now() + 50))
  }

  return {
    offered: c.offered,
    dispatched: c.dispatched,
    completed: c.completed,
    droppedByDriver: c.droppedByDriver,
    shed: c.shed,
    firstClassShed: c.firstClassShed,
    fallbackShed: c.fallbackShed,
    errors: c.errors,
    unresolvedAtDrain: c.outstanding,
    e2eMsList: c.e2eMsList,
    inferMsList: c.inferMsList,
    predictMsList: c.predictMsList,
    detectionCounts: c.detectionCounts,
    wallMs: opts.now() - start,
    aborted: c.aborted,
  }
}

// ---------------------------------------------------------------------------
// Step evaluation (SLO gate)
// ---------------------------------------------------------------------------

export interface CapacitySlo {
  /** Max tolerated (droppedByDriver + shed) / offered. Spec default 0.01. */
  readonly dropRatioMax: number
  /** Max tolerated driver-side e2e p95 in ms. Spec default 250. */
  readonly e2eP95MsMax: number
  /** Max tolerated event-loop stalls ≥ threshold in the window. Spec default 0. */
  readonly stallsMax: number
}

export const DEFAULT_CAPACITY_SLO: CapacitySlo = {
  dropRatioMax: 0.01,
  e2eP95MsMax: 250,
  stallsMax: 0,
}

export interface CapacityStallWindow {
  /** Stalls ≥ report threshold inside the measure window (any cause). */
  readonly count: number
  readonly maxMs: number
  readonly gcMs: number
  /** Stalls classified `synchronous-block` — the sharp-fix regression metric. */
  readonly syncCount: number
}

export interface LatencyDigest {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

export interface CapacityStepVerdict {
  readonly dropRatio: number
  readonly e2eMs: LatencyDigest
  readonly inferMs: { readonly avg: number; readonly p95: number }
  readonly predictMs: { readonly avg: number; readonly p95: number }
  readonly detectionsAvg: number
  readonly pass: boolean
  readonly failReasons: readonly string[]
}

/** Nearest-rank percentile on an unsorted list. Returns 0 for empty input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].toSorted((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/**
 * Judge one step against the SLO. Pure — the whole gate is testable without
 * a clock or a node. An error or an unresolved call is never "just a drop":
 * it means something other than flow control broke, so it fails the step
 * regardless of ratio (spec §1: errors 0 tolerated).
 */
export function evaluateCapacityStep(
  raw: CapacityStepRaw,
  stall: CapacityStallWindow,
  slo: CapacitySlo,
): CapacityStepVerdict {
  const dropRatio = raw.offered > 0 ? (raw.droppedByDriver + raw.shed) / raw.offered : 0
  const e2eMs: LatencyDigest = {
    p50: percentile(raw.e2eMsList, 0.5),
    p95: percentile(raw.e2eMsList, 0.95),
    p99: percentile(raw.e2eMsList, 0.99),
    max: raw.e2eMsList.length > 0 ? Math.max(...raw.e2eMsList) : 0,
  }
  const failReasons: string[] = []
  if (dropRatio > slo.dropRatioMax) {
    failReasons.push(
      `dropRatio ${(dropRatio * 100).toFixed(2)}% > ${(slo.dropRatioMax * 100).toFixed(2)}%`,
    )
  }
  if (e2eMs.p95 > slo.e2eP95MsMax) {
    failReasons.push(`e2e p95 ${Math.round(e2eMs.p95)}ms > ${slo.e2eP95MsMax}ms`)
  }
  if (stall.count > slo.stallsMax) {
    failReasons.push(`event-loop stalls ${stall.count} > ${slo.stallsMax} (max ${stall.maxMs}ms)`)
  }
  if (raw.errors > 0) failReasons.push(`errors ${raw.errors} (0 tolerated)`)
  if (raw.unresolvedAtDrain > 0) {
    failReasons.push(`unresolved calls at drain ${raw.unresolvedAtDrain}`)
  }
  return {
    dropRatio,
    e2eMs,
    inferMs: { avg: mean(raw.inferMsList), p95: percentile(raw.inferMsList, 0.95) },
    predictMs: { avg: mean(raw.predictMsList), p95: percentile(raw.predictMsList, 0.95) },
    detectionsAvg: mean(raw.detectionCounts),
    pass: failReasons.length === 0,
    failReasons,
  }
}

/**
 * `N_max` — the last PASSING step's camera count, or null when none passed.
 * Steps after the first failure do not resurrect the number (the spec stops
 * at the first failing step; a re-run confirms the knee, not this fold).
 */
export function computeNMax(
  steps: ReadonlyArray<{ readonly cameras: number; readonly pass: boolean }>,
): { readonly nMax: number | null; readonly failedStep: number | null } {
  let nMax: number | null = null
  for (const step of steps) {
    if (!step.pass) return { nMax, failedStep: step.cameras }
    nMax = step.cameras
  }
  return { nMax, failedStep: null }
}

// ---------------------------------------------------------------------------
// Ramp orchestration
// ---------------------------------------------------------------------------

/** One evaluated ramp step: raw counters + stall window + verdict + RSS. */
export interface CapacityRampStep {
  readonly cameras: number
  readonly raw: CapacityStepRaw
  readonly stall: CapacityStallWindow
  readonly verdict: CapacityStepVerdict
  readonly rssStartMb: number
  readonly rssEndMb: number
}

export interface CapacityRampOutcome {
  readonly steps: readonly CapacityRampStep[]
  readonly nMax: number | null
  readonly failedStep: number | null
  readonly shedSignal: 'first-class' | 'zero-detections-fallback' | 'mixed' | 'none'
  readonly wallMs: number
  readonly aborted: boolean
}

export interface CapacityRampOptions {
  /** Cameras per step, in ramp order (spec default [2,4,8,12,16,20,24,28,32]). */
  readonly ramp: readonly number[]
  readonly fpsPerCamera: number
  readonly settleMs: number
  readonly measureMs: number
  readonly drainTimeoutMs: number
  readonly slo: CapacitySlo
  readonly stopOnFirstFail: boolean
  readonly dispatch: (cameraIndex: number) => Promise<CapacityDispatchOutcome>
  readonly now: () => number
  readonly sleepUntil: (t: number) => Promise<void>
  readonly shouldStop: () => boolean
  /** Cumulative stall counters — snapshotted at measure start/end and diffed. */
  readonly stallSnapshot: () => CapacityStallWindow
  /** Process RSS in MB at a boundary. */
  readonly rssMb: () => number
  /**
   * Further fail reasons for a finished step (node CPU, free RAM — the node
   * benchmark's pipeline gate, D791). Any reason fails the step.
   */
  readonly extraFailReasons?: (step: CapacityRampStep) => readonly string[]
  /** Called at each step's settle/measure boundary (a sampler reset). */
  readonly onMeasureStartHook?: () => void
  /** Per-step lifecycle hook (progress reporting). */
  readonly onStep?: (info: {
    readonly stepIndex: number
    readonly cameras: number
    readonly phase: 'settle' | 'measure' | 'done'
    readonly step?: CapacityRampStep
  }) => void
}

function diffStallWindow(
  start: CapacityStallWindow,
  end: CapacityStallWindow,
): CapacityStallWindow {
  return {
    count: end.count - start.count,
    // max is cumulative, not diffable — report the run max (conservative:
    // it can only overstate a step's stall, never hide one).
    maxMs: end.maxMs,
    gcMs: end.gcMs - start.gcMs,
    syncCount: end.syncCount - start.syncCount,
  }
}

/**
 * Run the whole ramp: one open-loop step per camera count, evaluated
 * against the SLO, stopping at the first failing step when configured.
 * Pure orchestration over injected effects — the addon handler supplies the
 * real dispatch/clock/sampler; tests supply fakes.
 */
export async function executeCapacityRamp(opts: CapacityRampOptions): Promise<CapacityRampOutcome> {
  const start = opts.now()
  const steps: CapacityRampStep[] = []
  let aborted = false
  let firstClass = 0
  let fallback = 0

  for (let stepIndex = 0; stepIndex < opts.ramp.length; stepIndex++) {
    const cameras = opts.ramp[stepIndex] ?? 1
    if (opts.shouldStop()) {
      aborted = true
      break
    }
    opts.onStep?.({ stepIndex, cameras, phase: 'settle' })

    let stallStart = opts.stallSnapshot()
    let rssStart = opts.rssMb()
    const raw = await runCapacityStep({
      cameras,
      fpsPerCamera: opts.fpsPerCamera,
      settleMs: opts.settleMs,
      measureMs: opts.measureMs,
      drainTimeoutMs: opts.drainTimeoutMs,
      dispatch: opts.dispatch,
      now: opts.now,
      sleepUntil: opts.sleepUntil,
      shouldStop: opts.shouldStop,
      onMeasureStart: () => {
        // Snapshot at the settle/measure boundary so settle-phase stalls and
        // RSS growth never contaminate the accounted window.
        stallStart = opts.stallSnapshot()
        rssStart = opts.rssMb()
        opts.onMeasureStartHook?.()
        opts.onStep?.({ stepIndex, cameras, phase: 'measure' })
      },
    })
    const stall = diffStallWindow(stallStart, opts.stallSnapshot())
    const evaluated = evaluateCapacityStep(raw, stall, opts.slo)
    const base: CapacityRampStep = {
      cameras,
      raw,
      stall,
      verdict: evaluated,
      rssStartMb: rssStart,
      rssEndMb: opts.rssMb(),
    }
    const extra = opts.extraFailReasons?.(base) ?? []
    const verdict: CapacityStepVerdict =
      extra.length === 0
        ? evaluated
        : { ...evaluated, pass: false, failReasons: [...evaluated.failReasons, ...extra] }
    const step: CapacityRampStep = { ...base, verdict }
    steps.push(step)
    firstClass += raw.firstClassShed
    fallback += raw.fallbackShed
    opts.onStep?.({ stepIndex, cameras, phase: 'done', step })

    if (raw.aborted) {
      aborted = true
      break
    }
    if (!verdict.pass && opts.stopOnFirstFail) break
  }

  const { nMax, failedStep } = computeNMax(
    steps.map((s) => ({ cameras: s.cameras, pass: s.verdict.pass })),
  )
  const shedSignal =
    firstClass > 0 && fallback > 0
      ? ('mixed' as const)
      : firstClass > 0
        ? ('first-class' as const)
        : fallback > 0
          ? ('zero-detections-fallback' as const)
          : ('none' as const)

  return { steps, nMax, failedStep, shedSignal, wallMs: opts.now() - start, aborted }
}
