/**
 * The History page's flag for series no longer linked to a device (D917).
 *
 * Drawn only from an ANSWER (D315): while `listOrphanSeries` is pending the
 * page shows nothing here, a failed read says it could not check (never "none
 * found"), and an answer with no series draws nothing. An answer with series
 * draws the notice and its Review dialog.
 */
import { useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  ErrorBox,
  useDeviceHistoryDeleteOrphanSeries,
  useDeviceHistoryListOrphanSeries,
  useDeviceManagerListAll,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { OrphanSeriesDialog } from './OrphanSeriesDialog'
import type { OrphanDeleteCall } from './orphan-series-model'

const ORPHAN_STALE_MS = 5 * 60_000

export function OrphanSeriesNotice({ enabled }: { readonly enabled: boolean }): ReactNode {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const listQ = useDeviceHistoryListOrphanSeries({}, { enabled, staleTime: ORPHAN_STALE_MS })
  const devicesQ = useDeviceManagerListAll({ projection: 'slim' }, { enabled })
  const del = useDeviceHistoryDeleteOrphanSeries()
  const deviceNames = useMemo(
    () => new Map((devicesQ.data ?? []).map((d) => [d.id, d.name] as const)),
    [devicesQ.data],
  )
  const onDelete: OrphanDeleteCall = (ids) => del.mutateAsync({ seriesIds: [...ids] })

  if (!enabled || listQ.status === 'pending') return null
  if (listQ.status === 'error') {
    return (
      <ErrorBox
        variant="warning"
        title={t('history.orphans.checkFailedTitle', 'Could not check for unlinked series')}
        message={listQ.error.message}
        onRetry={() => void listQ.refetch()}
      />
    )
  }
  const list = listQ.data
  if (list.series.length === 0 && !open) return null
  const count = list.series.length
  return (
    <>
      {count > 0 && (
        <ErrorBox
          variant="warning"
          message={
            list.truncated
              ? t('history.orphans.noticeMore', {
                  count,
                  defaultValue_one: 'More than {{count}} series are no longer linked to a device.',
                  defaultValue_other:
                    'More than {{count}} series are no longer linked to a device.',
                })
              : t('history.orphans.notice', {
                  count,
                  defaultValue_one: '{{count}} series is no longer linked to a device.',
                  defaultValue_other: '{{count}} series are no longer linked to a device.',
                })
          }
          action={
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              {t('history.orphans.review', 'Review')}
            </Button>
          }
        />
      )}
      <OrphanSeriesDialog
        open={open}
        onClose={() => setOpen(false)}
        list={list}
        deviceNames={deviceNames}
        onDelete={onDelete}
        onRefresh={() => void listQ.refetch()}
        refreshing={listQ.isFetching}
      />
    </>
  )
}
