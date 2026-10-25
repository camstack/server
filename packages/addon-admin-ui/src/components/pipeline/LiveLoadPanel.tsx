/**
 * Live-load panel: cluster or per-node runtime capacity snapshot.
 *
 * Derives all numbers from `pipeline.camera-metrics-snapshot` events
 * — the SAME event stream that feeds CameraAssignmentsTable's status
 * column. This guarantees the cards and the per-camera rows always
 * show consistent numbers (same source, same timestamp).
 *
 * Two modes:
 *  - Cluster mode (no `nodeId`) — aggregate cards + per-agent table
 *  - Node mode (`nodeId`) — per-node cards only
 */
import { useMemo, useState } from 'react'

import {
  useClusterNodes,
  useLiveEvent,
  usePipelineOrchestratorGetAudioNodeLoad,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
interface CameraSnapshot {
  readonly deviceId: number
  readonly nodeId: string
  readonly metrics: {
    readonly phase: string
    readonly actualFps: number
    readonly configuredFps: number
    readonly avgInferenceTimeMs: number
    readonly queueDepth: number
  }
  readonly timestamp: number
}

interface LiveLoadPanelProps {
  readonly refreshToken: number
  readonly nodeId?: string
}

export function LiveLoadPanel({ refreshToken: _refreshToken, nodeId }: LiveLoadPanelProps) {
  const { t } = useTranslation()
  const [snapshots, setSnapshots] = useState<ReadonlyMap<number, CameraSnapshot>>(new Map())
  const { nodes } = useClusterNodes()

  // Subscribe to the same event stream as CameraAssignmentsTable
  useLiveEvent<CameraSnapshot>('pipeline.camera-metrics-snapshot', (evt) => {
    const payload = evt.data
    if (typeof payload?.deviceId !== 'number') return
    setSnapshots((prev) => {
      const next = new Map(prev)
      next.set(payload.deviceId, payload)
      return next
    })
  })

  // Audio node load — lightweight, keep as query
  const { data: audioNodeLoad } = usePipelineOrchestratorGetAudioNodeLoad(undefined)

  const audioDevicesByNode = useMemo(() => {
    const map = new Map<string, number>()
    for (const n of audioNodeLoad ?? []) map.set(n.nodeId, n.deviceCount)
    return map
  }, [audioNodeLoad])

  // Aggregate per-agent from live snapshots
  const agentStats = useMemo(() => {
    const byNode = new Map<
      string,
      {
        attachedCameras: number
        activeCameras: number
        totalFps: number
        totalInferenceWeighted: number
        queueDepth: number
      }
    >()

    const cutoff = Date.now() - 30_000
    for (const snap of snapshots.values()) {
      if (snap.timestamp < cutoff) continue
      const nid = snap.nodeId ?? 'hub'
      const existing = byNode.get(nid) ?? {
        attachedCameras: 0,
        activeCameras: 0,
        totalFps: 0,
        totalInferenceWeighted: 0,
        queueDepth: 0,
      }
      existing.attachedCameras++
      if (snap.metrics.phase === 'active') existing.activeCameras++
      existing.totalFps += snap.metrics.actualFps
      existing.totalInferenceWeighted += snap.metrics.avgInferenceTimeMs
      existing.queueDepth += snap.metrics.queueDepth
      byNode.set(nid, existing)
    }

    return byNode
  }, [snapshots])

  // Agent id → display name from topology
  const agentNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) m.set(n.id, n.shortName)
    return m
  }, [nodes])

  // Cluster-wide totals
  const clusterMetrics = useMemo(() => {
    let attachedCameras = 0
    let activeCameras = 0
    let totalFps = 0
    let totalInferenceWeighted = 0
    let totalQueueDepth = 0

    for (const s of agentStats.values()) {
      attachedCameras += s.attachedCameras
      activeCameras += s.activeCameras
      totalFps += s.totalFps
      totalInferenceWeighted += s.totalInferenceWeighted
      totalQueueDepth += s.queueDepth
    }

    const avgInferenceTimeMs = attachedCameras > 0 ? totalInferenceWeighted / attachedCameras : 0

    return {
      totalAgents: nodes.length,
      onlineAgents: nodes.filter((n) => n.isOnline).length,
      attachedCameras,
      activeCameras,
      avgInferenceTimeMs,
      queueDepth: totalQueueDepth,
      totalFps,
    }
  }, [agentStats, nodes])

  if (nodeId) {
    const stats = agentStats.get(nodeId)
    return (
      <div className="@container/liveload">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          {t('pipeline.liveLoadPanel.liveLoad', 'Live load')}
        </h3>
        {/* Container-query grid: 2-up by default, 3-up around 28rem,
            5-up at 48rem+ — reacts to the panel width, not viewport.
            With the master-detail layout the right pane often stays
            below the viewport `md` breakpoint, so viewport-based
            classes flip to 5 columns prematurely. */}
        <div className="grid grid-cols-2 @md/liveload:grid-cols-3 @3xl/liveload:grid-cols-5 gap-2 mb-3">
          <MetricCard label="FPS" value={stats ? stats.totalFps.toFixed(1) : '—'} />
          <MetricCard
            label={t('pipeline.liveLoadPanel.activeAttached', 'Active / Attached')}
            value={stats ? `${stats.activeCameras}/${stats.attachedCameras}` : '—'}
          />
          <MetricCard
            label={t('pipeline.liveLoadPanel.avgInferMs', 'Avg infer ms')}
            value={
              stats && stats.attachedCameras > 0
                ? (stats.totalInferenceWeighted / stats.attachedCameras).toFixed(0)
                : '—'
            }
          />
          <MetricCard
            label={t('pipeline.liveLoadPanel.queue', 'Queue')}
            value={stats ? String(stats.queueDepth) : '—'}
          />
          <MetricCard
            label={t('pipeline.liveLoadPanel.audio', 'Audio')}
            value={String(audioDevicesByNode.get(nodeId) ?? '—')}
          />
        </div>
      </div>
    )
  }

  // Cluster mode
  const agentRows = [...agentStats.entries()].toSorted(([a], [b]) => {
    if (a === 'hub') return -1
    if (b === 'hub') return 1
    return a.localeCompare(b)
  })

  return (
    <div className="@container/liveload">
      <h3 className="text-sm font-semibold text-foreground mb-2">
        {t('pipeline.liveLoadPanel.liveLoad', 'Live load')}
      </h3>

      <div className="grid grid-cols-2 @md/liveload:grid-cols-3 @3xl/liveload:grid-cols-5 gap-2 sm:gap-3 mb-3">
        <MetricCard
          label={t('pipeline.liveLoadPanel.totalAgents', 'Total agents')}
          value={`${clusterMetrics.onlineAgents}/${clusterMetrics.totalAgents}`}
        />
        <MetricCard
          label={t('pipeline.liveLoadPanel.activeAttached', 'Active / Attached')}
          value={`${clusterMetrics.activeCameras}/${clusterMetrics.attachedCameras}`}
        />
        <MetricCard
          label={t('pipeline.liveLoadPanel.totalFps', 'Total FPS')}
          value={clusterMetrics.totalFps.toFixed(1)}
        />
        <MetricCard
          label={t('pipeline.liveLoadPanel.avgInferenceMs', 'Avg inference ms')}
          value={clusterMetrics.avgInferenceTimeMs.toFixed(0)}
        />
        <MetricCard
          label={t('pipeline.liveLoadPanel.queueDepth', 'Queue depth')}
          value={String(clusterMetrics.queueDepth)}
        />
      </div>

      {/* Per-agent table — wrap in `overflow-x-auto` so narrow panels
          scroll horizontally instead of clipping the right-most columns
          (Audio / Queue) like the screenshot in the responsive bug
          report. `min-w-[480px]` keeps each cell legible while scrolling. */}
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-xs min-w-[480px]">
          <thead className="bg-surface">
            <tr className="text-foreground-subtle text-[10px] uppercase tracking-wider">
              <th className="text-left px-3 py-2">{t('pipeline.liveLoadPanel.agent', 'Agent')}</th>
              <th className="text-right px-3 py-2">FPS</th>
              <th className="text-right px-3 py-2">
                {t('pipeline.liveLoadPanel.cameras', 'Cameras')}
              </th>
              <th className="text-right px-3 py-2">
                {t('pipeline.liveLoadPanel.inferenceMs', 'Inference ms')}
              </th>
              <th className="text-right px-3 py-2">{t('pipeline.liveLoadPanel.queue', 'Queue')}</th>
              <th className="text-right px-3 py-2">{t('pipeline.liveLoadPanel.audio', 'Audio')}</th>
            </tr>
          </thead>
          <tbody>
            {agentRows.map(([nid, s]) => (
              <tr key={nid} className="border-t border-border">
                <td className="px-3 py-2 text-foreground font-medium">
                  {agentNameById.get(nid) ?? nid}
                </td>
                <td className="px-3 py-2 text-right text-foreground">{s.totalFps.toFixed(1)}</td>
                <td className="px-3 py-2 text-right text-foreground">{s.attachedCameras}</td>
                <td className="px-3 py-2 text-right text-foreground">
                  {s.attachedCameras > 0
                    ? (s.totalInferenceWeighted / s.attachedCameras).toFixed(0)
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right text-foreground">{s.queueDepth}</td>
                <td className="px-3 py-2 text-right text-foreground">
                  {audioDevicesByNode.get(nid) ?? '—'}
                </td>
              </tr>
            ))}
            {agentRows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-4 text-center text-foreground-subtle text-[11px]"
                >
                  {t(
                    'pipeline.liveLoadPanel.noCameraMetricsReceivedYet',
                    'No camera metrics received yet',
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-foreground-subtle mb-1">
        {label}
      </div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
    </div>
  )
}
