/**
 * ArchiveList — per-destination drill-in (Phase 4 / Task 24).
 *
 * Rendered inline below an expanded `BackupEntriesTable` row. Reads
 * the destination's archives via `backup.listArchives` (which loads
 * the per-location `manifests.json` server-side and returns the
 * sorted entries), and exposes per-archive actions:
 *
 *   - Download — points at the Fastify `/api/backup/download/...`
 *     endpoint registered in `server/backend/src/main.ts`. The route
 *     pipes the chunked-download cap into a streaming response so
 *     the operator gets an `application/gzip` save-as dialog without
 *     buffering the archive in admin-ui memory.
 *   - Delete — `useBackupDelete` mutation; invalidates both the
 *     archive list AND the destinations table (so `lastSuccess`
 *     re-hydrates if you just deleted the newest archive).
 *   - Restore — invokes the parent's `onOpenRestoreWizard` callback
 *     with `(locationId, archiveId)`; the wizard (Task 25) owns the
 *     locations checklist + confirmation flow.
 */
import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Loader2, Lock, RotateCw, Trash2 } from 'lucide-react'
import {
  Button,
  DataTable,
  IconButton,
  useBackupDelete,
  useBackupListArchives,
  useConfirm,
  type DataColumn,
} from '@camstack/ui-library'
import type { DataStoreDatabase } from '@camstack/types'
import { BackupDatabaseBadges } from './BackupDatabaseBadges'
import { selectionOfRow } from './backup-databases'
import { formatBytes } from '../../lib/format-size'
import { authedFetchBlob } from '../../lib/authed-media.js'
import { hubPath } from '../../lib/mount'
import { useTranslation } from 'react-i18next'

const QUERY_KEY_DESTS = [['backup', 'listDestinations']] as const
const QUERY_KEY_ARCHIVES_PREFIX = ['backup', 'listArchives'] as const

interface ArchiveRow {
  readonly id: string
  readonly filename: string
  readonly createdAt: number
  readonly sizeBytes: number
  readonly label?: string
  readonly locations: readonly string[]
  /** What the run asked to carry; absent on a legacy archive = `['settings']`. */
  readonly databases?: readonly DataStoreDatabase[]
  readonly encryption?: { readonly scheme: string; readonly keyId: string }
}

export interface ArchiveListProps {
  readonly destinationId: string
  readonly restoreSupported: boolean
  /**
   * Notifies the parent so it can open a restore wizard with the
   * archive pre-selected. Optional — when omitted, the Restore
   * button is hidden (e.g. caller doesn't host a wizard yet).
   */
  readonly onOpenRestoreWizard?: (input: { destinationId: string; archiveId: string }) => void
}

export function ArchiveList({
  destinationId,
  restoreSupported,
  onOpenRestoreWizard,
}: ArchiveListProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()

  const { data, isLoading, isError } = useBackupListArchives({ destinationId })
  const archives = (data ?? []) as readonly ArchiveRow[]

  const remove = useBackupDelete({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [[...QUERY_KEY_ARCHIVES_PREFIX]] })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_DESTS })
    },
  })

  const handleDelete = useCallback(
    async (a: ArchiveRow): Promise<void> => {
      const ok = await confirm({
        title: t('backup.archiveList.deleteThisArchive', 'Delete this archive?'),
        message: t(
          'backup.archiveList.permanentlyDeletesAndFrees',
          'Permanently deletes "{{value1}}" and frees {{value2}}.',
          { value1: a.label ?? a.id, value2: formatBytes(a.sizeBytes) },
        ),
        confirmLabel: t('common.delete', 'Delete'),
        variant: 'danger',
      })
      if (!ok) return
      remove.mutate({ destinationId, backupId: a.id })
    },
    [confirm, destinationId, remove, t],
  )

  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const handleDownload = useCallback(
    async (a: ArchiveRow): Promise<void> => {
      // The server-side streaming endpoint (registered in `main.ts`)
      // requires a Bearer token in the `Authorization` header — the
      // admin UI keeps the JWT in localStorage. We can't drop a cookie
      // because the API uses no cookie auth, so we fetch the bytes via
      // the authenticated `fetch` path (shared `authedFetchBlob`) and
      // synthesize a blob URL the browser opens as a save-as dialog.
      setDownloadingId(a.id)
      try {
        const blob = await authedFetchBlob(buildDownloadUrl(destinationId, a.id))
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        // An encrypted archive downloads as the ciphertext it is
        // (`scripts/ops/backup-decrypt.mjs` opens it with the backup key).
        anchor.download = `${a.label ?? a.id}.tar.gz${a.encryption !== undefined ? '.csbk' : ''}`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(objectUrl)
      } finally {
        setDownloadingId(null)
      }
    },
    [destinationId],
  )

  const sorted = useMemo(() => {
    return [...archives].toSorted((a, b) => b.createdAt - a.createdAt)
  }, [archives])

  if (isLoading) {
    return (
      <div className="text-xs text-foreground-subtle animate-pulse py-2">
        {t('backup.archiveList.loadingArchives', 'Loading archives…')}
      </div>
    )
  }
  if (isError) {
    return (
      <div className="text-xs text-danger py-2">
        {t(
          'backup.archiveList.failedToReadManifestFor',
          'Failed to read manifest for this destination',
        )}
      </div>
    )
  }
  if (sorted.length === 0) {
    return (
      <div className="text-xs text-foreground-subtle italic py-2">
        {t(
          'backup.archiveList.noArchivesAtThisDestination',
          'No archives at this destination yet.',
        )}
      </div>
    )
  }

  const columns: readonly DataColumn<ArchiveRow>[] = [
    {
      key: 'when',
      header: t('backup.archiveList.when', 'When'),
      sortValue: (a) => a.createdAt,
      render: (a) => <span className="tabular-nums">{formatTimestamp(a.createdAt)}</span>,
    },
    {
      key: 'label',
      header: t('backup.archiveList.label', 'Label'),
      sortValue: (a) => a.label ?? null,
      render: (a) => (
        <span className="inline-flex items-center gap-1">
          {a.encryption !== undefined && (
            <Lock
              className="h-3 w-3 text-success"
              aria-label={t(
                'backup.archiveList.encryptedRestoreNeedsBackupKey',
                'encrypted — restore needs backup key {{keyId}}',
                { keyId: a.encryption.keyId },
              )}
            />
          )}
          {a.label ?? <span className="text-foreground-subtle italic">—</span>}
        </span>
      ),
    },
    {
      key: 'databases',
      header: t('backup.archiveList.databases', 'Databases'),
      nowrap: false,
      notSortableReason: 'Database badges',
      render: (a) => <BackupDatabaseBadges databases={selectionOfRow(a.databases)} />,
    },
    {
      key: 'includes',
      header: t('backup.archiveList.files', 'Files'),
      nowrap: false,
      notSortableReason: 'Location list',
      render: (a) =>
        a.locations.length > 0 ? (
          <span className="text-foreground-subtle">{a.locations.join(', ')}</span>
        ) : (
          <span className="text-foreground-subtle italic">{t('common.none')}</span>
        ),
    },
    {
      key: 'size',
      header: t('backup.archiveList.size', 'Size'),
      align: 'right',
      sortValue: (a) => a.sizeBytes,
      render: (a) => <span className="tabular-nums">{formatBytes(a.sizeBytes)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      notSortableReason: 'Actions',
      render: (a) => (
        <span className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void handleDownload(a)
            }}
            disabled={downloadingId === a.id}
            title={t('backup.archiveList.downloadArchive', 'Download archive')}
          >
            {downloadingId === a.id ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {t('backup.archiveList.download', 'Download')}
          </Button>
          {restoreSupported && onOpenRestoreWizard && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenRestoreWizard({ destinationId, archiveId: a.id })}
              title={t('backup.archiveList.restoreFromThisArchive', 'Restore from this archive')}
            >
              <RotateCw className="h-3 w-3" />
              {t('backup.archiveList.restore', 'Restore')}
            </Button>
          )}
          <IconButton
            variant="ghost"
            size="sm"
            icon={Trash2}
            aria-label={t('backup.archiveList.delete', 'Delete {{value1}}', {
              value1: a.label ?? a.id,
            })}
            disabled={remove.isPending}
            onClick={() => {
              void handleDelete(a)
            }}
          />
        </span>
      ),
    },
  ]

  return (
    <DataTable<ArchiveRow>
      columns={columns}
      rows={sorted}
      rowKey={(a) => a.id}
      minWidthPx={760}
      emptyMessage={t(
        'backup.archiveList.noArchivesAtThisDestination',
        'No archives at this destination yet.',
      )}
    />
  )
}

function buildDownloadUrl(destinationId: string, archiveId: string): string {
  // Server-side route: `GET /api/backup/download/:locationId/:archiveId`
  // — the endpoint resolves the archive's manifest entry to find the
  // filename, then streams the chunked-download bytes.
  //
  // We `encodeURIComponent` the locationId because it carries a colon
  // (`backups:default`) which Fastify handles fine but URL builders
  // sometimes mangle.
  return hubPath(
    `/api/backup/download/${encodeURIComponent(destinationId)}/${encodeURIComponent(archiveId)}`,
  )
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
