/**
 * Score one evaluation run against its dataset's labels, and diff it against
 * a reference run. Pure: no I/O, so the specs drive it directly.
 *
 * Every ratio over nothing is `null`, never `0`: "no person was labelled" and
 * "every person was missed" must not read the same.
 */
import type {
  EvalBox,
  EvalCounts,
  EvalDetection,
  EvalDiff,
  EvalLatency,
  EvalPhantomStats,
  EvalSampleBody,
  EvalScore,
  EvalStat,
} from '../benchmark-schemas.js'
import {
  containment,
  EVAL_SIZE_BUCKETS,
  isEvalMacro,
  matchBoxes,
  percentile,
  type ScoredBox,
  sizeBucket,
} from './eval-geometry.js'

/** A leftover prediction mostly inside a crowd/ignore region is neither TP nor FP (COCO iscrowd). */
export const EVAL_IGNORE_CONTAINMENT = 0.5

/** How many samples the diff names, worst first. */
export const EVAL_DIFF_WORST_SAMPLES = 15

/** What the scorer needs to know about one sample of the dataset. */
export interface EvalScoringSample {
  readonly sampleId: string
  readonly nativeWidth: number
  readonly nativeHeight: number
  /** `day`, `night-ir`, `low-light` … — `null` when the dataset does not say. */
  readonly lighting: string | null
}

/** One sample's truth. */
export interface EvalLabel {
  /** `reviewed`, `prelabel`, `coco` … — counted per report, never interpreted. */
  readonly status: string
  /** The subjects that are there. */
  readonly boxes: readonly ScoredBox[]
  /** Crowd / ignore regions: a prediction inside one is neither right nor wrong. */
  readonly ignore: readonly EvalBox[]
  /** `model_error` annotations: phantoms a model drew here and the operator rejected. */
  readonly phantoms: readonly ScoredBox[]
}

export type EvalPassOutput = 'final' | 'full'

interface MutableCounts {
  tp: number
  fp: number
  fn: number
}

type CountField = keyof MutableCounts

function ratio(num: number, den: number): number | null {
  return den > 0 ? Number((num / den).toFixed(3)) : null
}

function finalise(c: MutableCounts): EvalCounts {
  return { ...c, recall: ratio(c.tp, c.tp + c.fn), precision: ratio(c.tp, c.tp + c.fp) }
}

function bump(map: Map<string, MutableCounts>, key: string, field: CountField): void {
  const counts = map.get(key) ?? { tp: 0, fp: 0, fn: 0 }
  counts[field] += 1
  map.set(key, counts)
}

function finaliseSorted(map: ReadonlyMap<string, MutableCounts>): Record<string, EvalCounts> {
  return Object.fromEntries(
    [...map.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, finalise(v)]),
  )
}

/** Boxes a scorer may count: the three macros, never an `ignore` or other class. */
function relevant<T extends ScoredBox>(boxes: readonly T[]): readonly T[] {
  return boxes.filter((b) => isEvalMacro(b.macro))
}

/** The counters of one score, mutated while the samples are walked. */
interface ScoreAccumulator {
  readonly overall: MutableCounts
  readonly byClass: Map<string, MutableCounts>
  readonly bySize: Map<string, MutableCounts>
  readonly byLighting: Map<string, MutableCounts>
  readonly byClassSize: Map<string, MutableCounts>
}

function count(
  acc: ScoreAccumulator,
  field: CountField,
  box: ScoredBox,
  sample: EvalScoringSample,
): void {
  const size = sizeBucket(box.box, sample.nativeWidth, sample.nativeHeight)
  acc.overall[field] += 1
  bump(acc.byClass, box.macro, field)
  bump(acc.bySize, size, field)
  bump(acc.byLighting, sample.lighting ?? 'unknown', field)
  bump(acc.byClassSize, `${box.macro}/${size}`, field)
}

interface PhantomAccumulator {
  boxes: number
  repeated: number
  readonly byClass: Map<string, { boxes: number; repeated: number }>
}

/** A run REPEATS a phantom when it draws a same-class box over it again (one-to-one). */
function countPhantoms(
  acc: PhantomAccumulator,
  preds: readonly ScoredBox[],
  phantoms: readonly ScoredBox[],
): void {
  if (phantoms.length === 0) return
  const { pairs } = matchBoxes(preds, phantoms)
  const repeatedIdx = new Set(pairs.map((p) => p.gt))
  phantoms.forEach((phantom, i) => {
    const entry = acc.byClass.get(phantom.macro) ?? { boxes: 0, repeated: 0 }
    entry.boxes += 1
    acc.boxes += 1
    if (repeatedIdx.has(i)) {
      entry.repeated += 1
      acc.repeated += 1
    }
    acc.byClass.set(phantom.macro, entry)
  })
}

function finalisePhantoms(acc: PhantomAccumulator): EvalPhantomStats {
  return {
    boxes: acc.boxes,
    repeated: acc.repeated,
    repeatRate: ratio(acc.repeated, acc.boxes),
    byClass: Object.fromEntries(
      [...acc.byClass.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    ),
  }
}

/**
 * Recall and precision overall, per class, per size bucket, per lighting and
 * per class×size; the FP rate on frames with no labelled subject; and how
 * many rejected phantoms the run drew again.
 *
 * @param which `final` — the live output, second pass included; `full` — the full pass alone.
 */
export function scoreRun(
  samples: readonly EvalScoringSample[],
  labels: ReadonlyMap<string, EvalLabel>,
  results: ReadonlyMap<string, EvalSampleBody>,
  which: EvalPassOutput = 'final',
): EvalScore {
  const acc: ScoreAccumulator = {
    overall: { tp: 0, fp: 0, fn: 0 },
    byClass: new Map(),
    bySize: new Map(),
    byLighting: new Map(),
    byClassSize: new Map(),
  }
  const phantoms: PhantomAccumulator = { boxes: 0, repeated: 0, byClass: new Map() }
  const empty = { frames: 0, framesWithFp: 0, fpBoxes: 0 }
  const statuses = new Map<string, number>()
  let scored = 0
  let missing = 0
  for (const sample of samples) {
    const label = labels.get(sample.sampleId)
    if (label === undefined) continue
    statuses.set(label.status, (statuses.get(label.status) ?? 0) + 1)
    const result = results.get(sample.sampleId)
    if (result === undefined || !result.ok) {
      missing += 1
      continue
    }
    scored += 1
    const gts = relevant(label.boxes)
    const preds = relevant(result[which])
    const matched = matchBoxes(preds, gts)
    const unmatchedPreds = matched.unmatchedPreds.filter((pi) => {
      const pred = preds[pi]
      return (
        pred !== undefined &&
        !label.ignore.some((region) => containment(pred.box, region) >= EVAL_IGNORE_CONTAINMENT)
      )
    })
    for (const pair of matched.pairs) {
      const gt = gts[pair.gt]
      if (gt !== undefined) count(acc, 'tp', gt, sample)
    }
    for (const gi of matched.unmatchedGts) {
      const gt = gts[gi]
      if (gt !== undefined) count(acc, 'fn', gt, sample)
    }
    for (const pi of unmatchedPreds) {
      const pred = preds[pi]
      if (pred !== undefined) count(acc, 'fp', pred, sample)
    }
    if (gts.length === 0) {
      empty.frames += 1
      empty.fpBoxes += preds.length
      if (preds.length > 0) empty.framesWithFp += 1
    }
    countPhantoms(phantoms, preds, relevant(label.phantoms))
  }
  return {
    which,
    scored,
    missing,
    labelStatuses: Object.fromEntries(statuses),
    overall: finalise(acc.overall),
    byClass: finaliseSorted(acc.byClass),
    bySize: Object.fromEntries(
      EVAL_SIZE_BUCKETS.flatMap((k) => {
        const c = acc.bySize.get(k)
        return c === undefined ? [] : [[k, finalise(c)]]
      }),
    ),
    byLighting: finaliseSorted(acc.byLighting),
    byClassSize: finaliseSorted(acc.byClassSize),
    emptyFrames: { ...empty, fpFrameRate: ratio(empty.framesWithFp, empty.frames) },
    phantoms: finalisePhantoms(phantoms),
  }
}

function stat(values: readonly (number | null)[]): EvalStat {
  const measured = values.filter((v): v is number => v !== null)
  return { n: measured.length, p50: percentile(measured, 0.5), p95: percentile(measured, 0.95) }
}

/** Step latency p50/p95 over the samples that ran; an untimed sample is left out, never counted 0. */
export function latencyStats(results: ReadonlyMap<string, EvalSampleBody>): EvalLatency {
  const ran = [...results.values()].filter((r) => r.ok)
  const crops = ran.reduce((n, r) => n + r.timings.cropStepMs.length, 0)
  return {
    fullStepMs: stat(ran.map((r) => r.timings.fullStepMs)),
    fullPredictMs: stat(ran.map((r) => r.timings.fullPredictMs)),
    fullWallMs: stat(ran.map((r) => r.timings.fullWallMs)),
    frameStepMs: stat(ran.map((r) => r.timings.frameStepMs)),
    cropStepMs: stat(ran.flatMap((r) => r.timings.cropStepMs)),
    cropsPerFrame: ran.length > 0 ? Number((crops / ran.length).toFixed(3)) : null,
    flooredCropBoxes: ran.reduce((n, r) => n + r.flooredCount, 0),
    recoveredBoxes: ran.reduce(
      (n, r) => n + r.final.filter((d) => d.origin === 'recovered').length,
      0,
    ),
  }
}

/**
 * This run against a reference, per sample, on the FINAL output: a box the
 * reference produced that this run did not (`lost`) and the reverse
 * (`gained`). Independent of labels — it answers "does this device behave
 * like the reference", which labels cannot.
 */
export function diffRuns(
  samples: readonly EvalScoringSample[],
  results: ReadonlyMap<string, EvalSampleBody>,
  reference: ReadonlyMap<string, EvalSampleBody>,
  referenceRunId: string,
): EvalDiff {
  let both = 0
  let agreed = 0
  let lostTotal = 0
  let gainedTotal = 0
  const lostByClassSize = new Map<string, number>()
  const gainedByClassSize = new Map<string, number>()
  const worst: { sampleId: string; lost: EvalDetection[]; gained: EvalDetection[] }[] = []
  const bucketKey = (d: EvalDetection, s: EvalScoringSample): string =>
    `${d.macro}/${sizeBucket(d.box, s.nativeWidth, s.nativeHeight)}`
  for (const sample of samples) {
    const a = results.get(sample.sampleId)
    const b = reference.get(sample.sampleId)
    if (a === undefined || b === undefined || !a.ok || !b.ok) continue
    both += 1
    const dev = relevant(a.final)
    const ref = relevant(b.final)
    const { pairs, unmatchedPreds, unmatchedGts } = matchBoxes(dev, ref)
    agreed += pairs.length
    const lost = unmatchedGts.flatMap((i) => (ref[i] === undefined ? [] : [ref[i]]))
    const gained = unmatchedPreds.flatMap((i) => (dev[i] === undefined ? [] : [dev[i]]))
    lostTotal += lost.length
    gainedTotal += gained.length
    for (const d of lost) {
      const key = bucketKey(d, sample)
      lostByClassSize.set(key, (lostByClassSize.get(key) ?? 0) + 1)
    }
    for (const d of gained) {
      const key = bucketKey(d, sample)
      gainedByClassSize.set(key, (gainedByClassSize.get(key) ?? 0) + 1)
    }
    if (lost.length + gained.length > 0) worst.push({ sampleId: sample.sampleId, lost, gained })
  }
  const sortedRecord = (m: ReadonlyMap<string, number>): Record<string, number> =>
    Object.fromEntries([...m.entries()].toSorted(([x], [y]) => x.localeCompare(y)))
  return {
    referenceRunId,
    samples: both,
    agreedBoxes: agreed,
    lostVsRef: lostTotal,
    gainedVsRef: gainedTotal,
    boxAgreement: ratio(agreed, agreed + lostTotal + gainedTotal),
    lostByClassSize: sortedRecord(lostByClassSize),
    gainedByClassSize: sortedRecord(gainedByClassSize),
    worstSamples: worst
      .toSorted((x, y) => y.lost.length + y.gained.length - (x.lost.length + x.gained.length))
      .slice(0, EVAL_DIFF_WORST_SAMPLES),
  }
}
