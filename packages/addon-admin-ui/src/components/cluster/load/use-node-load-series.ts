/**
 * The per-node load series: seeded from the server's retained window, then
 * continued live off the bus.
 *
 * Adds ZERO load to any node. `metrics.node-processes-snapshot` is emitted on
 * a fixed cadence regardless of who is listening; `native-metrics` keeps the
 * last 180 in RAM and the hub keeps the operator's retention on disk (D251,
 * D260). This hook reads that ONCE per node — already folded and already
 * reduced server-side — then keeps listening to the same fan-out. No polling,
 * no per-node sampler, and no second copy of the window.
 *
 * The one guarantee that makes the two sources composable is in
 * `load-series.ts`: `appendSnapshot` is idempotent on `atMs`, so a seed and a
 * live event describing the same tick collapse into one point no matter which
 * lands first. On top of that, the read is asked to send only what we lack
 * (`sinceMs`), so the wire cost of filling a hole is the hole.
 */
import { useEffect, useRef, useState } from 'react'
import { useEventStreamLatest, useMetricsProviderGetLoadSeries } from '@camstack/ui-library'
import {
  appendSnapshot,
  hasSeriesGap,
  hasThreadSplit,
  newestPointAtMs,
  orderSeriesByLoad,
  seedSeries,
  type LoadProcessRow,
  type LoadSeries,
} from './load-series'

interface ProcessesSnapshotPayload {
  readonly nodeId: string
  readonly processes: readonly LoadProcessRow[]
  readonly timestamp: number
}

export interface NodeLoadSeries {
  /** Functions ordered heaviest-first by their newest sample. */
  readonly series: readonly LoadSeries[]
  /** Points accumulated so far — retained ones included. */
  readonly sampleCount: number
  /**
   * False when no process on this node reports a thread split: a non-Linux
   * node, or the very first snapshot after the page opened. The UI must SAY
   * so and fall back to the lifetime average rather than drawing zeros.
   */
  readonly threadSplitAvailable: boolean
  /** True until the node's retained series has been read at least once. */
  readonly loadingRetained: boolean
  /**
   * Did the DURABLE tier answer? `true` means the window came from the hub's
   * `metrics:node-load-samples` table as well as the node's in-memory ring —
   * six hours by default, surviving a page close AND a node restart. `false`
   * means the hot ring alone (an agent holds no table, or the store refused).
   *
   * Surfaced because "the last hour, in memory" and "the last six hours,
   * durable" are different promises and an operator must not have to guess
   * which one was kept. `null` before the first read answers.
   */
  readonly durable: boolean | null
  /**
   * What ONE returned point covers, in ms. Equals the cadence when the window
   * fitted without reduction; larger when the server reduced it, in which case
   * each point is a bucket carrying that bucket's MAX.
   */
  readonly bucketMs: number | null
  /** The fixed cluster-wide sampling cadence, in ms. */
  readonly cadenceMs: number | null
  /** Raw snapshots behind the answer, across both tiers. */
  readonly retainedSamples: number | null
}

/**
 * Points to ask the server for, per function.
 *
 * The server reduces the window to fit, PRESERVING min and max per bucket —
 * never a mean and never every Nth sample, either of which would hide the very
 * spike this chart exists to find. 720 is comfortably above any realistic
 * chart width, so a peak keeps a bucket close to its own width.
 */
export const DEFAULT_MAX_POINTS = 720

export function useNodeLoadSeries(nodeId: string, maxPoints = DEFAULT_MAX_POINTS): NodeLoadSeries {
  const snapshot = useEventStreamLatest<ProcessesSnapshotPayload>(
    'metrics.node-processes-snapshot',
    (data) => data.nodeId === nodeId,
  )
  const [series, setSeries] = useState<ReadonlyMap<string, LoadSeries>>(new Map())
  /**
   * Lower bound for the ring read. `undefined` = "give me everything you have"
   * (first open). It is raised ONLY when a gap is detected, never on every new
   * point — a bound that tracked the newest point would change the query key on
   * every tick and refetch forever.
   */
  const [resumeFromMs, setResumeFromMs] = useState<number | undefined>(undefined)

  // The newest `atMs` currently held, as a ref: the gap check runs inside the
  // live-event effect, which must not re-run just because a point was added.
  const newestHeldRef = useRef<number | null>(null)

  const { data: retained, isPending } = useMetricsProviderGetLoadSeries({
    forNodeId: nodeId,
    sinceMs: resumeFromMs,
    maxPoints,
  })

  useEffect(() => {
    if (retained === undefined) return
    setSeries((prev) => {
      const next = seedSeries(prev, retained.series)
      newestHeldRef.current = newestPointAtMs(next)
      return next
    })
  }, [retained])

  // Keyed on the snapshot's own timestamp so a re-render never re-appends the
  // same sample — the hook returns the SAME payload object until a new event
  // lands. (`appendSnapshot` would drop the duplicate anyway; not re-running is
  // cheaper than relying on it.)
  const stamp = snapshot?.timestamp
  useEffect(() => {
    if (snapshot === null || snapshot === undefined || stamp === undefined) return
    if (hasSeriesGap(newestHeldRef.current, stamp)) setResumeFromMs(newestHeldRef.current ?? 0)
    setSeries((prev) => {
      const next = appendSnapshot(prev, snapshot.processes, stamp)
      newestHeldRef.current = newestPointAtMs(next)
      return next
    })
    // `snapshot` is intentionally absent: `stamp` identifies it, and including
    // the object would re-run on every render that re-creates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])

  // A node change must not carry the previous node's history forward.
  useEffect(() => {
    setSeries(new Map())
    setResumeFromMs(undefined)
    newestHeldRef.current = null
  }, [nodeId])

  // Derived from what is actually held, not from a second piece of state that
  // could disagree with the charts it describes.
  let sampleCount = 0
  for (const s of series.values()) {
    sampleCount = Math.max(sampleCount, s.points.length)
  }

  return {
    series: orderSeriesByLoad(series),
    sampleCount,
    threadSplitAvailable: hasThreadSplit(series),
    loadingRetained: isPending,
    // Straight off the read, never inferred from the points held: a window
    // that happens to be long is not proof that a durable tier answered.
    durable: retained?.durable ?? null,
    bucketMs: retained?.bucketMs ?? null,
    cadenceMs: retained?.cadenceMs ?? null,
    retainedSamples: retained?.retainedSamples ?? null,
  }
}
