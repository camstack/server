/**
 * NodeDetailHeader — summary line shown above the per-node tabs.
 *
 * Hardware info comes from the shared `nodes.topology` cache
 * (event-invalidated by `useClusterNodes`).
 *
 * Live runner metrics are read DIRECTLY from the
 * `pipeline.runner-load-snapshot` event payload via
 * `useEventStreamLatest` — no tRPC roundtrip, push-driven.
 */

import { useClusterTopology, useEventStreamLatest } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

interface NodeDetailHeaderProps {
  readonly nodeId: string
  readonly refreshToken: number
}

interface RunnerLoadSnapshot {
  readonly nodeId: string
  readonly load: {
    readonly nodeId: string
    readonly attachedCameras: number
    readonly activeCameras: number
    readonly avgInferenceFps: number
    readonly avgInferenceTimeMs: number
    readonly queueDepthTotal: number
    readonly hardware: { readonly hasGpu: boolean; readonly inferenceBackend?: string }
  }
  readonly timestamp: number
}

export function NodeDetailHeader({ nodeId, refreshToken: _refreshToken }: NodeDetailHeaderProps) {
  const { t } = useTranslation()
  // The hardware line (cpu model, cores, RAM, engines) lives only on the full
  // topology row, so this header wants the diagram — through the hook that
  // bootstraps once and then lives off the pushed snapshot (D317).
  const { nodes: topology } = useClusterTopology()

  const node = topology?.find((n) => n.id === nodeId)

  // Read runner-load directly from the snapshot event payload —
  // filter by nodeId so each header instance only updates on its
  // own runner's tick.
  const snapshot = useEventStreamLatest<RunnerLoadSnapshot>(
    'pipeline.runner-load-snapshot',
    (data) => data.nodeId === nodeId,
  )
  const load = snapshot?.load ?? null

  if (!node) {
    return (
      <div className="px-6 py-4 border-b border-border">
        <div className="text-xs text-foreground-subtle">
          {t('pipeline.nodeDetailHeader.nodeNotFound', 'Node not found:')} {nodeId}
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-4 border-b border-border">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-base font-semibold text-foreground">{node.name}</h2>
        {node.isOnline ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-success/10 text-success">
            {t('common.online')}
          </span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-danger/10 text-danger">
            {t('common.offline')}
          </span>
        )}
        {node.isHub && (
          <span className="text-[9px] uppercase tracking-wider text-foreground-subtle border border-border rounded px-1 py-0.5">
            {t('common.hubWord')}
          </span>
        )}
      </div>
      <div className="text-[11px] text-foreground-subtle flex items-center gap-2 flex-wrap">
        <span>{node.cpuModel ?? 'CPU'}</span>
        <span>•</span>
        <span>{t('common.coresCount', { count: node.cpuCores })}</span>
        <span>•</span>
        <span>{Math.round(node.memoryMB / 1024)} GB</span>
        {load && (
          <>
            <span>•</span>
            <span>
              {t('pipeline.nodeDetailHeader.cameras', {
                attached: load.attachedCameras,
                active: load.activeCameras,
              })}
            </span>
            <span>•</span>
            <span>
              {t('pipeline.nodeDetailHeader.avgInference', {
                ms: load.avgInferenceTimeMs.toFixed(0),
              })}
            </span>
            <span>•</span>
            <span>{t('pipeline.nodeDetailHeader.queue', { depth: load.queueDepthTotal })}</span>
            {load.hardware.hasGpu && (
              <>
                <span>•</span>
                <span className="text-success">GPU</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
