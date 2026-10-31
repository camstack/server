/**
 * EventsManagementSection — durable event-store footprint + management.
 *
 * Reads `pipelineAnalytics.getEventStoreFootprint()` (rows + media bytes, per
 * camera + total) and exposes:
 *   - a cluster-wide "prune events older than N days" (`pruneEvents`, reason
 *     logged), and
 *   - a per-camera "delete all events" (`deleteDeviceEvents`, op:'manual-delete'),
 *     each behind a danger confirm.
 *
 * Reuses DataTable / WidgetMetricCard / useConfirm / formatBytes.
 */

import type { EventStoreDeviceFootprint } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import {
  DataTable,
  EmptyState,
  useConfirm,
  useDeviceManagerListAll,
  usePipelineAnalyticsDeleteDeviceEvents,
  usePipelineAnalyticsGetEventStoreFootprint,
  usePipelineAnalyticsPruneEvents,
  WidgetMetricCard,
  Button,
  Select,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Database, Loader2, Scissors, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { formatBytes } from '../../lib/format-size'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const PIPELINE_ANALYTICS_QUERY_KEY = [['pipelineAnalytics']] as const

const DAY_MS = 24 * 60 * 60 * 1000

function cameraLabel(deviceId: number, names: ReadonlyMap<number, string>): string {
  return (
    names.get(deviceId) ??
    i18n.t('recordings.eventsManagementSection.removedCamera', { id: String(deviceId) })
  )
}

/** Prune-age options (days). */
const PRUNE_AGES: readonly { days: number }[] = [
  { days: 1 },
  { days: 7 },
  { days: 30 },
  { days: 90 },
]

export function EventsManagementSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [ageDays, setAgeDays] = useState<number>(30)
  const [note, setNote] = useState<string | null>(null)

  const { data: footprint, isLoading } = usePipelineAnalyticsGetEventStoreFootprint(
    {},
    { refetchOnWindowFocus: false },
  )
  // Every footprint / prune row is keyed by camera — cameras only, slim, and
  // the query client's fleet window (D274) so the recordings-page sections share one fetch.
  const { data: devices } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })

  const cameraName = useMemo<ReadonlyMap<number, string>>(() => {
    const byId = new Map<number, string>()
    for (const d of devices ?? []) byId.set(d.id, d.name)
    return byId
  }, [devices])

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: PIPELINE_ANALYTICS_QUERY_KEY })
  }, [queryClient])

  const prune = usePipelineAnalyticsPruneEvents({ onSuccess: invalidate })
  const remove = usePipelineAnalyticsDeleteDeviceEvents()

  const handlePrune = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t('recordings.eventsManagementSection.pruneTitle', { count: ageDays }),
      message: t(
        'recordings.eventsManagementSection.permanentlyDeletesEveryEventMotion',
        'Permanently deletes every event (motion / object / audio) older than the cutoff across all cameras, and their media. This cannot be undone.',
      ),
      confirmLabel: t('recordings.eventsManagementSection.pruneEvents', 'Prune events'),
      variant: 'danger',
    })
    if (!ok) return
    prune.mutate({ olderThanMs: Date.now() - ageDays * DAY_MS, reason: 'retention' }) // i18n-ignore: server-side reason code
  }, [confirm, prune, ageDays, t])

  const handleDelete = useCallback(
    async (row: EventStoreDeviceFootprint): Promise<void> => {
      const label = cameraLabel(row.deviceId, cameraName)
      const ok = await confirm({
        title: t(
          'recordings.eventsManagementSection.deleteAllEventsFor',
          'Delete all events for {{label}}?',
          { label },
        ),
        message: t('recordings.eventsManagementSection.deleteRowsMessage', {
          count: row.rows,
          size: formatBytes(row.bytes),
        }),
        confirmLabel: t('recordings.eventsManagementSection.deleteEvents', 'Delete events'),
        variant: 'danger',
      })
      if (!ok) return
      setNote(null)
      try {
        const counts = await remove.mutateAsync({ deviceId: row.deviceId })
        invalidate()
        const deleted = counts.motion + counts.object + counts.audio
        if (deleted === 0 && row.bytes > 0) {
          setNote(
            `0 events deleted for ${label}. Media still listed (${formatBytes(row.bytes)}) — those blobs are not event rows; use Management → Count leftovers or Disk reconcile.`,
          )
          return
        }
        setNote(`Deleted ${String(deleted)} event${deleted === 1 ? '' : 's'} for ${label}.`)
      } catch (err) {
        setNote(err instanceof Error ? err.message : String(err))
      }
    },
    [confirm, remove, cameraName, invalidate, t],
  )

  const columns = useMemo<readonly DataColumn<EventStoreDeviceFootprint>[]>(
    () => [
      {
        key: 'camera',
        header: t('recordings.eventsManagementSection.camera', 'Camera'),
        render: (r) => (
          <span className="text-foreground">{cameraLabel(r.deviceId, cameraName)}</span>
        ),
      },
      {
        key: 'rows',
        header: t('recordings.eventsManagementSection.events', 'Events'),
        align: 'right',
        nowrap: true,
        render: (r) => <span className="tabular-nums">{r.rows.toLocaleString()}</span>,
      },
      {
        key: 'bytes',
        header: t('recordings.eventsManagementSection.media', 'Media'),
        align: 'right',
        nowrap: true,
        render: (r) => <span className="tabular-nums">{formatBytes(r.bytes)}</span>,
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (r) => (
          <Button
            variant="unstyled"
            onClick={() => {
              void handleDelete(r)
            }}
            disabled={remove.isPending}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            title={t(
              'recordings.eventsManagementSection.deleteAllEventsForThis',
              'Delete all events for this camera',
            )}
          >
            <Trash2 className="h-3 w-3" />
            {t('common.delete', 'Delete')}
          </Button>
        ),
      },
    ],
    [cameraName, handleDelete, remove.isPending, t],
  )

  if (isLoading && !footprint) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t(
          'recordings.eventsManagementSection.loadingEventStoreFootprint',
          'Loading event-store footprint…',
        )}
      </div>
    )
  }

  if (!footprint) {
    return (
      <EmptyState
        icon={Database}
        title={t('recordings.eventsManagementSection.noEventData', 'No event data')}
        description={t(
          'recordings.eventsManagementSection.pipelineAnalyticsHasNotReported',
          'Pipeline analytics has not reported any event-store footprint yet.',
        )}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <WidgetMetricCard
          label={t('recordings.eventsManagementSection.totalEvents', 'Total events')}
          icon={<Database className="h-3 w-3" />}
          footer={`across ${String(footprint.devices.length)} camera${footprint.devices.length === 1 ? '' : 's'}`}
        >
          {footprint.totalRows.toLocaleString()}
        </WidgetMetricCard>
        <WidgetMetricCard
          label={t('recordings.eventsManagementSection.eventMediaOnDisk', 'Event media on disk')}
        >
          {formatBytes(footprint.totalBytes)}
        </WidgetMetricCard>
      </section>

      {/* Cluster-wide prune */}
      <section className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-foreground-subtle">
          {t('recordings.eventsManagementSection.pruneEventsOlderThan', 'Prune events older than')}
        </span>
        <Select
          wrapperClassName="inline-block w-auto"
          value={ageDays}
          onChange={(e) => setAgeDays(Number(e.target.value))}
        >
          {PRUNE_AGES.map((a) => (
            <option key={a.days} value={a.days}>
              {t('recordings.eventsManagementSection.ageDays', { count: a.days })}
            </option>
          ))}
        </Select>
        <Button
          variant="unstyled"
          onClick={() => {
            void handlePrune()
          }}
          disabled={prune.isPending}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium text-foreground-subtle hover:bg-warning/10 hover:text-warning disabled:opacity-50"
        >
          {prune.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Scissors className="h-3 w-3" />
          )}
          {t('recordings.eventsManagementSection.pruneNow', 'Prune now')}
        </Button>
      </section>

      {footprint.devices.length === 0 ? (
        <EmptyState
          icon={Database}
          title={t('recordings.eventsManagementSection.noStoredEvents', 'No stored events')}
          description={t(
            'recordings.eventsManagementSection.noCameraHasPersistedEvents',
            'No camera has persisted events yet.',
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={[...footprint.devices]}
          rowKey={(r) => r.deviceId}
          minWidthPx={480}
        />
      )}
      {note !== null ? (
        <p
          className={
            note.startsWith('Deleted ')
              ? 'text-[11px] text-foreground-subtle'
              : 'text-[11px] text-destructive'
          }
        >
          {note}
        </p>
      ) : null}
    </div>
  )
}
