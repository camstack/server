/**
 * CamerasOverview — the Pipeline → Cameras tab.
 *
 * Full replacement of the old per-camera React-Flow chart: one card per
 * camera, every operational pipeline parameter visible at once, problems
 * surfaced loudly. Cameras with errors sort to the top so a stalled
 * pipeline is the first thing an operator sees.
 *
 * Data: one batched `getCameraStatuses` poll (5 s) + the 1 Hz
 * `pipeline.camera-metrics-snapshot` live overlay — see
 * `use-cameras-overview.ts`.
 */
import { useMemo } from 'react'
import { deriveCameraProblems } from './camera-card-model'
import { CameraPipelineCard } from './CameraPipelineCard'
import { useCamerasOverview } from './use-cameras-overview'
import type { CameraOverviewRow } from './use-cameras-overview'
import { Trans, useTranslation } from 'react-i18next'

export interface CamerasOverviewProps {
  /** Bumped by the page-level Refresh button — forces an immediate refetch. */
  readonly refreshToken: number
}

interface RankedRow {
  readonly row: CameraOverviewRow
  readonly errorCount: number
  readonly warningCount: number
}

export function CamerasOverview({ refreshToken }: CamerasOverviewProps) {
  const { t } = useTranslation()
  const { rows, liveMetrics, onlineNodes, isLoading } = useCamerasOverview(refreshToken)

  // Rank: errors first, then warnings, then healthy — stable by name within
  // each band (rows arrive name-sorted from the hook).
  const ranked = useMemo<readonly RankedRow[]>(() => {
    const withProblems = rows.map((row) => {
      const problems = row.status !== undefined ? deriveCameraProblems(row.status) : []
      return {
        row,
        errorCount: problems.filter((problem) => problem.severity === 'error').length,
        warningCount: problems.filter((problem) => problem.severity === 'warning').length,
      }
    })
    return [...withProblems].sort((a, b) => {
      if (a.errorCount !== b.errorCount) return b.errorCount - a.errorCount
      if (a.warningCount !== b.warningCount) return b.warningCount - a.warningCount
      return 0
    })
  }, [rows])

  const summary = useMemo(() => {
    let active = 0
    let issues = 0
    for (const entry of ranked) {
      if (entry.errorCount > 0 || entry.warningCount > 0) issues += 1
      const phase = liveMetrics.get(entry.row.deviceId)?.phase ?? entry.row.status?.detection?.phase
      if (phase === 'active') active += 1
    }
    return { total: ranked.length, active, issues }
  }, [ranked, liveMetrics])

  if (isLoading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-foreground-subtle">
        {t('cameras.camerasOverview.loadingCameraPipelines', 'Loading camera pipelines…')}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-foreground-subtle">
        {t('cameras.camerasOverview.noCamerasFound', 'No cameras found')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto flex flex-col gap-3 px-4 py-4">
        {/* Summary strip */}
        <div className="flex items-center gap-4 text-[11px] text-foreground-subtle px-1">
          <span>
            <Trans
              i18nKey="pipeline.camerasOverview.camerasTotal"
              values={{ count: summary.total }}
              components={{ b: <span className="font-semibold text-foreground" /> }}
            />
          </span>
          <span>
            <Trans
              i18nKey="pipeline.camerasOverview.activelyInferring"
              values={{ count: summary.active }}
              components={{ b: <span className="font-semibold text-success" /> }}
            />
          </span>
          <span>
            <span
              className={`font-semibold ${summary.issues > 0 ? 'text-danger' : 'text-foreground'}`}
            >
              {summary.issues}
            </span>{' '}
            {t('cameras.camerasOverview.withIssues', 'with issues')}
          </span>
          <span className="ml-auto hidden sm:inline text-[10px]">
            {t(
              'cameras.camerasOverview.polledEvery5SDetection',
              'polled every 5 s · detection metrics live at 1 Hz',
            )}
          </span>
        </div>

        {ranked.map(({ row }) => (
          <CameraPipelineCard
            key={row.deviceId}
            deviceId={row.deviceId}
            name={row.name}
            online={row.online}
            status={row.status}
            live={liveMetrics.get(row.deviceId)}
            onlineNodes={onlineNodes}
          />
        ))}
      </div>
    </div>
  )
}
