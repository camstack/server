/**
 * The latest `pipeline.camera-metrics-snapshot` per camera — the ~1 Hz stream
 * the runner already publishes, so nothing here polls. A camera with no
 * snapshot for 10 s drops out: a stopped session must not keep its last fps.
 */
import { useEffect, useState } from 'react'
import { useLiveEvent } from '@camstack/ui-library'

export interface CameraMetricsSnapshot {
  readonly deviceId: number
  readonly nodeId: string
  readonly metrics: {
    readonly phase: string
    readonly actualFps: number
    readonly avgInferenceTimeMs: number
    readonly queueDepth: number
    readonly droppedFrames: number
    readonly configuredFps: number
  }
  readonly timestamp: number
}

const STALE_AFTER_MS = 10_000
const SWEEP_EVERY_MS = 5_000

/** Snapshots by camera id; `nodeId` keeps only the ones reported from that node. */
export function useCameraMetricsSnapshots(
  nodeId?: string,
): ReadonlyMap<number, CameraMetricsSnapshot> {
  const [snapshots, setSnapshots] = useState<ReadonlyMap<number, CameraMetricsSnapshot>>(new Map())

  useLiveEvent<CameraMetricsSnapshot>('pipeline.camera-metrics-snapshot', (evt) => {
    const payload = evt.data
    if (typeof payload.deviceId !== 'number') return
    if (nodeId !== undefined && payload.nodeId !== nodeId) return
    setSnapshots((prev) => new Map(prev).set(payload.deviceId, payload))
  })

  useEffect(() => {
    if (snapshots.size === 0) return
    const interval = setInterval(() => {
      setSnapshots((prev) => {
        const cutoff = Date.now() - STALE_AFTER_MS
        const fresh = [...prev].filter(([, snap]) => snap.timestamp >= cutoff)
        return fresh.length === prev.size ? prev : new Map(fresh)
      })
    }, SWEEP_EVERY_MS)
    return () => clearInterval(interval)
  }, [snapshots.size])

  return snapshots
}
