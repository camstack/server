/**
 * Archive overview → key numbers. Footage and event-storage footprint, the growth rate and the days of
 * history left at that rate, and the camera states. A number that could not be
 * read renders as an em dash with its reason in the footer, never as 0 (D393).
 */
import { WidgetMetricCard } from '@dominevo/ui-library'
import { Camera, Database, HardDrive, TrendingUp, TriangleAlert } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../../lib/format-size'
import { summarizeVolumeFill } from '../recordings/storage-fill'
import { daysUntilFull, growthPerDay, oldestFootage } from './archive-numbers'
import type { ArchiveData } from './use-archive-data'

const DASH = '—'

export function ArchiveKeyNumbers({ data }: { readonly data: ArchiveData }): ReactElement {
  const { t } = useTranslation()
  const { usage, footprint, rows, totals } = data
  const footageRead = usage !== null && usage.devicesRead !== 'unavailable'

  const growth = useMemo(
    () =>
      growthPerDay({
        footageBytes: footageRead ? usage.totalUsedBytes : null,
        oldestMs: oldestFootage(rows),
        nowMs: Date.now(),
      }),
    [footageRead, usage, rows],
  )
  const freeBytes = useMemo(() => {
    const fill = summarizeVolumeFill(usage?.locations ?? [])
    return fill === null || fill.knownVolumes === 0 ? null : fill.freeBytes
  }, [usage?.locations])
  const days = daysUntilFull(freeBytes, growth)

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="archive-key-numbers">
      <WidgetMetricCard
        label={t('archive.keyNumbers.footage', 'Footage')}
        icon={<HardDrive className="h-3.5 w-3.5" />}
        footer={
          footageRead
            ? undefined
            : t('archive.keyNumbers.footageUnread', 'The recorder did not answer')
        }
      >
        {footageRead ? formatBytes(usage.totalUsedBytes) : DASH}
      </WidgetMetricCard>
      <WidgetMetricCard
        label={t('archive.keyNumbers.eventStorage', 'Event storage')}
        icon={<Database className="h-3.5 w-3.5" />}
        footer={
          footprint === null
            ? t('archive.keyNumbers.eventsUnread', 'The event store did not answer')
            : t('archive.keyNumbers.eventRows', '{{count}} events', { count: footprint.totalRows })
        }
      >
        {footprint === null ? DASH : formatBytes(footprint.totalBytes)}
      </WidgetMetricCard>
      <WidgetMetricCard
        label={t('archive.keyNumbers.growth', 'Growth per day')}
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        footer={
          growth === null
            ? t('archive.keyNumbers.growthUnknown', 'Needs a day of footage')
            : days === null
              ? t('archive.keyNumbers.daysUnknown', 'Free space unknown')
              : t('archive.keyNumbers.daysLeft', '{{days}} days of space left', {
                  days: Math.floor(days),
                })
        }
      >
        {growth === null ? DASH : formatBytes(growth)}
      </WidgetMetricCard>
      <WidgetMetricCard
        label={t('archive.keyNumbers.cameras', 'Cameras')}
        icon={<Camera className="h-3.5 w-3.5" />}
        footer={t('archive.keyNumbers.cameraStates', '{{degraded}} degraded · {{off}} off', {
          degraded: totals.degraded,
          off: totals.off,
        })}
      >
        {t('archive.keyNumbers.recordingOf', '{{recording}} of {{total}} recording', {
          recording: totals.recording,
          total: rows.length,
        })}
      </WidgetMetricCard>
      <WidgetMetricCard
        label={t('archive.keyNumbers.warnings', 'Open warnings')}
        icon={<TriangleAlert className="h-3.5 w-3.5" />}
        footer={
          data.findings === null
            ? t('archive.keyNumbers.digestPending', 'No health digest yet')
            : undefined
        }
      >
        {data.findings === null ? DASH : String(totals.warnings)}
      </WidgetMetricCard>
    </div>
  )
}
