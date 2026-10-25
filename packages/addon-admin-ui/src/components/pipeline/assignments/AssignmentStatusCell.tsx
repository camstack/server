/**
 * A camera's live status in the assignment tables: phase, fps against the
 * configured fps, inference time, queue and drops — two fixed lines, so a
 * snapshot arriving or ageing out never changes the row's height.
 */
import { PhaseIcon, getPhaseVisual, useUiText } from '@camstack/ui-library'
import type { CameraMetricsSnapshot } from './use-camera-metrics'
import { useTranslation } from 'react-i18next'

export function AssignmentStatusCell({
  snap,
}: {
  readonly snap: CameraMetricsSnapshot | undefined
}) {
  const uiText = useUiText()
  const { t } = useTranslation()
  if (snap === undefined) {
    return (
      <div
        className="flex h-8 items-center text-[11px] text-foreground-subtle"
        title={t(
          'assignments.assignmentStatusCell.noMetricsInTheLast',
          'No metrics in the last 10 s — the camera has no session running',
        )}
      >
        {t('assignments.assignmentStatusCell.noLiveData', 'no live data')}
      </div>
    )
  }
  const { phase, actualFps, avgInferenceTimeMs, queueDepth, configuredFps, droppedFrames } =
    snap.metrics
  const visual = getPhaseVisual(phase, uiText)
  return (
    <div className="flex h-8 min-w-0 flex-col justify-center font-mono text-[10px] leading-tight tabular-nums">
      <span className={`inline-flex min-w-0 items-center gap-1 ${visual.textColor}`}>
        <PhaseIcon phase={phase} className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate font-semibold uppercase tracking-wider">{visual.label}</span>
        <span className="text-foreground">{actualFps.toFixed(1)}</span>
        <span className="text-foreground-subtle">
          {t('pipeline.assignmentStatusCell.configuredFps', { fps: configuredFps.toFixed(0) })}
        </span>
      </span>
      <span className="truncate text-foreground-subtle">
        <span className="text-foreground">{avgInferenceTimeMs.toFixed(0)}</span> ms
        {queueDepth > 0 && <span className="ml-1 text-warning">q{queueDepth}</span>}
        <span className={droppedFrames > 0 ? 'ml-1 text-warning' : 'ml-1'}>
          {t('pipeline.assignmentStatusCell.drops', { count: droppedFrames })}
        </span>
      </span>
    </div>
  )
}
