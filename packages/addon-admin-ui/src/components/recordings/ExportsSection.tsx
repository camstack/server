/**
 * ExportsSection — recording-export history + management (T7).
 *
 * Lists every rendered / in-flight recording export (from the
 * `recordingExport` cap) with live progress, and exposes per-row
 * Download / Cancel / Delete actions. The CREATE flow lives in the
 * viewer (camera-screen range selector, T8) — admin only lists and
 * manages.
 *
 * Live progress: the seed list (`listExports`) is merged with the three
 * telemetry event streams the render engine emits, keyed by export id —
 * mirrors `AddonsJobProgress`'s seed-plus-events pattern so a page
 * reload mid-render still shows the freshest state.
 */

import type { ExportRecord } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import {
  DataTable,
  EmptyState,
  useConfirm,
  useDeviceManagerListAll,
  useEventStreamMap,
  useRecordingExportCancelExport,
  useRecordingExportDeleteExport,
  useRecordingExportListExports,
  useSystem,
  Button,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Film, Loader2, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { authedFetchBlob } from '../../lib/authed-media.js'
import { formatBytes } from '../../lib/format-size'
import {
  describeVariant,
  type ExportCompletedEvent,
  type ExportFailedEvent,
  type ExportProgressEvent,
  formatExpiry,
  formatRange,
  mergeLiveExports,
} from './export-format'
import { NewExportModal } from './NewExportModal'
import { useTranslation } from 'react-i18next'

const RECORDING_EXPORT_QUERY_KEY = [['recordingExport']] as const

type ExportState = ExportRecord['state']

const STATE_STYLES: Record<
  ExportState,
  { readonly cls: string; readonly labelKey: string; readonly spin?: boolean }
> = {
  queued: { cls: 'bg-muted text-foreground-subtle', labelKey: 'recordings.exportsSection.queued' },
  rendering: {
    cls: 'bg-primary/10 text-primary',
    labelKey: 'recordings.exportsSection.rendering',
    spin: true,
  },
  ready: { cls: 'bg-success/10 text-success', labelKey: 'recordings.exportsSection.ready' },
  failed: { cls: 'bg-danger/10 text-danger', labelKey: 'recordings.exportsSection.failed' },
  expired: {
    cls: 'bg-muted text-foreground-subtle',
    labelKey: 'recordings.exportsSection.expired',
  },
  deleted: {
    cls: 'bg-muted text-foreground-subtle',
    labelKey: 'recordings.exportsSection.deleted',
  },
}

/** Seed list merged with live progress / completion / failure events. */
function useLiveExports(): { readonly rows: readonly ExportRecord[]; readonly isLoading: boolean } {
  const { data, isLoading } = useRecordingExportListExports(
    {},
    {
      refetchOnWindowFocus: false,
      // Poll ONLY while something is in-flight — events are telemetry
      // (lossy), so the poll is the reconcile path; idle pages stop.
      refetchInterval: (query) =>
        (query.state.data ?? []).some((r) => r.state === 'queued' || r.state === 'rendering')
          ? 3_000
          : false,
    },
  )
  const { map: progress } = useEventStreamMap<ExportProgressEvent, string>(
    EventCategory.RecordingExportProgress,
    (p) => p.exportId,
  )
  const { map: completed } = useEventStreamMap<ExportCompletedEvent, string>(
    EventCategory.RecordingExportCompleted,
    (p) => p.exportId,
  )
  const { map: failed } = useEventStreamMap<ExportFailedEvent, string>(
    EventCategory.RecordingExportFailed,
    (p) => p.exportId,
  )

  const rows = useMemo<readonly ExportRecord[]>(
    () => mergeLiveExports(data ?? [], progress, completed, failed),
    [data, progress, completed, failed],
  )

  return { rows, isLoading }
}

/** Now-tick that advances every `intervalMs` so relative countdowns stay live. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function ExportsSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const refetchExports = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['recordingExport', 'listExports']] })
  }
  const confirm = useConfirm()
  const trpcClient = useSystem().trpcClient
  const now = useNow(60_000)

  const { rows, isLoading } = useLiveExports()
  // Every export row is keyed by camera — cameras only, slim, and the query client's fleet window (D274) so the recordings-page sections share one fetch.
  const { data: devices } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })

  const cameraName = useMemo<ReadonlyMap<number, string>>(() => {
    const byId = new Map<number, string>()
    for (const d of devices ?? []) byId.set(d.id, d.name)
    return byId
  }, [devices])

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: RECORDING_EXPORT_QUERY_KEY })
  }, [queryClient])

  const cancel = useRecordingExportCancelExport({ onSuccess: invalidate })
  const remove = useRecordingExportDeleteExport({ onSuccess: invalidate })

  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const handleDownload = useCallback(
    async (rec: ExportRecord): Promise<void> => {
      // The export data-plane route is Bearer-gated — an `<a download>`
      // can't carry the header, so fetch the bytes via the authed path
      // (shared `authedFetchBlob`) and synthesise a blob URL.
      setDownloadingId(rec.id)
      try {
        const { url } = await trpcClient.recordingExport.getDownloadUrl.query({
          exportId: rec.id,
        })
        const blob = await authedFetchBlob(url)
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = `${rec.options.title ?? rec.id}.mp4`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(objectUrl)
        // Serving the final byte may flip the row to `deleted`
        // (delete-after-download) — reconcile the list.
        invalidate()
      } finally {
        setDownloadingId(null)
      }
    },
    [trpcClient, invalidate],
  )

  const handleCancel = useCallback(
    async (rec: ExportRecord): Promise<void> => {
      const ok = await confirm({
        title: t('recordings.exportsSection.cancelThisExport', 'Cancel this export?'),
        message: t(
          'recordings.exportsSection.stopsTheRenderThePartial',
          'Stops the render. The partial file is discarded.',
        ),
        confirmLabel: t('recordings.exportsSection.cancelExport', 'Cancel export'),
        variant: 'danger',
      })
      if (!ok) return
      cancel.mutate({ exportId: rec.id })
    },
    [confirm, cancel, t],
  )

  const handleDelete = useCallback(
    async (rec: ExportRecord): Promise<void> => {
      const ok = await confirm({
        title: t('recordings.exportsSection.deleteThisExport', 'Delete this export?'),
        message: t(
          'recordings.exportsSection.permanentlyRemovesTheRenderedFile',
          'Permanently removes the rendered file and its history row.',
        ),
        confirmLabel: t('common.delete', 'Delete'),
        variant: 'danger',
      })
      if (!ok) return
      remove.mutate({ exportId: rec.id })
    },
    [confirm, remove, t],
  )

  const columns = useMemo<readonly DataColumn<ExportRecord>[]>(
    () => [
      {
        key: 'camera',
        header: t('recordings.exportsSection.camera', 'Camera'),
        render: (r) => (
          <span className="text-foreground">
            {cameraName.get(r.deviceId) ?? `#${String(r.deviceId)}`}
          </span>
        ),
      },
      {
        key: 'range',
        header: t('recordings.exportsSection.range', 'Range'),
        nowrap: true,
        render: (r) => <span className="tabular-nums">{formatRange(r.fromMs, r.toMs)}</span>,
      },
      {
        key: 'variant',
        header: t('recordings.exportsSection.variant', 'Variant'),
        render: (r) => <span className="text-foreground-subtle">{describeVariant(r.options)}</span>,
      },
      {
        key: 'state',
        header: t('recordings.exportsSection.state', 'State'),
        render: (r) => {
          const style = STATE_STYLES[r.state]
          return (
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${style.cls}`}
            >
              {style.spin && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
              {t(style.labelKey)}
              {r.state === 'rendering' && r.progressPct !== null && (
                <span className="tabular-nums">{r.progressPct}%</span>
              )}
            </span>
          )
        },
      },
      {
        key: 'expiry',
        header: t('recordings.exportsSection.expires', 'Expires'),
        nowrap: true,
        render: (r) =>
          r.state === 'deleted' ? (
            <span className="text-foreground-subtle">—</span>
          ) : (
            <span className="text-foreground-subtle tabular-nums">
              {formatExpiry(r.expiresAt, now)}
            </span>
          ),
      },
      {
        key: 'size',
        header: t('recordings.exportsSection.size', 'Size'),
        align: 'right',
        nowrap: true,
        render: (r) => (
          <span className="tabular-nums">
            {r.fileBytes !== null ? formatBytes(r.fileBytes) : '—'}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (r) => {
          const canDownload = r.state === 'ready'
          const canCancel = r.state === 'queued' || r.state === 'rendering'
          const canDelete = r.state !== 'deleted'
          return (
            <div className="flex items-center justify-end gap-1">
              {canDownload && (
                <Button
                  variant="unstyled"
                  onClick={() => {
                    void handleDownload(r)
                  }}
                  disabled={downloadingId === r.id}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-foreground-subtle hover:bg-primary/10 hover:text-foreground disabled:opacity-50"
                  title={t('recordings.exportsSection.downloadMp4', 'Download MP4')}
                >
                  {downloadingId === r.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  {t('recordings.exportsSection.download', 'Download')}
                </Button>
              )}
              {canCancel && (
                <Button
                  variant="unstyled"
                  onClick={() => {
                    void handleCancel(r)
                  }}
                  disabled={cancel.isPending}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-foreground-subtle hover:bg-amber-500/10 hover:text-amber-500 disabled:opacity-50"
                  title={t('recordings.exportsSection.cancelRender', 'Cancel render')}
                >
                  <XCircle className="h-3 w-3" />
                  {t('common.cancel', 'Cancel')}
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="unstyled"
                  onClick={() => {
                    void handleDelete(r)
                  }}
                  disabled={remove.isPending}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                  title={t('recordings.exportsSection.deleteExport', 'Delete export')}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          )
        },
      },
    ],
    [
      cameraName,
      now,
      downloadingId,
      cancel.isPending,
      remove.isPending,
      handleDownload,
      handleCancel,
      handleDelete,
      t,
    ],
  )

  if (isLoading && rows.length === 0) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('recordings.exportsSection.loadingExports', 'Loading exports…')}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="unstyled"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
        >
          <Film className="h-3.5 w-3.5" />
          {t('recordings.exportsSection.newExport', 'New export')}
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={Film}
          title={t('recordings.exportsSection.noExportsYet', 'No exports yet')}
          description={t(
            'recordings.exportsSection.createOneHereNewExport',
            "Create one here (New export) or from a camera's timeline in the viewer. Rendered clips show up here to download or manage.",
          )}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} minWidthPx={720} />
      )}
      {creating && <NewExportModal onClose={() => setCreating(false)} onCreated={refetchExports} />}
    </div>
  )
}
