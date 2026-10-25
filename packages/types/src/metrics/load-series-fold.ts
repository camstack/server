/**
 * Folding a process snapshot into per-FUNCTION load points, and reducing a
 * long series to a drawable number of them WITHOUT losing a peak.
 *
 * ## Why this lives in `@camstack/types`
 *
 * Two processes need the identical arithmetic and neither may import the
 * other: the hub's `native-metrics` folds the retained series before it leaves
 * the node (server-side reduction — the browser must never be handed 2 160
 * points per series to throw away), and the admin UI folds the LIVE
 * `metrics.node-processes-snapshot` events it is already subscribed to. Two
 * copies of a fold is two charts that disagree about the same node.
 *
 * Browser-safe by construction: no imports at all, so it stays on the root
 * `@camstack/types` entry (the node-only surface is `@camstack/types/node`).
 *
 * ## The reduction, and why min/max rather than a mean
 *
 * Six hours at the 10 s cadence is 2 160 points per series. A chart a few
 * hundred pixels wide has to reduce them, and the reduction is exactly where a
 * chart lies:
 *
 * - a **mean per bucket** smears the peak across the bucket and it disappears;
 * - **one sample every N** skips the peak outright.
 *
 * Either way the tool built to find peaks stops showing peaks. So a bucket
 * carries `min`, `max` and the number of samples that landed in it, and the
 * REPRESENTATIVE value of a bucket — the field the chart already reads — is
 * the **max**. A mean is still derivable where it is wanted; a lost peak is
 * not recoverable from anything.
 *
 * An unreduced series is a series of one-sample buckets, where `min === max`
 * and every field equals the raw value. Reduced and unreduced are therefore
 * the same shape, and the caller cannot tell which it is looking at — which is
 * the whole reason there is one reader.
 *
 * ## An empty bucket stays empty
 *
 * A bucket with no samples is ABSENT from the output. It is never emitted with
 * zeros, never interpolated, and never carried forward from the previous
 * point. Emission is fixed-cadence, so a gap means one thing only: **nobody
 * reported**. Filling it would destroy the single property that fixed cadence
 * was adopted to buy.
 */

/**
 * One process row as both tiers carry it.
 *
 * Deliberately NOT the full `NodeProcess`. `command` is absent because it is
 * the fattest field in a snapshot and the same identical string on every
 * runner — the runner id travels in the environment, not in argv — while
 * `addonId` is the short identifier that already names the process. Nothing
 * that draws or reduces this series has ever read `command`.
 */
export interface LoadProcessRow {
  readonly pid: number
  readonly addonId: string | null
  readonly classification: string
  /** `ps pcpu` — a LIFETIME average, not a rate. Always present. */
  readonly cpuPercent: number
  readonly memoryRssBytes: number
  /** Instantaneous main-thread CPU%, or `null` when unknown — never zero. */
  readonly cpuMainPercent: number | null
  /** Instantaneous V8-helper-pool CPU%, or `null` under the same rule. */
  readonly cpuGcPercent: number | null
}

/**
 * The bucket a process is attributed to.
 *
 * `addon` is the only attributed kind. `root` is the node's own supervisor and
 * `unattributed` is everything the cluster cannot name. They are separate
 * buckets rather than folded into a nearby addon precisely because nothing
 * licenses attributing them.
 */
export type LoadBucketKind = 'addon' | 'root' | 'unattributed'

/** Bucket key for rows no addon owns. Stable, so its series is continuous. */
export const UNATTRIBUTED_BUCKET_KEY = '__unattributed__'
export const ROOT_BUCKET_KEY = '__root__'

/**
 * One point of one function's series.
 *
 * The unsuffixed fields are the bucket's **maximum** — the peak-preserving
 * representative. `...Min` carries the other end so a caller can draw a band,
 * and `samples` says how many raw snapshots the bucket folded. For an
 * unreduced series `samples === 1` and each `...Min` equals its unsuffixed
 * twin.
 */
export interface LoadPoint {
  /** Bucket START, or the snapshot's own timestamp when unreduced. */
  readonly atMs: number
  /** Raw snapshots folded into this point. Never 0 — an empty bucket is absent. */
  readonly samples: number
  /**
   * Instantaneous CPU% of the function's own threads, or `null`.
   *
   * `null` PROPAGATES: a bucket is `null` unless every process in every
   * snapshot it covers reported a split. Summing only the processes that
   * answered produces a smaller number that is indistinguishable, on a chart,
   * from a complete one — the exact failure this surface exists to prevent.
   */
  readonly cpuMainPercent: number | null
  readonly cpuMainPercentMin: number | null
  readonly cpuGcPercent: number | null
  readonly cpuGcPercentMin: number | null
  /** Lifetime-average CPU%, summed. Always known — and never a rate. */
  readonly cpuLifetimePercent: number
  readonly cpuLifetimePercentMin: number
  readonly memoryRssBytes: number
  readonly memoryRssBytesMin: number
  readonly processCount: number
  readonly processCountMin: number
}

export interface LoadBucket {
  readonly key: string
  readonly kind: LoadBucketKind
  readonly point: LoadPoint
}

function bucketFor(row: LoadProcessRow): { key: string; kind: LoadBucketKind } {
  if (row.addonId !== null) return { key: row.addonId, kind: 'addon' }
  if (row.classification === 'root') return { key: ROOT_BUCKET_KEY, kind: 'root' }
  return { key: UNATTRIBUTED_BUCKET_KEY, kind: 'unattributed' }
}

/** Round to one decimal — the precision both producers already emit at. */
function deci(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Fold one snapshot into one point per function.
 *
 * Produces a ONE-SAMPLE point: `min === max` on every field, `samples === 1`.
 * That is what lets a live event and a reduced server bucket sit in the same
 * series without the consumer knowing which is which.
 */
export function foldSnapshotByFunction(
  rows: readonly LoadProcessRow[],
  atMs: number,
): readonly LoadBucket[] {
  interface Accumulator {
    kind: LoadBucketKind
    main: number
    gc: number
    lifetime: number
    memory: number
    count: number
    splitKnown: boolean
  }
  const acc = new Map<string, Accumulator>()
  for (const row of rows) {
    const { key, kind } = bucketFor(row)
    const cur = acc.get(key) ?? {
      kind,
      main: 0,
      gc: 0,
      lifetime: 0,
      memory: 0,
      count: 0,
      splitKnown: true,
    }
    const known = row.cpuMainPercent !== null && row.cpuGcPercent !== null
    acc.set(key, {
      kind: cur.kind,
      main: cur.main + (row.cpuMainPercent ?? 0),
      gc: cur.gc + (row.cpuGcPercent ?? 0),
      lifetime: cur.lifetime + row.cpuPercent,
      memory: cur.memory + row.memoryRssBytes,
      count: cur.count + 1,
      splitKnown: cur.splitKnown && known,
    })
  }
  return [...acc.entries()].map(([key, a]) => {
    const main = a.splitKnown ? deci(a.main) : null
    const gc = a.splitKnown ? deci(a.gc) : null
    const lifetime = deci(a.lifetime)
    return {
      key,
      kind: a.kind,
      point: {
        atMs,
        samples: 1,
        cpuMainPercent: main,
        cpuMainPercentMin: main,
        cpuGcPercent: gc,
        cpuGcPercentMin: gc,
        cpuLifetimePercent: lifetime,
        cpuLifetimePercentMin: lifetime,
        memoryRssBytes: a.memory,
        memoryRssBytesMin: a.memory,
        processCount: a.count,
        processCountMin: a.count,
      },
    }
  })
}

/** The narrower of two bounds, treating `null` (UNKNOWN) as absorbing. */
function minNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a < b ? a : b
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a > b ? a : b
}

/** Merge `next` into `held`, keeping the widest [min, max] of each field. */
function mergePoints(held: LoadPoint, next: LoadPoint, atMs: number): LoadPoint {
  return {
    atMs,
    samples: held.samples + next.samples,
    cpuMainPercent: maxNullable(held.cpuMainPercent, next.cpuMainPercent),
    cpuMainPercentMin: minNullable(held.cpuMainPercentMin, next.cpuMainPercentMin),
    cpuGcPercent: maxNullable(held.cpuGcPercent, next.cpuGcPercent),
    cpuGcPercentMin: minNullable(held.cpuGcPercentMin, next.cpuGcPercentMin),
    cpuLifetimePercent: Math.max(held.cpuLifetimePercent, next.cpuLifetimePercent),
    cpuLifetimePercentMin: Math.min(held.cpuLifetimePercentMin, next.cpuLifetimePercentMin),
    memoryRssBytes: Math.max(held.memoryRssBytes, next.memoryRssBytes),
    memoryRssBytesMin: Math.min(held.memoryRssBytesMin, next.memoryRssBytesMin),
    processCount: Math.max(held.processCount, next.processCount),
    processCountMin: Math.min(held.processCountMin, next.processCountMin),
  }
}

/**
 * The bucket width that brings `spanMs` down to at most `maxPoints` points,
 * snapped up to a whole multiple of the sampling cadence.
 *
 * Returns `cadenceMs` (no reduction) when the span already fits. A caller that
 * asks for a `maxPoints` of 0 or less gets no reduction rather than an
 * infinite bucket — a nonsensical request must not produce a plausible chart.
 */
export function resolveBucketMs(spanMs: number, cadenceMs: number, maxPoints: number): number {
  if (maxPoints <= 0 || cadenceMs <= 0 || spanMs <= 0) return Math.max(cadenceMs, 1)
  const wanted = spanMs / maxPoints
  if (wanted <= cadenceMs) return cadenceMs
  return Math.ceil(wanted / cadenceMs) * cadenceMs
}

/**
 * Reduce one function's points into buckets of `bucketMs`, preserving the
 * extremes.
 *
 * Points are expected oldest-first and are returned oldest-first. A bucket
 * with no samples is ABSENT — not zero, not interpolated, not the previous
 * value held over.
 */
export function reducePoints(
  points: readonly LoadPoint[],
  bucketMs: number,
  origin: number,
): readonly LoadPoint[] {
  if (bucketMs <= 0 || points.length === 0) return points
  const buckets = new Map<number, LoadPoint>()
  for (const point of points) {
    const start = origin + Math.floor((point.atMs - origin) / bucketMs) * bucketMs
    const held = buckets.get(start)
    buckets.set(
      start,
      held === undefined ? { ...point, atMs: start } : mergePoints(held, point, start),
    )
  }
  return [...buckets.values()].toSorted((a, b) => a.atMs - b.atMs)
}
