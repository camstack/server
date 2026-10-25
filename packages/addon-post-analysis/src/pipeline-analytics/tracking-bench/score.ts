/**
 * Metrics for one tape through one tracker (D681, spec §5.4) — a LOCAL
 * development tool: no baseline, no tolerance, no CI. Pure: no I/O.
 *
 * Replays twice (two fresh instances) and refuses a tracker whose hashes
 * differ; derives truth from the marks and refuses a contradiction; scores
 * identity on final ids (`finalIdResolver`). A tape with a gap, or marks not
 * yet reviewed, is scored anyway and the result carries the warning: a
 * developer looking at a case wants the number, with its caveat.
 *
 * `deriveTruth` takes an `IScopedLogger` (added after this module's contract
 * was written — the operator-wins/slow-read logging, see `ground-truth.ts`'s
 * module comment). This module is pure per its own contract, so it uses the
 * package's no-op logger here, the same adaptation `cases/case-fixture.ts`
 * made — `suppressedAuto` still comes back on `Truth` for a caller (the
 * Task 23 CLI) to print before acting on the score.
 */
import { deriveTruth, type GroundTruthFile } from './ground-truth.js'
import { computeClear } from './metrics/clear.js'
import { computeHota } from './metrics/hota.js'
import { computeIdentity } from './metrics/idf1.js'
import { buildMetricSequence } from './metrics/matching.js'
import { computeOperatorMetrics } from './metrics/operator.js'
import { createNoopLogger } from './no-op-logger.js'
import { finalIdResolver, replayTape } from './replay.js'
import type { Tape } from './tape-codec.js'
import type { TapePlane } from './tape-schema.js'
import type { TapeTrackerFactory } from './trackers/tape-tracker.js'

const METRIC_KEYS = [
  'HOTA',
  'DetA',
  'AssA',
  'IDF1',
  'MOTA',
  'IDSW',
  'Frag',
  'idsPerPresence',
  'resplitShare',
  'swapsPer100',
  'mergesPer100',
  'stationaryBreaks',
  'duplicateNotifications',
  'finalIdLatencyP50',
  'finalIdLatencyP95',
  'tracksPerIdentityHour',
  'unscorableTracks',
  'frames',
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]
export type MetricRow = Readonly<Record<MetricKey, number>>

export interface ScoreInput {
  readonly tape: Tape
  readonly gt: GroundTruthFile
  readonly plane: TapePlane
}

export type ScoreFailureCode = 'contradiction' | 'nondeterministic'

export interface ScoreOk {
  readonly ok: true
  readonly tracker: string
  readonly metrics: MetricRow
  readonly warnings: readonly string[]
  readonly ms: number
}

export interface ScoreFailed {
  readonly ok: false
  readonly code: ScoreFailureCode
  readonly detail: string
}

export type ScoreResult = ScoreOk | ScoreFailed

function warningsOf(input: ScoreInput, ambiguousRelations: number): readonly string[] {
  const out: string[] = []
  if (input.tape.end === null || input.tape.body.some((r) => r.kind === 'gap')) {
    out.push('the tape has a gap or no end record — the metrics cover only what was recorded')
  }
  if (!input.gt.reviewed) {
    out.push(
      'gt.json is not marked reviewed — unmarked tracks are assumed to be one pure subject each',
    )
  }
  if (ambiguousRelations > 0) {
    out.push(
      `${String(ambiguousRelations)} relation(s) name a mixed track without a side and are not scored`,
    )
  }
  return out
}

export function scoreTape(
  input: ScoreInput,
  factory: TapeTrackerFactory,
  now: () => number,
): ScoreResult {
  const started = now()
  const truth = deriveTruth(input.tape, input.gt, input.plane, createNoopLogger())
  if (!truth.ok) {
    return {
      ok: false,
      code: 'contradiction',
      detail: `different-subjects inside a same-subject chain: ${truth.chain.join(' → ')}`,
    }
  }
  const first = replayTape(input.tape, factory(), input.plane)
  const second = replayTape(input.tape, factory(), input.plane)
  if (first.hash !== second.hash) {
    return {
      ok: false,
      code: 'nondeterministic',
      detail: `two replays hashed ${first.hash.slice(0, 12)} and ${second.hash.slice(0, 12)}`,
    }
  }
  const seq = buildMetricSequence(truth.truth, first, finalIdResolver(first))
  const h = computeHota(seq)
  const c = computeClear(seq)
  const i = computeIdentity(seq)
  const o = computeOperatorMetrics(truth.truth, first)
  return {
    ok: true,
    tracker: first.tracker,
    warnings: warningsOf(input, truth.truth.ambiguousRelations),
    ms: now() - started,
    metrics: {
      HOTA: h.HOTA,
      DetA: h.DetA,
      AssA: h.AssA,
      IDF1: i.IDF1,
      MOTA: c.MOTA,
      IDSW: c.IDSW,
      Frag: c.Frag,
      idsPerPresence: o.idsPerPresence,
      resplitShare: o.resplitShare,
      swapsPer100: o.swapsPer100,
      mergesPer100: o.mergesPer100,
      stationaryBreaks: o.stationaryBreaks,
      duplicateNotifications: o.duplicateNotifications,
      finalIdLatencyP50: o.finalIdLatencyP50,
      finalIdLatencyP95: o.finalIdLatencyP95,
      tracksPerIdentityHour: o.tracksPerIdentityHour,
      unscorableTracks: o.unscorableTracks,
      frames: first.frames.length,
    },
  }
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

/** One `key  value` line per metric, in `METRIC_KEYS` order. */
export function formatMetricRow(row: MetricRow): readonly string[] {
  return METRIC_KEYS.map((k) => `  ${k.padEnd(24)}${fmt(row[k])}`)
}
