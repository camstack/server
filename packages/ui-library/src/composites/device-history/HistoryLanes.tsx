/**
 * The global History block: every visible point on ONE shared time axis. One
 * line lane per unit and one band lane for the on/off and enum series, drawn
 * with the same chart primitives as the single charts and tied to the same
 * synced cursor (`syncKey`).
 */
import { useMemo, type JSX } from 'react'
import type { DeviceHistoryQueryManyEntry } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { StateTimeline, type StateRowDef } from '../charts/StateTimeline'
import { booleanLabels, HistoryChart, type HistoryChartProps } from './HistoryChart'
import { historyLanes, type HistoryLane } from './history-lanes'
import { stateRow, type HistoryChartSpec } from './history-model'

export interface HistoryLanesProps
  extends Pick<HistoryChartProps, 'entryFor' | 'reads' | 'window' | 'compare' | 'syncKey'> {
  readonly charts: readonly HistoryChartSpec[]
}

function failure(entry: DeviceHistoryQueryManyEntry | undefined): string | null {
  return entry !== undefined && !entry.ok ? entry.error : null
}

export function HistoryLanes({
  charts,
  entryFor,
  reads,
  window,
  compare,
  syncKey,
}: HistoryLanesProps): JSX.Element | null {
  const t = useUiText()
  const lanes = useMemo<readonly HistoryLane[]>(
    () =>
      historyLanes(charts, (unit) =>
        unit === null ? t('uiLibrary.history.lanes.noUnit', 'Values') : unit,
      ),
    [charts, t],
  )
  if (lanes.length === 0) return null
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      data-testid="dc-history-lanes"
      aria-label={t('uiLibrary.history.lanes.title', 'All points on one time axis')}
    >
      {lanes.map((lane) =>
        lane.kind === 'unit' ? (
          <div key={lane.id} data-testid="dc-history-lane" data-lane={lane.id} className="min-w-0">
            <HistoryChart
              spec={lane.spec}
              entryFor={entryFor}
              reads={reads}
              window={window}
              compare={compare}
              syncKey={syncKey}
            />
          </div>
        ) : (
          <div key={lane.id} data-testid="dc-history-lane" data-lane="bands" className="min-w-0">
            <StateTimeline
              title={t('uiLibrary.history.lanes.bands', 'On / off')}
              range={window}
              syncKey={syncKey}
              pending={reads === null}
              rows={lane.specs.flatMap((spec): readonly StateRowDef[] => {
                if (failure(entryFor(spec.series.key, false)) !== null) return []
                const entry = entryFor(spec.series.key, false)
                const row = stateRow(
                  spec.series,
                  entry?.ok ? entry.result : undefined,
                  window.from,
                  window.to,
                )
                const labels = booleanLabels(spec.series.key, t)
                const boolean = spec.series.kind === 'boolean'
                return [
                  {
                    id: spec.id,
                    label: spec.title,
                    kind: boolean ? 'boolean' : 'enum',
                    states: row.states,
                    segments: row.segments,
                    totals: row.totals,
                    ...(boolean
                      ? { stateLabel: (s: string) => (s === 'true' ? labels.on : labels.off) }
                      : {}),
                  },
                ]
              })}
            />
            {lane.specs.map((spec) => {
              const error = failure(entryFor(spec.series.key, false))
              return error === null ? null : (
                <p key={spec.id} className="mt-1 text-xs text-danger" role="alert">
                  {t('uiLibrary.history.readFailed', 'This history could not be read: {{error}}', {
                    error: `${spec.title} — ${error}`,
                  })}
                </p>
              )
            })}
          </div>
        ),
      )}
    </section>
  )
}
