/**
 * Archive overview → THE camera table. One row per camera, merging footage,
 * event storage and the camera's status; a row opens that camera's Archive page.
 * Replaces the two per-camera tables the old Recordings tabs kept.
 *
 * Off is shown as off, never as broken (D62); a stage that could not be read is
 * "unknown"; a measurement that failed is a dash, never 0 (D393).
 */
import {
  Badge,
  type DataColumn,
  DataTable,
  EmptyState,
  TABLE_SCROLL_MAX_H,
} from '@camstack/ui-library'
import { Camera } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { archiveCameraPath } from './archive-redirects'
import { formatBytes } from '../../lib/format-size'
import type { CameraRow, CameraRowState } from './camera-rows'

const STATE_VARIANT: Readonly<Record<CameraRowState, 'success' | 'default' | 'warning'>> = {
  recording: 'success',
  off: 'default',
  degraded: 'warning',
  unknown: 'default',
}

const DASH = '—'

export function ArchiveCameraTable({
  rows,
  isLoading,
}: {
  readonly rows: readonly CameraRow[]
  readonly isLoading: boolean
}): ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const columns = useMemo<readonly DataColumn<CameraRow>[]>(
    () => [
      {
        mobile: 'primary',
        key: 'camera',
        header: t('archive.table.camera', 'Camera'),
        sortValue: (r) => r.name,
        render: (r) => <span className="font-medium text-foreground">{r.name}</span>,
      },
      {
        mobile: 'detail',
        key: 'mode',
        header: t('archive.table.mode', 'Recording'),
        sortValue: (r) => r.mode ?? '',
        render: (r) => (
          <span className="text-foreground-subtle">
            {r.mode === null ? DASH : t(`archive.mode.${r.mode}`, r.mode)}
          </span>
        ),
      },
      {
        mobile: 'detail',
        key: 'status',
        header: t('archive.table.status', 'Status'),
        sortValue: (r) => r.state,
        render: (r) => (
          <span className="inline-flex items-center gap-1.5">
            <Badge variant={STATE_VARIANT[r.state]}>{t(`archive.state.${r.state}`, r.state)}</Badge>
            {r.warnings > 0 && (
              <Badge variant="warning">
                {t('archive.table.warnings', '{{count}} warning', { count: r.warnings })}
              </Badge>
            )}
          </span>
        ),
      },
      {
        mobile: 'keep',
        key: 'footage',
        header: t('archive.table.footage', 'Footage'),
        align: 'right',
        nowrap: true,
        sortValue: (r) => r.footageBytes,
        render: (r) => (
          <span className="tabular-nums">
            {r.footageBytes === null ? DASH : formatBytes(r.footageBytes)}
          </span>
        ),
      },
      {
        mobile: 'hidden',
        key: 'events',
        header: t('archive.table.events', 'Events'),
        align: 'right',
        nowrap: true,
        sortValue: (r) => r.eventRows,
        render: (r) => (
          <span className="tabular-nums">
            {r.eventRows === null || r.eventBytes === null
              ? DASH
              : `${r.eventRows.toLocaleString()} · ${formatBytes(r.eventBytes)}`}
          </span>
        ),
      },
      {
        mobile: 'hidden',
        key: 'oldest',
        header: t('archive.table.oldest', 'Oldest footage'),
        align: 'right',
        nowrap: true,
        sortValue: (r) => r.oldestMs,
        render: (r) => (
          <span className="tabular-nums text-foreground-subtle">
            {r.oldestMs === null ? DASH : new Date(r.oldestMs).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [t],
  )

  if (!isLoading && rows.length === 0) {
    return (
      <EmptyState
        icon={Camera}
        title={t('archive.table.noCameras', 'No cameras')}
        description={t('archive.table.addACamera', 'Add a camera first.')}
      />
    )
  }
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.deviceId}
      onRowClick={(r) => navigate(archiveCameraPath(r.deviceId))}
      minWidthPx={720}
      maxBodyHeight={TABLE_SCROLL_MAX_H}
      defaultSort={{ columnKey: 'camera', dir: 'asc' }}
    />
  )
}
