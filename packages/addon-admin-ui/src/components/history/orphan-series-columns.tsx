/**
 * The columns of the orphan-series review (D917). The series cell is the
 * History picker's: the series name, its device under it. The list to delete
 * from adds why it is orphan, its span and its points per tier; the outcome of
 * the last deletion adds what happened to each row.
 */
import type { DeviceHistoryOrphanSeries, DeviceHistoryTierRows } from '@camstack/types'
import { Badge, type DataColumn } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { totalRows, type OrphanDeleteOutcome, type OrphanOutcomeRow } from './orphan-series-model'

export type DeviceNames = ReadonlyMap<number, string>

const day = (ts: number): string =>
  new Date(ts).toLocaleDateString(undefined, { dateStyle: 'short' })

export function deviceLabel(
  s: DeviceHistoryOrphanSeries,
  names: DeviceNames,
  t: TFunction,
): string {
  const name = names.get(s.deviceId)
  if (name !== undefined) return name
  return s.reason === 'device-gone'
    ? t('history.orphans.deviceRemoved', '#{{id}} (removed)', { id: s.deviceId })
    : t('history.orphans.deviceId', '#{{id}}', { id: s.deviceId })
}

export function seriesLabel(s: DeviceHistoryOrphanSeries): string {
  const name = s.displayName ?? s.key
  return s.scope === '' ? name : `${name} · ${s.scope}`
}

function seriesColumn<T>(
  pick: (row: T) => DeviceHistoryOrphanSeries,
  names: DeviceNames,
  t: TFunction,
): DataColumn<T> {
  return {
    key: 'series',
    header: t('history.orphans.colSeries', 'Series'),
    render: (row) => {
      const s = pick(row)
      return (
        <div className="min-w-0 max-w-[16rem]">
          <div className="truncate text-foreground" title={s.key}>
            {seriesLabel(s)}
          </div>
          <div className="truncate text-[10px] text-foreground-subtle">
            {deviceLabel(s, names, t)}
          </div>
        </div>
      )
    },
    sortValue: (row) => `${deviceLabel(pick(row), names, t)} ${seriesLabel(pick(row))}`,
  }
}

const TIERS: readonly (keyof DeviceHistoryTierRows)[] = ['raw', '5m', '1h', '1d']

function tierHeader(tier: keyof DeviceHistoryTierRows, t: TFunction): string {
  return tier === 'raw'
    ? t('history.orphans.colRaw', 'Raw points')
    : tier === '5m'
      ? t('history.orphans.col5m', '5 min')
      : tier === '1h'
        ? t('history.orphans.col1h', '1 h')
        : t('history.orphans.col1d', '1 day')
}

export function orphanColumns(
  names: DeviceNames,
  t: TFunction,
): readonly DataColumn<DeviceHistoryOrphanSeries>[] {
  return [
    seriesColumn((s: DeviceHistoryOrphanSeries) => s, names, t),
    {
      key: 'reason',
      header: t('history.orphans.colReason', 'Reason'),
      render: (s) => (
        <div className="flex flex-col items-start gap-0.5">
          <Badge
            variant={s.reason === 'device-gone' ? 'warning' : 'neutral'}
            className="text-[10px]"
          >
            {s.reason === 'device-gone'
              ? t('history.orphans.deviceGone', 'Device removed')
              : t('history.orphans.undeclared', 'No longer declared')}
          </Badge>
          {s.missingSince !== null && (
            <span className="text-[10px] text-foreground-subtle">
              {t('history.orphans.since', 'since {{date}}', { date: day(s.missingSince) })}
            </span>
          )}
        </div>
      ),
      sortValue: (s) => s.reason,
    },
    {
      key: 'span',
      header: t('history.orphans.colSpan', 'Recorded'),
      render: (s) => (
        <span className="tabular-nums text-foreground-muted">
          {day(s.firstTs)} → {day(s.lastTs)}
        </span>
      ),
      sortValue: (s) => s.lastTs,
    },
    ...TIERS.map(
      (tier): DataColumn<DeviceHistoryOrphanSeries> => ({
        key: `rows-${tier}`,
        header: tierHeader(tier, t),
        align: 'right',
        render: (s) => (
          <span className="tabular-nums text-foreground-muted">
            {s.rows[tier].toLocaleString()}
          </span>
        ),
        sortValue: (s) => s.rows[tier],
      }),
    ),
  ]
}

function outcomeBadge(o: OrphanDeleteOutcome, t: TFunction): ReactNode {
  if (o.ok) {
    return (
      <Badge variant="success" className="text-[10px]">
        {t('history.orphans.deleted', {
          count: totalRows(o.deleted),
          points: totalRows(o.deleted).toLocaleString(),
          defaultValue_one: 'Deleted · {{points}} point',
          defaultValue_other: 'Deleted · {{points}} points',
        })}
      </Badge>
    )
  }
  const label =
    o.reason === 'request-failed'
      ? t('history.orphans.requestFailed', 'Not sent: {{message}}', { message: o.message })
      : o.reason === 'not-orphan'
        ? t('history.orphans.refusedNotOrphan', 'Kept: no longer orphan')
        : o.reason === 'not-found'
          ? t('history.orphans.refusedNotFound', 'Already gone')
          : t('history.orphans.refusedFailed', 'The hub could not delete it')
  return (
    <Badge variant={o.reason === 'not-found' ? 'neutral' : 'warning'} className="text-[10px]">
      {label}
    </Badge>
  )
}

export function outcomeColumns(
  names: DeviceNames,
  t: TFunction,
): readonly DataColumn<OrphanOutcomeRow>[] {
  return [
    seriesColumn((r: OrphanOutcomeRow) => r.series, names, t),
    {
      key: 'result',
      header: t('history.orphans.colResult', 'Result'),
      render: (r) => outcomeBadge(r.outcome, t),
      sortValue: (r) => (r.outcome.ok ? 0 : 1),
    },
  ]
}
