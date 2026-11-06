/**
 * Propose a running threshold from a device's own power history (planning#405).
 *
 * Pure and deterministic: the same series gives the same answer. The series is
 * a HELD-VALUE step series — a point's value stands until the next point — which
 * is how device-history stores a gauge, so "time at a level" is exact, not a
 * count of samples.
 *
 *  1. idle floor F = time-weighted median; noise ceiling N = highest value seen
 *     near F. A device that is not near one level most of the time has no floor.
 *  2. coarse activity = above max(2N, N + 5 W); consecutive stretches are episodes.
 *  3. an episode shorter than `PULSE_MAX_MS` is a PULSE (an anti-crease tumble, a
 *     display waking): it is neither a run nor a pause. Among the remaining
 *     episodes, gaps over `PAUSE_MAX_MS` always separate runs; the rest split in
 *     two by the largest log-scale jump (>= 3x): the short ones are pauses INSIDE
 *     a run (a soak), the long ones separate runs. A stretch under `MIN_RUN_MS`
 *     is no run.
 *  4. T = geometric mean of N and the plateau's 10th percentile, snapped to a
 *     grid a person would type; stop dwell covers the longest pause and the
 *     kind's floor; start dwell covers the longest pulse and standby blip above T.
 *  5. the numbers are proved by REPLAY through the real `dwell` evaluation: each
 *     run must hold exactly one true interval and nothing may flap outside.
 */
import { DeviceType } from '../device/device-type.js'
import { evaluateDwell, type ExpressionEvalHooks } from '../expression/builtins.js'
import type { DwellCallState } from '../expression/expression-source.js'
import {
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from './defaults.js'
import type {
  RunningProposalConfidence,
  RunningProposalInsufficientReason,
  RunningProposalReplay,
  RunningProposalTier,
  RunningThresholdProposal,
} from './proposal-schema.js'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

export const PROPOSAL_MIN_SPAN_MS = 24 * HOUR_MS
const MIN_ACTIVE_MS = 10 * MINUTE_MS
const IDLE_BAND_FRACTION = 0.5
const IDLE_BAND_MIN_W = 3
const MIN_IDLE_SHARE = 0.5
const COARSE_FACTOR = 2
const COARSE_MARGIN_W = 5
const PAUSE_JUMP_FACTOR = 3
const GAP_MARGIN_W = 2
const STOP_FACTOR = 1.5
const STOP_STEP_MS = 30 * SECOND_MS
const STOP_MIN_MS = 60 * SECOND_MS
const STOP_MAX_MS = 20 * MINUTE_MS
/** An episode shorter than this is a pulse: the start dwell is held above it. */
export const PULSE_MAX_MS = 90 * SECOND_MS
/** A gap longer than this always separates two runs; the pause search never reaches it. */
export const PAUSE_MAX_MS = 30 * MINUTE_MS
/** A stretch above the threshold shorter than this is a pulse, not a run. */
export const MIN_RUN_MS = 10 * MINUTE_MS
/** What a kind needs at least before it is called stopped: a soak pause is longer for a washer. */
const STOP_FLOOR_BY_KIND: Readonly<Partial<Record<DeviceType, number>>> = {
  [DeviceType.Dryer]: 3 * MINUTE_MS,
  [DeviceType.Dishwasher]: 3 * MINUTE_MS,
  [DeviceType.Washer]: 10 * MINUTE_MS,
}
const START_STEP_MS = 10 * SECOND_MS
const START_MIN_MS = 10 * SECOND_MS
const STOP_WALK_STEPS = 6
const PLATEAU_QUANTILE = 0.1
const HIGH_CONFIDENCE_RUNS = 5
const MEDIUM_CONFIDENCE_RUNS = 2

/** The thresholds an operator would type, in watts. */
export const THRESHOLD_GRID_W: readonly number[] = [
  1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500,
]

export interface ProposalStepPoint {
  readonly t: number
  /** `null` is unknown: the time is skipped, never read as zero (D393). */
  readonly value: number | null
}

export interface ProposalSeries {
  readonly tier: RunningProposalTier
  /** The appliance kind, when known: it sets the floor of the stop dwell. */
  readonly deviceType?: DeviceType
  readonly from: number
  readonly to: number
  /** The read hit its point cap. */
  readonly truncated: boolean
  /** The last point strictly before `from`: the value held when the window opens. */
  readonly before: ProposalStepPoint | null
  readonly points: readonly ProposalStepPoint[]
}

interface Segment {
  readonly start: number
  readonly end: number
  readonly value: number
}

interface Span {
  readonly start: number
  readonly end: number
}

export function proposeRunningThreshold(series: ProposalSeries): RunningThresholdProposal {
  const segments = toSegments(series)
  const spanMs = segments.length === 0 ? 0 : series.to - (segments[0]?.start ?? series.to)
  const insufficient = (
    reason: RunningProposalInsufficientReason,
    runsFound: number,
  ): RunningThresholdProposal => ({
    state: 'insufficient',
    reason,
    evidence: { spanMs, points: series.points.length, runsFound },
    fallback: {
      kind: 'threshold',
      comparison: 'gte',
      threshold: RUNNING_POWER_THRESHOLD_WATTS,
      startDwellMs: RUNNING_POWER_START_DELAY_MS,
      stopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
    },
  })

  if (series.truncated) return insufficient('truncated', 0)
  if (segments.length === 0) return insufficient('no-history', 0)
  if (spanMs < PROPOSAL_MIN_SPAN_MS) return insufficient('span-too-short', 0)

  const idleFloor = weightedQuantile(weigh(segments), 0.5)
  const band = Math.max(IDLE_BAND_MIN_W, IDLE_BAND_FRACTION * idleFloor)
  const quiet = segments.filter((s) => Math.abs(s.value - idleFloor) <= band)
  if (durationOf(quiet) < MIN_IDLE_SHARE * durationOf(segments)) {
    return insufficient('no-idle-floor', 0)
  }
  const noise = Math.max(idleFloor, ...quiet.map((s) => s.value))

  const coarse = Math.max(COARSE_FACTOR * noise, noise + COARSE_MARGIN_W)
  const active = segments.filter((s) => s.value > coarse)
  const episodes = mergeContiguous(active)
  if (durationOf(active) < MIN_ACTIVE_MS || episodes.length === 0) {
    return insufficient('no-runs', 0)
  }

  const pulseEpisodes = episodes.filter((e) => e.end - e.start < PULSE_MAX_MS)
  const bodies = episodes.filter((e) => e.end - e.start >= PULSE_MAX_MS)
  const split = splitRuns(bodies)
  const runs = split.runs.filter((r) => r.end - r.start >= MIN_RUN_MS)
  const { pauses, betweenGaps } = split
  const pulsesFound = pulseEpisodes.length + (split.runs.length - runs.length)
  const longestPulse = maxOf(pulseEpisodes.map((e) => e.end - e.start))
  if (runs.length === 0) return insufficient('no-runs', 0)
  const plateau = weightedQuantile(
    weigh(active.filter((s) => runs.some((r) => s.start < r.end && s.end > r.start))),
    PLATEAU_QUANTILE,
  )
  const threshold = pickThreshold(noise, plateau)
  if (threshold === null) return insufficient('no-separation', runs.length)

  const notes: string[] = []
  const longestPause = pauses.length === 0 ? 0 : Math.max(...pauses)
  const stopFloor =
    series.deviceType === undefined
      ? STOP_MIN_MS
      : (STOP_FLOOR_BY_KIND[series.deviceType] ?? STOP_MIN_MS)
  let stop = clamp(
    Math.max(stopFloor, roundUp(STOP_FACTOR * longestPause, STOP_STEP_MS)),
    STOP_MIN_MS,
    STOP_MAX_MS,
  )
  const shortestGap = betweenGaps.length === 0 ? null : Math.min(...betweenGaps)
  if (shortestGap !== null && stop >= shortestGap) {
    notes.push('stop-dwell-exceeds-shortest-gap')
  }

  const blips = excursionsOutside(segments, threshold, runs)
  let start = Math.max(START_MIN_MS, roundUp(STOP_FACTOR * maxOf(blips), START_STEP_MS))
  // A pulse is shorter than PULSE_MAX_MS by definition: the start dwell holds above it,
  // so a pulse after a run closes can neither open a run nor keep one alive.
  if (pulsesFound > 0) start = Math.max(start, PULSE_MAX_MS)
  const shortestRun = Math.min(...runs.map((r) => r.end - r.start))
  if (start > shortestRun / 2) {
    notes.push('start-dwell-exceeds-half-of-shortest-run')
    start = Math.max(START_MIN_MS, Math.floor(shortestRun / 2 / START_STEP_MS) * START_STEP_MS)
  }

  let replay = replayDwell(segments, series.to, threshold, start, stop, runs)
  for (let step = 0; step < STOP_WALK_STEPS && !isClean(replay) && stop < STOP_MAX_MS; step += 1) {
    stop = Math.min(STOP_MAX_MS, roundUp(stop * STOP_FACTOR, STOP_STEP_MS))
    replay = replayDwell(segments, series.to, threshold, start, stop, runs)
  }
  if (!isClean(replay)) notes.push('replay-not-clean')

  return {
    state: 'proposal',
    transform: {
      kind: 'threshold',
      comparison: 'gte',
      threshold,
      startDwellMs: start,
      stopDwellMs: stop,
    },
    evidence: {
      tier: series.tier,
      spanMs,
      from: series.from,
      to: series.to,
      points: series.points.length,
      runsFound: runs.length,
      pausesFound: pauses.length,
      longestPauseMs: longestPause,
      pulsesFound,
      longestPulseMs: longestPulse,
      idleFloorW: idleFloor,
      noiseCeilingW: noise,
      plateauW: plateau,
      replay,
    },
    confidence: confidenceOf(runs.length, series.tier, notes),
    notes,
  }
}

function confidenceOf(
  runs: number,
  tier: RunningProposalTier,
  notes: readonly string[],
): RunningProposalConfidence {
  if (notes.length > 0 || runs < MEDIUM_CONFIDENCE_RUNS) return 'low'
  if (runs >= HIGH_CONFIDENCE_RUNS && tier === 'raw') return 'high'
  return 'medium'
}

function isClean(replay: RunningProposalReplay): boolean {
  return replay.extra === 0 && replay.missed === 0
}

function toSegments(series: ProposalSeries): Segment[] {
  const steps: ProposalStepPoint[] = []
  if (series.before !== null) steps.push({ t: series.from, value: series.before.value })
  for (const p of series.points) {
    if (p.t >= series.from && p.t < series.to) steps.push(p)
  }
  steps.sort((a, b) => a.t - b.t)
  const out: Segment[] = []
  steps.forEach((step, i) => {
    const end = steps[i + 1]?.t ?? series.to
    if (step.value === null || !Number.isFinite(step.value) || end <= step.t) return
    out.push({ start: step.t, end, value: step.value })
  })
  return out
}

function durationOf(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0)
}

function maxOf(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

interface WeightedValue {
  readonly value: number
  readonly weight: number
}

/** Time-weighted quantile: the first value whose cumulative weight reaches `q`. */
function weightedQuantile(items: readonly WeightedValue[], q: number): number {
  const rows = [...items].sort((a, b) => a.value - b.value)
  const total = rows.reduce((sum, r) => sum + r.weight, 0)
  let seen = 0
  for (const row of rows) {
    seen += row.weight
    if (seen >= q * total) return row.value
  }
  return rows[rows.length - 1]?.value ?? 0
}

function weigh(segments: readonly Segment[]): WeightedValue[] {
  return segments.map((s) => ({ value: s.value, weight: s.end - s.start }))
}

/** Contiguous segments (one ends where the next starts) become one span. */
function mergeContiguous(segments: readonly Segment[]): Span[] {
  const out: Span[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (last !== undefined && last.end === s.start)
      out[out.length - 1] = { start: last.start, end: s.end }
    else out.push({ start: s.start, end: s.end })
  }
  return out
}

/**
 * Gaps between episodes: the largest log-scale jump (>= 3x) in the sorted gaps
 * separates pauses inside a run from the gaps between runs, but a pause is never
 * longer than `PAUSE_MAX_MS`: a cut above it is not taken. No jump: every gap separates
 * runs - a lone pause is indistinguishable from a short standby.
 */
function splitRuns(episodes: readonly Span[]): {
  runs: Span[]
  pauses: number[]
  betweenGaps: number[]
} {
  const gaps = episodes.slice(1).map((e, i) => e.start - (episodes[i]?.end ?? e.start))
  const sorted = [...gaps].sort((a, b) => a - b)
  let cut: number | null = null
  let best = PAUSE_JUMP_FACTOR
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const lo = sorted[i] ?? 0
    const hi = sorted[i + 1] ?? 0
    const ratio = lo > 0 ? hi / lo : Number.POSITIVE_INFINITY
    if (ratio >= best && lo <= PAUSE_MAX_MS) {
      best = ratio
      cut = lo
    }
  }
  const isPause = (gap: number): boolean => cut !== null && gap <= cut
  const runs: Span[] = []
  episodes.forEach((e, i) => {
    const gapBefore = i === 0 ? null : (gaps[i - 1] ?? null)
    const last = runs[runs.length - 1]
    if (last !== undefined && gapBefore !== null && isPause(gapBefore)) {
      runs[runs.length - 1] = { start: last.start, end: e.end }
    } else runs.push({ start: e.start, end: e.end })
  })
  return {
    runs,
    pauses: gaps.filter(isPause),
    betweenGaps: gaps.filter((g) => !isPause(g)),
  }
}

/** The grid value nearest (in log scale) to the geometric mean that still separates. */
function pickThreshold(noise: number, plateau: number): number | null {
  const target = Math.sqrt(Math.max(noise, 0.5) * plateau)
  let best: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of THRESHOLD_GRID_W) {
    if (candidate < noise + GAP_MARGIN_W || candidate > plateau) continue
    const distance = Math.abs(Math.log(candidate / target))
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Durations of stretches at or above `threshold` that lie outside every run. */
function excursionsOutside(
  segments: readonly Segment[],
  threshold: number,
  runs: readonly Span[],
): number[] {
  const high = mergeContiguous(segments.filter((s) => s.value >= threshold))
  return high
    .filter((h) => !runs.some((r) => h.start < r.end && h.end > r.start))
    .map((h) => h.end - h.start)
}

/** The numbers a proposal (or a stored expression) is replayed with. */
export interface ReplayTransform {
  readonly threshold: number
  readonly startDwellMs: number
  readonly stopDwellMs: number
}

/** The intervals the real `dwell` evaluation holds true over a series, deadlines included. */
export function replayDwellIntervals(
  series: ProposalSeries,
  transform: ReplayTransform,
): readonly Span[] {
  return runDwell(
    toSegments(series),
    series.to,
    transform.threshold,
    transform.startDwellMs,
    transform.stopDwellMs,
  )
}

function replayDwell(
  segments: readonly Segment[],
  to: number,
  threshold: number,
  startMs: number,
  stopMs: number,
  runs: readonly Span[],
): RunningProposalReplay {
  return judge(runDwell(segments, to, threshold, startMs, stopMs), runs)
}

function runDwell(
  segments: readonly Segment[],
  to: number,
  threshold: number,
  startMs: number,
  stopMs: number,
): Span[] {
  const call: DwellCallState = {
    kind: 'dwell',
    pendingSince: null,
    pendingSamples: 0,
    returnSince: null,
    latched: null,
    seenSince: null,
    transition: null,
  }
  let deadline: number | null = null
  const hooks: ExpressionEvalHooks = {
    noteDeadline: (at: number) => {
      deadline = deadline === null ? at : Math.min(deadline, at)
    },
  }
  const timerHooks: ExpressionEvalHooks = { ...hooks, timerDriven: true }
  const intervals: Span[] = []
  let openAt: number | null = null
  const evaluate = (active: boolean, at: number, timer: boolean): void => {
    deadline = null
    const answer = evaluateDwell(active, startMs, stopMs, call, at, timer ? timerHooks : hooks)
    if (answer === true && openAt === null) openAt = at
    if (answer !== true && openAt !== null) {
      intervals.push({ start: openAt, end: at })
      openAt = null
    }
  }
  segments.forEach((segment, i) => {
    const active = segment.value >= threshold
    evaluate(active, segment.start, false)
    const next = segments[i + 1]?.start ?? to
    while (deadline !== null && deadline <= next) evaluate(active, deadline, true)
  })
  if (openAt !== null) intervals.push({ start: openAt, end: to })
  return intervals
}

function judge(intervals: readonly Span[], runs: readonly Span[]): RunningProposalReplay {
  const hits = (i: Span, r: Span): boolean => i.start < r.end && i.end > r.start
  let extra = 0
  let merged = 0
  for (const interval of intervals) {
    const touched = runs.filter((r) => hits(interval, r)).length
    if (touched === 0) extra += 1
    merged += Math.max(0, touched - 1)
  }
  let missed = merged
  for (const run of runs) {
    const mine = intervals.filter((i) => hits(i, run)).length
    if (mine === 0) missed += 1
    extra += Math.max(0, mine - 1)
  }
  return { intervals: intervals.length, extra, missed }
}
