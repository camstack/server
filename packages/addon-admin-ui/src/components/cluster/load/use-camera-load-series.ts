/**
 * The per-camera load series in the browser.
 *
 * ## No new sampling anywhere
 *
 * Two sources, both of which already exist:
 *
 * 1. `metrics.node-processes-snapshot` — the fan-out every node emits on the
 *    operator's FIXED cadence whether or not anyone is watching. This hook
 *    subscribes; it does not ask for it. It supplies the observed process list
 *    (for the unclaimed bucket) and, more importantly, the BEAT.
 * 2. `system.getLoadContributions` — an inert read. It persists nothing, runs
 *    no timer and starts no sampler; it reads `/proc/<pid>` for the children
 *    the addons already claimed, at the moment it is asked. Its own docblock
 *    says it "is answered on whatever beat the caller already has", and this
 *    is that caller: it is re-read when a snapshot arrives, so the two sources
 *    describe the same instant and the cadence is the operator's, not one this
 *    page invented.
 *
 * There is no interval of our own, and nothing is read while this panel is
 * closed.
 *
 * ## The window is NOT durable
 *
 * The per-addon charts above read `metricsProvider.getLoadSeries`, which
 * merges the node's in-memory ring with the hub's `metrics:node-load-samples`
 * table — six hours by default, surviving a page close and a node restart.
 * Contributions have no such tier: nothing stores them, and a rate has to be
 * differenced from two readings this page saw itself. So this window starts
 * when the panel opens. The panel used to STATE that in a sentence; it now
 * shows it, because each chart's x axis is wall-clock and its first tick IS
 * the moment differencing began.
 */
import { useEffect, useRef, useState } from 'react'
import { useEventStreamLatest, useSystemGetLoadContributions } from '@camstack/ui-library'
import {
  foldContributionsByCamera,
  type CameraLoadBucket,
  type ObservedProcess,
} from './camera-load-fold'
import {
  appendCameraRates,
  orderCamerasByLoad,
  ratesBetween,
  type CameraLoadSeries,
  type ContributionReading,
} from './camera-load-rates'
import { contributionsOnNode, type NodeScope } from './contribution-origin'

interface ProcessesSnapshotPayload {
  readonly nodeId: string
  readonly processes: readonly ObservedProcess[]
  readonly timestamp: number
}

export interface CameraLoadSeriesState {
  /** One series per camera, heaviest first. */
  readonly series: readonly CameraLoadSeries[]
  /**
   * Processes on this node that NO contribution claims. `null` when no
   * snapshot has arrived — "we did not look" and "nothing is unclaimed" must
   * not render the same.
   */
  readonly unclaimed: CameraLoadBucket | null
  /** True until the first contribution read has come back. */
  readonly loading: boolean
  /** The read failed — reported, never rendered as "nothing is running". */
  readonly error: string | null
}

/**
 * @param scope which node this panel is showing. Contributions arrive
 * cluster-wide and every pid comparison below is only true once narrowed to
 * one node — see `contribution-origin.ts`.
 */
export function useCameraLoadSeries(scope: NodeScope): CameraLoadSeriesState {
  const snapshot = useEventStreamLatest<ProcessesSnapshotPayload>(
    'metrics.node-processes-snapshot',
    (data) => data.nodeId === scope.nodeId,
  )

  const contributions = useSystemGetLoadContributions(undefined, {
    // No interval: the refetch below rides the snapshot fan-out, so the read
    // happens on the cluster's cadence and never on one of this page's own.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  })

  const [series, setSeries] = useState<ReadonlyMap<number, CameraLoadSeries>>(new Map())
  const previousReadingRef = useRef<ContributionReading | null>(null)

  // Re-read the contributions when a new snapshot lands. `refetch` is held in
  // a ref so the effect depends on the BEAT alone — including the function
  // would re-run it on every render react-query re-creates.
  const refetchRef = useRef(contributions.refetch)
  refetchRef.current = contributions.refetch
  const stamp = snapshot?.timestamp
  useEffect(() => {
    if (stamp === undefined) return
    void refetchRef.current()
  }, [stamp])

  // A node change starts a new window. Carrying the previous node's readings
  // forward would difference one machine's counters against another's.
  useEffect(() => {
    setSeries(new Map())
    previousReadingRef.current = null
  }, [scope.nodeId, scope.isHub])

  const data = contributions.data
  const dataUpdatedAt = contributions.dataUpdatedAt
  useEffect(() => {
    if (data === undefined || dataUpdatedAt === 0) return
    const entries = contributionsOnNode(data, scope)
    const reading: ContributionReading = { atMs: dataUpdatedAt, entries }
    const previous = previousReadingRef.current
    previousReadingRef.current = reading
    if (previous === null) return
    const samples = ratesBetween(previous, reading)
    if (samples.length === 0) return
    setSeries((held) => appendCameraRates(held, samples))
    // `scope` is a fresh object each render; its two fields are the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dataUpdatedAt, scope.nodeId, scope.isHub])

  const nodeEntries = data === undefined ? [] : contributionsOnNode(data, scope)
  const observed = snapshot?.processes
  // The fold runs over EVERY role, including the ones the chart refuses: the
  // unclaimed arithmetic is about processes, and a streaming child that the
  // chart will not draw is still very much claimed. Only the unclaimed bucket
  // is taken from it — a camera bucket here would total families the chart is
  // refusing to plot, and the two numbers would disagree on the same panel.
  const buckets = foldContributionsByCamera(nodeEntries, observed)

  return {
    series: orderCamerasByLoad(series),
    unclaimed: buckets.find((b) => b.kind === 'unclaimed') ?? null,
    loading: contributions.isPending,
    error: contributions.error === null ? null : contributions.error.message,
  }
}
