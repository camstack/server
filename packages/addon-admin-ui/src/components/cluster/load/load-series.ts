/**
 * Per-node load series in the browser — accumulating what the server sends and
 * what the bus delivers into ONE map, without doubling a point.
 *
 * ## Where the data comes from, and why nothing new is sampled
 *
 * `native-metrics` emits `metrics.node-processes-snapshot` on a FIXED cadence
 * on every node, whether or not anyone is watching, and
 * `metrics.node-resources-snapshot` every 5 s. Both carry `nodeId`. Nothing in
 * this file asks a node for anything: the page subscribes to a fan-out that
 * already exists.
 *
 * That is deliberate. `docs/architecture/load-ledger.md` documents a system
 * whose defects were, four times over, a reader that made the thing it was
 * measuring worse. A charts page that installed its own high-frequency
 * per-node sampler would be the fifth.
 *
 * ## Where the history comes from (D251, D260)
 *
 * `metricsProvider.getLoadSeries` is the ONE reader over both retention tiers
 * — the node's in-memory ring for the hot window, the hub's
 * `metrics:node-load-samples` table for the cold one. It returns the series
 * ALREADY FOLDED per function and ALREADY REDUCED to the number of points this
 * page asked for, because six hours at the 10 s cadence is 2 160 snapshots per
 * node and shipping them here to be discarded is the cost the whole subsystem
 * exists to avoid.
 *
 * ## The fold is not a copy
 *
 * Live events arrive as raw process snapshots and are folded HERE, with the
 * same `foldSnapshotByFunction` the server uses — imported from
 * `@camstack/types`, not reimplemented. Two copies of that arithmetic is two
 * charts that disagree about the same node.
 *
 * ## What a bucket means, and what a gap means
 *
 * A reduced point carries the bucket's MAX in the unsuffixed fields and its
 * MIN alongside; a live point is a one-sample bucket where the two are equal.
 * A missing interval is MISSING — never zero, never interpolated, never the
 * previous value held over. Emission is fixed-cadence, so a gap means exactly
 * one thing: nobody reported.
 */

import {
  foldSnapshotByFunction,
  ROOT_BUCKET_KEY,
  UNATTRIBUTED_BUCKET_KEY,
  type LoadBucketKind,
  type LoadPoint,
  type LoadProcessRow,
} from '@camstack/types'

export { foldSnapshotByFunction, ROOT_BUCKET_KEY, UNATTRIBUTED_BUCKET_KEY }
export type { LoadBucketKind, LoadPoint, LoadProcessRow }

/** A function's series across every point the page has seen. */
export interface LoadSeries {
  readonly key: string
  readonly kind: LoadBucketKind
  readonly points: readonly LoadPoint[]
}

/** One function's series exactly as `metricsProvider.getLoadSeries` returns it. */
export interface RetainedFunctionSeries {
  readonly key: string
  readonly kind: LoadBucketKind
  readonly points: readonly LoadPoint[]
}

/**
 * Bounded history: 720 points.
 *
 * The server reduces to whatever the page asks for, so this is a backstop
 * against a long live session rather than the window itself — 720 at the 10 s
 * cadence is two hours of unreduced live points. The cap is on POINTS, not on
 * age.
 */
export const LOAD_SERIES_MAX_POINTS = 720

/**
 * Merge one point into a bucket's points, oldest-first, WITHOUT duplicating a
 * timestamp already present.
 *
 * The dedup is the whole reason the page can seed from the server and still
 * keep listening: the seed and the live event are two deliveries of the same
 * fan-out, they can arrive in either order, and a chart that drew both would
 * show every point twice. Identity is `atMs` — one snapshot per node per tick,
 * so a timestamp already in the series IS the same snapshot.
 *
 * The common case (a live point newer than everything held) is an append and
 * costs one comparison.
 */
function mergePoint(points: readonly LoadPoint[], point: LoadPoint): readonly LoadPoint[] {
  const last = points.at(-1)
  if (last === undefined) return [point]
  if (point.atMs > last.atMs) return [...points, point]
  if (points.some((p) => p.atMs === point.atMs)) return points
  return [...points, point].toSorted((a, b) => a.atMs - b.atMs)
}

/** Merge one already-folded point into the accumulated map. Pure. */
function withPoint(
  previous: ReadonlyMap<string, LoadSeries>,
  key: string,
  kind: LoadBucketKind,
  point: LoadPoint,
): ReadonlyMap<string, LoadSeries> {
  const existing = previous.get(key)
  const points = mergePoint(existing?.points ?? [], point)
  if (existing !== undefined && points === existing.points) return previous
  const next = new Map<string, LoadSeries>(previous)
  next.set(key, {
    key,
    kind,
    points: points.slice(Math.max(0, points.length - LOAD_SERIES_MAX_POINTS)),
  })
  return next
}

/**
 * Append one LIVE snapshot to the accumulated series.
 *
 * Pure and immutable — returns a new map, never touches `previous`. A function
 * that disappears from the snapshot KEEPS its accumulated points (its runner
 * crashed; the history of how it got there is the interesting part) but stops
 * gaining new ones. Idempotent on `atMs`.
 */
export function appendSnapshot(
  previous: ReadonlyMap<string, LoadSeries>,
  rows: readonly LoadProcessRow[],
  atMs: number,
): ReadonlyMap<string, LoadSeries> {
  let next = previous
  for (const bucket of foldSnapshotByFunction(rows, atMs)) {
    next = withPoint(next, bucket.key, bucket.kind, bucket.point)
  }
  return next
}

/**
 * Fold the server's already-reduced series into the accumulated map.
 *
 * Order-independent by construction: it goes through the same `mergePoint`, so
 * a seed that overlaps points the live stream already delivered adds only what
 * is genuinely missing.
 */
export function seedSeries(
  previous: ReadonlyMap<string, LoadSeries>,
  retained: readonly RetainedFunctionSeries[],
): ReadonlyMap<string, LoadSeries> {
  let next = previous
  for (const fn of retained) {
    for (const point of fn.points) next = withPoint(next, fn.key, fn.kind, point)
  }
  return next
}

/** Newest `atMs` anywhere in the series, or `null` when nothing is held. */
export function newestPointAtMs(series: ReadonlyMap<string, LoadSeries>): number | null {
  let newest: number | null = null
  for (const s of series.values()) {
    const last = s.points.at(-1)
    if (last !== undefined && (newest === null || last.atMs > newest)) newest = last.atMs
  }
  return newest
}

/**
 * A live snapshot more than two cadences past what we hold means points were
 * MISSED — a backgrounded tab, a dropped websocket, a hub restart — and the
 * server can fill the hole.
 *
 * Two cadences, not one, so a single late tick is not read as a gap. The
 * cadence is configurable (5-60 s) and this is the ceiling of that range
 * doubled: a threshold derived from the shipped default would fire constantly
 * on a cluster configured at 60 s.
 */
export const LOAD_SERIES_GAP_MS = 120_000

/** Should the client re-read the server to fill a hole? */
export function hasSeriesGap(newestHeldAtMs: number | null, incomingAtMs: number): boolean {
  if (newestHeldAtMs === null) return false
  return incomingAtMs - newestHeldAtMs > LOAD_SERIES_GAP_MS
}

/**
 * Order functions for display: heaviest CPU first, using the newest point.
 *
 * Falls back to the lifetime average when the split is unknown so a node whose
 * thread scan is unavailable still gets a sensible order rather than an
 * alphabetical one. Ties break on key, so the order is stable across renders.
 */
export function orderSeriesByLoad(series: ReadonlyMap<string, LoadSeries>): readonly LoadSeries[] {
  const weight = (s: LoadSeries): number => {
    const last = s.points.at(-1)
    if (last === undefined) return -1
    if (last.cpuMainPercent !== null && last.cpuGcPercent !== null) {
      return last.cpuMainPercent + last.cpuGcPercent
    }
    return last.cpuLifetimePercent
  }
  return [...series.values()].toSorted((a, b) => {
    const d = weight(b) - weight(a)
    return d !== 0 ? d : a.key.localeCompare(b.key)
  })
}

/** Does the node have a usable thread split at all? Drives the UI's caveat. */
export function hasThreadSplit(series: ReadonlyMap<string, LoadSeries>): boolean {
  for (const s of series.values()) {
    const last = s.points.at(-1)
    if (last && last.cpuMainPercent !== null) return true
  }
  return false
}
