/**
 * Live tab — per-node runner metrics + per-camera table.
 *
 * Two queries:
 *  - `pipelineRunner.getLocalMetrics({nodeId})` for aggregate runner state
 *  - `pipelineRunner.getAllCameraMetrics({nodeId})` for the per-camera rows
 *
 * Both refetch every 2 seconds while the tab is visible. Trace modal stub
 * is out of scope for this first pass.
 */

import {
  DataTable,
  getPhaseVisual,
  usePipelineRunnerGetAllCameraMetrics,
  usePipelineRunnerGetLocalMetrics,
  useUiText,
} from '@camstack/ui-library'
import { useEventInvalidation } from '../../../hooks/useEventInvalidation'
import { useTranslation } from 'react-i18next'
import { formatNumeric } from '@camstack/ui-library'

interface NodeLiveTabProps {
  readonly nodeId: string
  readonly refreshToken: number
}

export function NodeLiveTab({ nodeId, refreshToken: _refreshToken }: NodeLiveTabProps) {
  const uiText = useUiText()
  const { t } = useTranslation()
  // Both queries are driven by the runner's snapshot events.
  useEventInvalidation(['pipelineRunner', 'getLocalMetrics'], ['pipeline.runner-load-snapshot'])
  useEventInvalidation(
    ['pipelineRunner', 'getAllCameraMetrics'],
    ['pipeline.camera-metrics-snapshot'],
  )

  const { data: metrics } = usePipelineRunnerGetLocalMetrics({ nodeId })
  const { data: cameras } = usePipelineRunnerGetAllCameraMetrics({ nodeId })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">
          {t('pipeline.nodeLiveTab.liveStatus', 'Live status')}
        </h3>
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'pipeline.nodeLiveTab.runtimeMetricsForTheRunner',
            'Runtime metrics for the runner instance on this node. Refreshes every 2s.',
          )}
        </p>
      </div>

      {/* Aggregate cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label={t('pipeline.nodeLiveTab.inferenceLatency', 'Inference latency')}
          value={metrics ? `${metrics.avgInferenceTimeMs.toFixed(0)} ms` : '—'}
        />
        <MetricCard
          label={t('pipeline.nodeLiveTab.activeCameras', 'Active cameras')}
          value={metrics ? String(metrics.activeCameras) : '—'}
        />
        <MetricCard
          label={t('pipeline.nodeLiveTab.throttled', 'Throttled')}
          value={metrics ? String(metrics.throttledCameras) : '—'}
        />
        <MetricCard
          label={t('pipeline.nodeLiveTab.queueDepth', 'Queue depth')}
          value={metrics ? String(metrics.queueDepth) : '—'}
        />
      </div>

      {/* Per-camera table */}
      <DataTable
        rows={cameras ?? []}
        rowKey={(cam) => cam.deviceId}
        emptyMessage={t(
          'pipeline.nodeLiveTab.noCamerasAttachedToThis',
          'No cameras attached to this runner',
        )}
        columns={[
          {
            mobile: 'primary',
            key: 'camera',
            header: t('pipeline.nodeLiveTab.camera', 'Camera'),
            render: (cam) => cam.deviceId,
          },
          {
            mobile: 'keep',
            key: 'phase',
            header: t('pipeline.nodeLiveTab.phase', 'Phase'),
            render: (cam) => (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full ${getPhaseVisual(cam.phase, uiText).badgeClass}`}
              >
                {getPhaseVisual(cam.phase, uiText).label}
              </span>
            ),
          },
          {
            mobile: 'keep',
            key: 'fps',
            header: t('pipeline.nodeLiveTab.actualFps', 'Actual FPS'),
            align: 'right',
            render: (cam) => formatNumeric(cam.actualFps, undefined),
          },
          {
            mobile: 'hidden',
            key: 'queue',
            header: t('pipeline.nodeLiveTab.queue', 'Queue'),
            align: 'right',
            render: (cam) => cam.queueDepth ?? 0,
          },
          {
            mobile: 'hidden',
            key: 'inference',
            header: t('pipeline.nodeLiveTab.inferenceMs', 'Inference ms'),
            align: 'right',
            render: (cam) => cam.avgInferenceTimeMs.toFixed(0),
          },
        ]}
      />
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
