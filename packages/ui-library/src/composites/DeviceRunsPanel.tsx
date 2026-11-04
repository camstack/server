/**
 * DeviceRunsPanel — the runs of an appliance, newest first, on the device's
 * History tab: start, end, duration, energy, peak and mean power, outcome.
 * A row opens the run's window (the run plus a margin) in the history view.
 *
 * Presentational: the caller reads the runs (`useDeviceRuns`) and decides
 * whether the device has any — the panel never answers "no runs" itself, an
 * unanswered query is not an empty one (D315). A measurement that failed is
 * `—`, never `0` (D393).
 */
import { useState, type JSX } from 'react'
import type { DeviceRun } from '@camstack/types'
import { useUiText, type UiTextFn } from '../contexts/ui-text'
import { Badge } from '../primitives/badge'
import { CollapsibleCard } from '../primitives/collapsible-card'
import { DataTable, TABLE_SCROLL_MAX_H, type DataColumn } from './data-table'
import {
  formatKwh,
  formatRunDuration,
  formatWatts,
  runDurationMs,
  runStatus,
  runTone,
  runWindow,
  type RunStatus,
} from './device-history/history-runs'
import type { HistoryWindow } from './device-history/history-window'

export interface DeviceRunsPanelProps {
  /** Runs as the cap returned them (newest first); never an unanswered query. */
  readonly runs: readonly DeviceRun[]
  /** The instant an open run counts up to. */
  readonly now: number
  /** A row was chosen: show this window. */
  readonly onSelectWindow: (window: HistoryWindow) => void
  readonly className?: string
}

function statusLabel(status: RunStatus, t: UiTextFn): string {
  switch (status) {
    case 'running':
      return t('uiLibrary.history.runs.status.running', 'Running')
    case 'completed':
      return t('uiLibrary.history.runs.status.completed', 'Completed')
    case 'aborted':
      return t('uiLibrary.history.runs.status.aborted', 'Aborted')
    case 'error':
      return t('uiLibrary.history.runs.status.error', 'Error')
    case 'unknown':
      return t('uiLibrary.history.runs.status.unknown', 'Unknown')
  }
}

const formatStamp = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  })

function runColumns(now: number, t: UiTextFn): readonly DataColumn<DeviceRun>[] {
  return [
    {
      key: 'start',
      header: t('uiLibrary.history.runs.start', 'Start'),
      render: (r) => formatStamp(r.startedAt),
      sortValue: (r) => r.startedAt,
    },
    {
      key: 'end',
      header: t('uiLibrary.history.runs.end', 'End'),
      render: (r) =>
        r.state === 'open' || r.endedAt === null
          ? t('uiLibrary.history.runs.runningSince', 'Running since {{time}}', {
              time: formatStamp(r.startedAt),
            })
          : formatStamp(r.endedAt),
      sortValue: (r) => r.endedAt,
    },
    {
      key: 'duration',
      header: t('uiLibrary.history.runs.duration', 'Duration'),
      align: 'right',
      render: (r) => formatRunDuration(runDurationMs(r, now)),
      sortValue: (r) => runDurationMs(r, now),
    },
    {
      key: 'energy',
      header: t('uiLibrary.history.runs.energy', 'Energy'),
      align: 'right',
      render: (r) => formatKwh(r.detail.energyKwh),
      sortValue: (r) => r.detail.energyKwh,
    },
    {
      key: 'peak',
      header: t('uiLibrary.history.runs.peak', 'Peak'),
      align: 'right',
      render: (r) => formatWatts(r.detail.peakW),
      sortValue: (r) => r.detail.peakW,
    },
    {
      key: 'avg',
      header: t('uiLibrary.history.runs.avg', 'Average'),
      align: 'right',
      render: (r) => formatWatts(r.detail.avgW),
      sortValue: (r) => r.detail.avgW,
    },
    {
      key: 'outcome',
      header: t('uiLibrary.history.runs.outcome', 'Outcome'),
      render: (r) => {
        const status = runStatus(r)
        return <Badge variant={runTone(status)}>{statusLabel(status, t)}</Badge>
      },
      notSortableReason: t('uiLibrary.history.runs.outcomeNoSort', 'Outcomes have no order'),
    },
  ]
}

export function DeviceRunsPanel({
  runs,
  now,
  onSelectWindow,
  className,
}: DeviceRunsPanelProps): JSX.Element {
  const t = useUiText()
  const [expanded, setExpanded] = useState(true)
  return (
    <CollapsibleCard
      className={className}
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-foreground truncate">
            {t('uiLibrary.history.runs.title', 'Runs')}
          </span>
          <span className="text-[10px] text-foreground-subtle shrink-0">
            {t(
              'uiLibrary.history.runs.count',
              { one: '{{count}} run', other: '{{count}} runs' },
              { count: runs.length },
            )}
          </span>
        </div>
      }
    >
      <DataTable
        columns={runColumns(now, t)}
        rows={runs}
        rowKey={(r) => r.runId}
        onRowClick={(r) => onSelectWindow(runWindow(r, now))}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        bordered={false}
        minWidthPx={640}
      />
    </CollapsibleCard>
  )
}
