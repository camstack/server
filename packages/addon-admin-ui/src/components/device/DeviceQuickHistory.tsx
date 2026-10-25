/**
 * Body of the quick-detail modal's History tab.
 *
 * The tab itself is mounted only after `listSeries` answers with at least
 * one series. While this view is up, a pending read is a skeleton and a
 * failed read is an error — never "no history" (D315). Charts are the
 * device page's `DeviceHistoryView`.
 */
import {
  DeviceHistoryView,
  ErrorBox,
  Skeleton,
  historyPageHref,
  useDeviceSeriesList,
  type HistorySeriesRef,
} from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export interface DeviceQuickHistoryProps {
  readonly deviceId: number
}

function seriesRefs(
  deviceId: number,
  series: readonly { readonly key: string; readonly scope: string }[],
): readonly HistorySeriesRef[] {
  return series.map((item) => ({
    subject: { kind: 'device', deviceId },
    key: item.key,
    scope: item.scope,
  }))
}

export function DeviceQuickHistory({ deviceId }: DeviceQuickHistoryProps): ReactNode {
  const { t } = useTranslation()
  const { presence, list } = useDeviceSeriesList(deviceId)

  if (presence === 'absent') return null
  if (presence === 'unknown') {
    return (
      <ErrorBox
        message={t(
          'deviceQuickDetail.historyUnknown',
          'Could not tell whether this device has recorded history.',
        )}
      />
    )
  }
  if (presence === 'pending' || list.status === 'pending') {
    return <Skeleton className="h-24 w-full" aria-busy="true" />
  }
  if (list.status === 'error') {
    return (
      <ErrorBox
        title={t(
          'deviceQuickDetail.historyUnknown',
          'Could not tell whether this device has recorded history.',
        )}
        message={list.error}
      />
    )
  }
  if (list.data.length === 0) return null

  return (
    <section
      className="flex flex-col gap-2"
      aria-label={t('deviceQuickDetail.tabHistory', 'History')}
    >
      <div className="flex justify-end">
        <Link
          to={historyPageHref(seriesRefs(deviceId, list.data))}
          className="text-xs text-primary hover:underline"
        >
          {t('deviceQuickDetail.openHistory', 'Open full history')}
        </Link>
      </div>
      <DeviceHistoryView deviceId={deviceId} />
    </section>
  )
}
