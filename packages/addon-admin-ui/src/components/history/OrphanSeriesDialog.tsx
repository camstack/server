/**
 * Review and delete history series no longer linked to a device (D917).
 *
 * The list is what `deviceHistory.listOrphanSeries` answered; the admin
 * selects rows and deletes them, in batches the hub accepts, behind a danger
 * confirm. The hub re-judges every id, so each row gets its own outcome —
 * shown in a second table that outlives the refreshed list (a deleted or
 * no-longer-orphan series is absent from it by definition).
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { DeviceHistoryOrphanList } from '@camstack/types'
import {
  Button,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  TABLE_SCROLL_MAX_H,
  useConfirm,
} from '@camstack/ui-library'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  deviceLabel,
  orphanColumns,
  outcomeColumns,
  seriesLabel,
  type DeviceNames,
} from './orphan-series-columns'
import {
  deleteOrphansInBatches,
  pairOutcomes,
  summarizeOutcomes,
  type OrphanDeleteCall,
  type OrphanOutcomeRow,
} from './orphan-series-model'

export interface OrphanSeriesDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly list: DeviceHistoryOrphanList
  readonly deviceNames: DeviceNames
  readonly onDelete: OrphanDeleteCall
  /** Ask the hub again (after a deletion, or to load the rest of a truncated list). */
  readonly onRefresh: () => void
  readonly refreshing: boolean
}

export function OrphanSeriesDialog({
  open,
  onClose,
  list,
  deviceNames,
  onDelete,
  onRefresh,
  refreshing,
}: OrphanSeriesDialogProps): ReactNode {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<readonly OrphanOutcomeRow[]>([])

  const columns = useMemo(() => orphanColumns(deviceNames, t), [deviceNames, t])
  const resultColumns = useMemo(() => outcomeColumns(deviceNames, t), [deviceNames, t])
  const listed = useMemo(() => new Set(list.series.map((s) => String(s.seriesId))), [list.series])
  const targets = [...selected].filter((k) => listed.has(k)).map(Number)
  const summary = summarizeOutcomes(outcomes.map((o) => o.outcome))

  const runDelete = async (): Promise<void> => {
    const ok = await confirm({
      title: t('history.orphans.confirmTitle', {
        count: targets.length,
        defaultValue_one: 'Delete {{count}} series',
        defaultValue_other: 'Delete {{count}} series',
      }),
      message: t(
        'history.orphans.confirmMessage',
        'Every recorded point of these series is removed from the hub. This cannot be undone.',
      ),
      confirmLabel: t('history.orphans.confirmLabel', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await deleteOrphansInBatches(targets, onDelete)
      setOutcomes(pairOutcomes(list.series, result))
      setSelected(new Set())
    } finally {
      setBusy(false)
      onRefresh()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        width="xl"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="orphan-series-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t('history.orphans.title', 'Series no longer linked to a device')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs text-foreground-muted">
            {t(
              'history.orphans.intro',
              'Nothing records into these series any more: their device was removed, or no capability declares them now. Select the ones to delete.',
            )}
          </p>
          {list.truncated && (
            <div className="flex flex-wrap items-center gap-2" data-testid="orphan-truncated">
              <p className="text-xs text-warning">
                {t(
                  'history.orphans.truncated',
                  'More series are unlinked than are listed here. Delete these, then load the rest.',
                )}
              </p>
              <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw className="h-3 w-3" aria-hidden />
                {t('history.orphans.loadAgain', 'Load again')}
              </Button>
            </div>
          )}
          {outcomes.length > 0 && (
            <div className="space-y-2" data-testid="orphan-outcomes">
              <p className="text-xs text-foreground" aria-live="polite">
                {t('history.orphans.summary', {
                  count: summary.deleted,
                  refused: summary.refused,
                  points: summary.points.toLocaleString(),
                  defaultValue_one:
                    '{{count}} series deleted ({{points}} points), {{refused}} kept.',
                  defaultValue_other:
                    '{{count}} series deleted ({{points}} points), {{refused}} kept.',
                })}
              </p>
              <DataTable
                columns={resultColumns}
                rows={outcomes}
                rowKey={(r) => String(r.series.seriesId)}
                minWidthPx={420}
                maxBodyHeight={TABLE_SCROLL_MAX_H}
                emptyMessage=""
              />
            </div>
          )}
          <DataTable
            columns={columns}
            rows={list.series}
            rowKey={(s) => String(s.seriesId)}
            minWidthPx={760}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
            defaultSort={{ columnKey: 'series', dir: 'asc' }}
            emptyMessage={t('history.orphans.empty', 'Every series is linked to a device.')}
            selection={{
              selected,
              onChange: setSelected,
              rowLabel: (s) => `${seriesLabel(s)} — ${deviceLabel(s, deviceNames, t)}`,
              pageLabel: t('history.orphans.selectAll', 'Select every listed series'),
            }}
          />
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto text-[11px] tabular-nums text-foreground" aria-live="polite">
            {t('history.orphans.selected', {
              count: targets.length,
              defaultValue_one: '{{count}} selected',
              defaultValue_other: '{{count}} selected',
            })}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('history.orphans.close', 'Close')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={targets.length === 0 || busy}
            onClick={() => void runDelete()}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3 w-3" aria-hidden />
            )}
            {t('history.orphans.deleteSelected', 'Delete selected')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
