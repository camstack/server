/**
 * CameraStatusStrip — compact horizontal pill row showing every camera
 * assigned to the given agent (or the whole cluster when `nodeId` is
 * omitted) with its live phase + fps.
 *
 * Reads from the `pipeline.camera-metrics-snapshot` event stream so the
 * strip ticks at ~1 Hz without polling (`useCameraMetricsSnapshots`). Used by
 * the node Pipeline tab to surface "what each camera is doing
 * right now" alongside the (step, agent) defaults grid.
 */
import { useMemo } from 'react'
import {
  PhaseIcon,
  getPhaseVisual,
  usePipelineOrchestratorGetPipelineAssignments,
  useUiText,
} from '@camstack/ui-library'

import { useDeviceList } from '../../hooks/useDevice'
import {
  type CameraMetricsSnapshot,
  useCameraMetricsSnapshots,
} from './assignments/use-camera-metrics'
import { useTranslation } from 'react-i18next'

interface CameraStatusStripProps {
  /**
   * Restrict pills to cameras assigned to this agent. When omitted the
   * strip lists every camera with a live snapshot in the cluster.
   */
  readonly nodeId?: string
  readonly title?: string
}

export function CameraStatusStrip({ nodeId, title }: CameraStatusStripProps) {
  const uiText = useUiText()
  const { t } = useTranslation()
  const { data: devices } = useDeviceList()
  const { data: assignments } = usePipelineOrchestratorGetPipelineAssignments(undefined)

  const deviceNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices ?? []) map.set(d.id, d.name)
    return map
  }, [devices])

  const allowedDeviceIds = useMemo(() => {
    if (!nodeId) return null
    const set = new Set<number>()
    for (const a of assignments ?? []) {
      if (a.agentNodeId === nodeId) set.add(a.deviceId)
    }
    return set
  }, [nodeId, assignments])

  const snapshots = useCameraMetricsSnapshots(nodeId)

  const visible = useMemo(() => {
    const out: CameraMetricsSnapshot[] = []
    for (const snap of snapshots.values()) {
      if (allowedDeviceIds && !allowedDeviceIds.has(snap.deviceId)) continue
      out.push(snap)
    }
    out.sort((a, b) => a.deviceId - b.deviceId)
    return out
  }, [snapshots, allowedDeviceIds])

  if (visible.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle italic">
        {title ?? t('pipeline.cameraStatusStrip.cameras', 'Cameras')}: no live snapshots yet
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">
          {title ?? t('pipeline.cameraStatusStrip.cameras', 'Cameras')}
        </span>
        <span className="text-[10px] text-foreground-subtle">{visible.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((snap) => {
          const name = deviceNameById.get(snap.deviceId) ?? `#${snap.deviceId}`
          const phaseCfg = getPhaseVisual(snap.metrics.phase, uiText)
          return (
            <div
              key={snap.deviceId}
              title={t(
                'pipeline.cameraStatusStrip.fpsMsInferQ',
                '{{name}} · {{label}} · {{value3}} fps · {{value4}}ms infer · q={{queueDepth}}',
                {
                  name,
                  label: phaseCfg.label,
                  value3: snap.metrics.actualFps.toFixed(1),
                  value4: snap.metrics.avgInferenceTimeMs.toFixed(0),
                  queueDepth: snap.metrics.queueDepth,
                },
              )}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${phaseCfg.badgeClass}`}
            >
              <PhaseIcon phase={snap.metrics.phase} className="h-2.5 w-2.5" />
              <span className="font-medium text-foreground/90 max-w-[220px] truncate">{name}</span>
              <span className="font-mono tabular-nums">{snap.metrics.actualFps.toFixed(1)}</span>
              <span className="opacity-60">{t('common.fpsWord')}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
