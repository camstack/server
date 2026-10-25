/**
 * Corpus KPI strip — globals on the strip; per-camera breakdown in a popover
 * (top 8 by unannotated desc; row click applies the camera filter).
 *
 * Counts come from an answered query only — pending is not rendered as zero (D315).
 */
import type { RetrainCorpusKpi, RetrainCorpusKpiCameraRow } from '@camstack/types'
import {
  Button,
  GRID_QUICK_STATS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  StatCard,
} from '@camstack/ui-library'
import { Camera, CheckCircle2, CircleDashed, ImageIcon, PencilLine } from 'lucide-react'
import { useMemo, useState, type JSX } from 'react'
import { useT, type TFn } from '../../i18n/index.js'

export interface CorpusKpiBarProps {
  /** `undefined` while the KPI query has not answered. */
  readonly kpi: RetrainCorpusKpi | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  readonly deviceNames: ReadonlyMap<number, string>
  readonly onSelectCamera: (deviceId: number) => void
}

const TOP_N = 8

function cameraLabel(deviceId: number, names: ReadonlyMap<number, string>, t: TFn): string {
  return names.get(deviceId) ?? t('kpi.cameraFallback', { id: deviceId })
}

function formatPct(pct: number | null): string {
  if (pct === null) return '—'
  return `${(pct * 100).toFixed(0)}%`
}

function sortByUnannotatedDesc(
  rows: readonly RetrainCorpusKpiCameraRow[],
): readonly RetrainCorpusKpiCameraRow[] {
  return [...rows].toSorted((a, b) => {
    if (b.unannotated !== a.unannotated) return b.unannotated - a.unannotated
    return a.deviceId - b.deviceId
  })
}

export function CorpusKpiBar({
  kpi,
  isLoading,
  isError,
  deviceNames,
  onSelectCamera,
}: CorpusKpiBarProps): JSX.Element {
  const { t } = useT()
  const [showAll, setShowAll] = useState(false)
  const sorted = useMemo(() => (kpi === undefined ? [] : sortByUnannotatedDesc(kpi.cameras)), [kpi])
  const visible = showAll ? sorted : sorted.slice(0, TOP_N)

  return (
    <div className="space-y-3" data-testid="corpus-kpi-bar">
      {isLoading && kpi === undefined ? (
        <div className={GRID_QUICK_STATS}>
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
          <Skeleton className="h-16 rounded-md" />
        </div>
      ) : null}

      {isError && kpi === undefined ? (
        <p className="text-xs text-danger" role="alert">
          {t('kpi.couldNotLoad')}
        </p>
      ) : null}

      {kpi !== undefined ? (
        <div className={GRID_QUICK_STATS}>
          <StatCard icon={ImageIcon} label={t('kpi.total')} value={kpi.total} />
          <StatCard icon={CircleDashed} label={t('kpi.unannotated')} value={kpi.unannotated} />
          <StatCard icon={PencilLine} label={t('kpi.annotated')} value={kpi.annotated} />
          <StatCard icon={CheckCircle2} label={t('kpi.complete')} value={kpi.complete} />
        </div>
      ) : null}

      {kpi !== undefined && kpi.cameras.length > 0 ? (
        <Popover>
          <PopoverTrigger
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-foreground hover:bg-surface-hover"
            data-testid="corpus-kpi-per-camera"
          >
            <Camera className="h-3 w-3" />
            {t('kpi.perCamera')}
          </PopoverTrigger>
          <PopoverContent className="w-80 max-h-[60vh] overflow-y-auto p-2 space-y-1">
            <p className="px-1 pb-1 text-[10px] text-foreground-subtle">{t('kpi.perCameraHint')}</p>
            <ul className="space-y-0.5" data-testid="corpus-kpi-camera-list">
              {visible.map((row) => {
                const localTotal = row.unannotated + row.annotated + row.complete
                const localPct = localTotal === 0 ? 0 : row.complete / localTotal
                return (
                  <li key={row.deviceId}>
                    {/* ui-check-ok: full-row pick target; Button chrome breaks list denseness */}
                    <button
                      type="button"
                      className="w-full rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-surface-hover"
                      onClick={() => {
                        onSelectCamera(row.deviceId)
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium text-foreground">
                          {cameraLabel(row.deviceId, deviceNames, t)}
                        </span>
                        <span className="shrink-0 text-foreground-muted">
                          {formatPct(row.pctOfCorpus)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-foreground-subtle">
                        <span>{t('kpi.open', { count: row.unannotated })}</span>
                        <span>{t('kpi.inProgress', { count: row.annotated })}</span>
                        <span>{t('kpi.done', { count: row.complete })}</span>
                      </div>
                      <div
                        className="mt-1 h-1 overflow-hidden rounded-full bg-border"
                        aria-hidden="true"
                      >
                        <div
                          className="h-full bg-success/60"
                          style={{ width: `${String(Math.round(localPct * 100))}%` }} // ui-check-ok: computed bar geometry
                        />
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
            {!showAll && sorted.length > TOP_N ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => {
                  setShowAll(true)
                }}
              >
                {t('kpi.showAll', { count: sorted.length })}
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
