/**
 * The ONE reader over both retention tiers.
 *
 * The hot window is the in-memory ring; the cold one is device-history raw
 * points. A caller never learns which tier a point came
 * from, and that is a hard requirement rather than a nicety: a second reader
 * is how two charts start disagreeing about the same node, and it is how "the
 * ring says X, the table says Y" becomes a question nobody can answer.
 *
 * Three things happen here, in this order, and each one is load-bearing:
 *
 * 1. **Merge and dedupe on `atMs`.** The two tiers OVERLAP by construction —
 *    the ring holds the last 180 snapshots and the table holds every snapshot
 *    the ring accepted, including those same 180. A snapshot present in both
 *    must contribute exactly once. Identity is `atMs`, because one node emits
 *    one snapshot per tick and a timestamp already held IS that snapshot. The
 *    HOT copy wins on a tie: it is the payload as it arrived, while the cold
 *    one has been through the storage encode.
 * 2. **Fold per function.** The chart draws one series per addon, so the fold
 *    happens here rather than in the browser.
 * 3. **Reduce, preserving the extremes.** See `load-series-fold.ts` for why
 *    the representative of a bucket is its MAX and never its mean.
 *
 * A GAP stays a gap through all three. Emission is fixed-cadence, so a missing
 * interval means one thing — nobody reported — and nothing here fills it in.
 */

import {
  foldSnapshotByFunction,
  reducePoints,
  resolveBucketMs,
  type LoadPoint,
  type LoadProcessRow,
} from '@camstack/types'
import type { RetainedProcess, RetainedSample } from './load-series-types.js'

/** One function's assembled series, before it is shaped for the wire. */
export interface FoldedSeries {
  readonly key: string
  readonly kind: 'addon' | 'root' | 'unattributed'
  readonly points: readonly LoadPoint[]
}

export interface MergeLoadSeriesInput {
  /** Cold samples, oldest-first. May overlap `hot` — that is expected. */
  readonly cold: readonly RetainedSample[]
  /** Hot samples, oldest-first. Wins over a cold sample at the same `atMs`. */
  readonly hot: readonly RetainedSample[]
  readonly cadenceMs: number
  /** Absent ⇒ no reduction. */
  readonly maxPoints?: number
}

export interface MergedLoadSeries {
  readonly series: readonly FoldedSeries[]
  readonly bucketMs: number
  readonly retainedSamples: number
  readonly oldestAtMs: number | null
}

/**
 * Merge the two tiers into one deduped, oldest-first list of samples.
 *
 * Exported because the dedup is the property worth testing on its own: a
 * doubled point is invisible in a total and obvious only as a chart that reads
 * twice as loud as the machine.
 */
export function mergeSamples(
  cold: readonly RetainedSample[],
  hot: readonly RetainedSample[],
): readonly RetainedSample[] {
  const byAt = new Map<number, RetainedSample>()
  for (const sample of cold) byAt.set(sample.atMs, sample)
  // Hot second, so it overwrites: the ring holds the payload as it arrived.
  for (const sample of hot) byAt.set(sample.atMs, sample)
  return [...byAt.values()].toSorted((a, b) => a.atMs - b.atMs)
}

/** `RetainedProcess` is already the fold's row shape — named, not re-derived. */
function toFoldRows(processes: readonly RetainedProcess[]): readonly LoadProcessRow[] {
  return processes
}

/**
 * Merge, fold and reduce. The whole read path in one pure function, so every
 * property that matters — dedup, peak survival, an empty bucket staying empty
 * — is testable without a database or a ring.
 */
export function mergeLoadSeries(input: MergeLoadSeriesInput): MergedLoadSeries {
  const samples = mergeSamples(input.cold, input.hot)
  if (samples.length === 0) {
    return {
      series: [],
      bucketMs: input.cadenceMs,
      retainedSamples: 0,
      oldestAtMs: null,
    }
  }

  const byKey = new Map<string, { kind: FoldedSeries['kind']; points: LoadPoint[] }>()
  for (const sample of samples) {
    for (const bucket of foldSnapshotByFunction(toFoldRows(sample.processes), sample.atMs)) {
      const held = byKey.get(bucket.key)
      if (held === undefined) byKey.set(bucket.key, { kind: bucket.kind, points: [bucket.point] })
      else held.points.push(bucket.point)
    }
  }

  const oldestAtMs = samples[0]?.atMs ?? null
  const newestAtMs = samples.at(-1)?.atMs ?? oldestAtMs
  const spanMs =
    oldestAtMs === null || newestAtMs === null ? 0 : newestAtMs - oldestAtMs + input.cadenceMs
  const bucketMs =
    input.maxPoints === undefined
      ? input.cadenceMs
      : resolveBucketMs(spanMs, input.cadenceMs, input.maxPoints)

  const origin = oldestAtMs ?? 0
  const series: FoldedSeries[] = [...byKey.entries()].map(([key, held]) => ({
    key,
    kind: held.kind,
    points: bucketMs > input.cadenceMs ? reducePoints(held.points, bucketMs, origin) : held.points,
  }))

  // Heaviest first, so the caller does not have to sort to render. Ties break
  // on key so the order is stable across reads.
  const weight = (s: FoldedSeries): number => {
    const last = s.points.at(-1)
    if (last === undefined) return -1
    if (last.cpuMainPercent !== null && last.cpuGcPercent !== null) {
      return last.cpuMainPercent + last.cpuGcPercent
    }
    return last.cpuLifetimePercent
  }

  return {
    series: series.toSorted((a, b) => {
      const d = weight(b) - weight(a)
      return d !== 0 ? d : a.key.localeCompare(b.key)
    }),
    bucketMs,
    retainedSamples: samples.length,
    oldestAtMs,
  }
}
