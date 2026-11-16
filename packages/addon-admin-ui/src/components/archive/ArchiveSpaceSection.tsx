/**
 * Archive camera page → Space: where this camera writes and how much, and the
 * danger zone — apply retention now, delete this camera's footage, delete its
 * events. Moved here from the overview tables; each action keeps its confirmation.
 */
import type { OpsLogReason } from '@camstack/types'
import {
  Button,
  useConfirm,
  usePipelineAnalyticsDeleteDeviceEvents,
  useRecordingArchiveDeleteFootprint,
  useRecordingArchivePruneFootage,
  useStorageListLocations,
  WidgetMetricCard,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { HardDrive, Scissors, Trash2 } from 'lucide-react'
import { useCallback, useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../../lib/format-size'
import { resolveCameraDisk } from '../recordings/camera-disk'
import type { CameraRow } from './camera-rows'
import type { ArchiveData } from './use-archive-data'

const RETENTION_REASON: OpsLogReason = 'retention'
const DASH = '—'

export function ArchiveSpaceSection({
  data,
  row,
}: {
  readonly data: ArchiveData
  readonly row: CameraRow
}): ReactElement {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const locations = useStorageListLocations({}).data
  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: [['recording']] })
    void queryClient.invalidateQueries({ queryKey: [['recordingArchive']] })
    void queryClient.invalidateQueries({ queryKey: [['pipelineAnalytics']] })
  }, [queryClient])
  const prune = useRecordingArchivePruneFootage({ onSuccess: invalidate })
  const removeFootage = useRecordingArchiveDeleteFootprint({ onSuccess: invalidate })
  const removeEvents = usePipelineAnalyticsDeleteDeviceEvents({ onSuccess: invalidate })

  const disk = useMemo(() => {
    const names = new Map((locations ?? []).map((l) => [l.id, l.displayName]))
    const defaultId = (locations ?? []).find((l) => l.type === 'recordings')?.id ?? null
    return resolveCameraDisk(data.usage?.locations ?? [], names, defaultId)
  }, [locations, data.usage?.locations])

  const confirmDanger = useCallback(
    async (title: string, message: string, confirmLabel: string): Promise<boolean> =>
      confirm({ title, message, confirmLabel, variant: 'danger' }),
    [confirm],
  )

  const onPrune = async (): Promise<void> => {
    const ok = await confirmDanger(
      t('archive.space.pruneTitle', 'Apply retention to {{name}}?', { name: row.name }),
      t(
        'archive.space.pruneMessage',
        'Footage beyond the retention policy is permanently deleted.',
      ),
      t('archive.space.pruneNow', 'Prune now'),
    )
    if (ok) prune.mutate({ deviceId: row.deviceId, reason: RETENTION_REASON })
  }
  const onDeleteFootage = async (): Promise<void> => {
    const ok = await confirmDanger(
      t('archive.space.deleteFootageTitle', 'Delete all footage for {{name}}?', { name: row.name }),
      t(
        'archive.space.deleteFootageMessage',
        'Permanently deletes {{size}} of recorded footage. This cannot be undone.',
        {
          size: row.footageBytes === null ? DASH : formatBytes(row.footageBytes),
        },
      ),
      t('archive.space.deleteFootage', 'Delete footage'),
    )
    if (ok) removeFootage.mutate({ deviceId: row.deviceId })
  }
  const onDeleteEvents = async (): Promise<void> => {
    const ok = await confirmDanger(
      t('archive.space.deleteEventsTitle', 'Delete all events for {{name}}?', { name: row.name }),
      t(
        'archive.space.deleteEventsMessage',
        'Permanently deletes the events and their media. This cannot be undone.',
      ),
      t('archive.space.deleteEvents', 'Delete events'),
    )
    if (ok) removeEvents.mutate({ deviceId: row.deviceId })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="archive-space">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <WidgetMetricCard
          label={t('archive.space.footage', 'Footage')}
          icon={<HardDrive className="h-3.5 w-3.5" />}
          footer={
            disk === null
              ? t('archive.space.diskUnknown', 'Disk not reported')
              : disk.exact
                ? disk.label
                : t('archive.space.diskDefault', '{{label}} (default)', { label: disk.label })
          }
        >
          {row.footageBytes === null ? DASH : formatBytes(row.footageBytes)}
        </WidgetMetricCard>
        <WidgetMetricCard
          label={t('archive.space.events', 'Event storage')}
          footer={
            row.eventRows === null
              ? undefined
              : t('archive.space.eventRows', '{{count}} events', { count: row.eventRows })
          }
        >
          {row.eventBytes === null ? DASH : formatBytes(row.eventBytes)}
        </WidgetMetricCard>
        <WidgetMetricCard label={t('archive.space.oldest', 'Oldest footage')}>
          {row.oldestMs === null ? DASH : new Date(row.oldestMs).toLocaleDateString()}
        </WidgetMetricCard>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-danger/40 p-3">
        <h3 className="text-sm font-semibold text-danger">
          {t('archive.space.danger', 'Danger zone')}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void onPrune()} disabled={prune.isPending}>
            <Scissors className="h-3.5 w-3.5" />
            {t('archive.space.applyRetention', 'Apply retention now')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void onDeleteFootage()}
            disabled={removeFootage.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('archive.space.deleteFootage', 'Delete footage')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void onDeleteEvents()}
            disabled={removeEvents.isPending}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('archive.space.deleteEvents', 'Delete events')}
          </Button>
        </div>
      </div>
    </div>
  )
}
