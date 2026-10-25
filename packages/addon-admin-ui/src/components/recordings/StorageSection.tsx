/**
 * StorageSection — recordings storage facts + management (Recordings page).
 *
 * Reads `recording.getStorageUsage()` (total / per-camera / per-disk free) and
 * exposes two destructive per-camera actions, each behind a danger confirm:
 *   - Prune  — apply the camera's retention policy now (`recording.pruneFootage`,
 *     reason selectable). Frees whatever the policy dictates.
 *   - Delete — remove ALL of the camera's footage (`recording.deleteFootprint`,
 *     op:'manual-delete'). No window UI here — the viewer owns the windowed
 *     delete (follow-up).
 *
 * Reuses DataTable / WidgetMetricCard / useConfirm / formatBytes.
 *
 * ## Volume fill vs the recordings share
 *
 * The per-disk bar plots how full the VOLUME is — `(total - available) / total`
 * from the recorder's `statfs` — not `usedBytes / totalBytes`, which is the
 * share of the disk taken by footage. The two diverge on any shared array: 92.9
 * GB of recordings on a 4 TB volume renders 2% while the disk sits at 99% and
 * the next segment write is the ENOSPC. Severity thresholds live in
 * `storage-fill.ts` (warn ≥ 85%, critical ≥ 95%); the recordings share is still
 * shown, because it is the part Prune and Delete can actually free.
 *
 * `usage.locations` is OPTIONAL and every read here treats it as such — the hub
 * serves this method through a baked router, so a hub on an older framework
 * train strips the array out of an answer a newer recorder produced. Missing
 * disk data degrades to no disk cards, never to a blank page.
 *
 * ## Archive, not residency (D418)
 *
 * `usedBytes` and `oldestMs` on a camera row are the durable hour ledger's
 * numbers — the same quantity the disk cards above them show, so the columns
 * can be compared and totalled. Until D418 they came from the recorder's RAM
 * index instead: a hub holding 1.9 TB and 3.3 days rendered 60.5 GB and an
 * oldest of three hours ago on this very table, and it read as retention
 * eating recent footage. `residentBytes` / `residentOldestMs` are what that
 * number really was; they are not rendered here, and if they ever are they
 * must be labelled residency, never storage.
 *
 * `devicesRead: 'unavailable'` means the recorder REFUSED the table (no hour
 * ledger on that node), which is not the same fact as "no camera has footage"
 * — the empty state below distinguishes them.
 *
 * ## The Disk column, the one fact the cap still does not carry
 *
 * **Which disk this camera's footage is on.** The ledger knows (its hour rows
 * carry `locationId`); the per-device row does not carry it. Until it does,
 * `resolveCameraDisk` answers exactly when there is one physical volume and
 * marks the class default as an approximation when there are several.
 */

import type { OpsLogReason, RecordingDeviceUsage, RecordingLocationUsage } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import {
  DataTable,
  EmptyState,
  useConfirm,
  useDeviceManagerListAll,
  useRecordingArchiveDeleteFootprint,
  useRecordingArchiveGetStorageUsage,
  useRecordingArchivePruneFootage,
  useStorageListLocations,
  WidgetMetricCard,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { HardDrive, Loader2, Scissors, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { formatBytes } from '../../lib/format-size'
import { type DiskAttribution, resolveCameraDisk } from './camera-disk'
import {
  resolveVolumeFill,
  summarizeVolumeFill,
  type VolumeFillSeverity,
  type VolumeFillSummary,
} from './storage-fill'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const RECORDING_QUERY_KEY = [['recording']] as const

/** Prune-reason options the operator can pick before pruning. */
const PRUNE_REASONS: readonly { value: OpsLogReason; labelKey: string }[] = [
  { value: 'retention', labelKey: 'recordings.storageSection.pruneRetention' },
  { value: 'quota', labelKey: 'recordings.storageSection.pruneQuota' },
  { value: 'operator', labelKey: 'recordings.storageSection.pruneOperator' },
]

/** Bar fill per severity — the same three tokens the rest of the admin uses. */
const FILL_BAR_CLASS: Readonly<Record<VolumeFillSeverity, string>> = {
  ok: 'bg-primary',
  warn: 'bg-amber-500',
  critical: 'bg-danger',
}

/** Percentage text per severity: at warn and above the number is the message. */
const FILL_TEXT_CLASS: Readonly<Record<VolumeFillSeverity, string>> = {
  ok: 'text-foreground-subtle',
  warn: 'text-amber-500',
  critical: 'text-danger',
}

function formatPercent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`
}

/**
 * The "Oldest footage" cell.
 *
 * `undefined` is a recorder too old to carry the field and `null` is a camera
 * with no footage — both render as an em dash, because neither is a date, and
 * neither may be shown as one.
 */
function formatOldest(oldestMs: number | null | undefined): string {
  if (oldestMs === null || oldestMs === undefined) return '—'
  return new Date(oldestMs).toLocaleString()
}

/**
 * What to call a disk. The location `displayName`s sharing the volume when
 * `storage.listLocations` has answered, the filesystem root when it has not,
 * and the location id as the last resort — an operator reads disks by name and
 * an unnamed row still has to be identifiable in an alert.
 */
function volumeLabel(
  loc: RecordingLocationUsage,
  displayNameById: ReadonlyMap<string, string>,
): string {
  const ids = loc.locationIds ?? (loc.locationId === null ? [] : [loc.locationId])
  const named = ids.map((id) => displayNameById.get(id)).filter((name) => name !== undefined)
  if (named.length > 0) return named.join(' + ')
  if (loc.root !== undefined) return loc.root
  if (ids.length > 0) return ids.join(' + ')
  return i18n.t('recordings.storageSection.defaultRoot')
}

export function StorageSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const [reason, setReason] = useState<OpsLogReason>('retention')

  const { data: usage, isLoading } = useRecordingArchiveGetStorageUsage(
    {},
    { refetchOnWindowFocus: false },
  )
  // Every usage row is keyed by camera — cameras only, slim, and the query client's fleet window (D274) so the recordings-page sections share one fetch.
  const { data: devices } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  // Location display names + which one is the recordings default. The usage
  // payload speaks in location ids; an operator reads disks by name.
  const { data: allLocations } = useStorageListLocations({})

  const cameraName = useMemo<ReadonlyMap<number, string>>(() => {
    const byId = new Map<number, string>()
    for (const d of devices ?? []) byId.set(d.id, d.name)
    return byId
  }, [devices])

  const locationNames = useMemo<ReadonlyMap<string, string>>(() => {
    const byId = new Map<string, string>()
    for (const loc of allLocations ?? []) byId.set(loc.id, loc.displayName)
    return byId
  }, [allLocations])

  // A write-enabled recordings location — the fallback guess when the cap
  // cannot say which volume a given camera's footage sits on. There is no
  // default to consult (D383); with several enabled this names the first, and
  // it is a GUESS, labelled as one wherever it is rendered.
  const defaultRecordingsLocationId = useMemo<string | null>(() => {
    const all = allLocations ?? []
    const writing = all.find((l) => l.type === 'recordings' && l.enabled !== false)
    return writing?.id ?? all.find((l) => l.type === 'recordings')?.id ?? null
  }, [allLocations])

  // OPTIONAL by contract (see the module doc): an older hub's baked router
  // strips the array, and every read below goes through this one fallback.
  const volumes = useMemo<readonly RecordingLocationUsage[]>(
    () => usage?.locations ?? [],
    [usage?.locations],
  )

  const disk = useMemo<DiskAttribution | null>(
    () => resolveCameraDisk(volumes, locationNames, defaultRecordingsLocationId),
    [volumes, locationNames, defaultRecordingsLocationId],
  )

  const fillSummary = useMemo<VolumeFillSummary | null>(
    () => summarizeVolumeFill(volumes),
    [volumes],
  )

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: RECORDING_QUERY_KEY })
  }, [queryClient])

  const prune = useRecordingArchivePruneFootage({ onSuccess: invalidate })
  const remove = useRecordingArchiveDeleteFootprint({ onSuccess: invalidate })

  const handlePrune = useCallback(
    async (row: RecordingDeviceUsage): Promise<void> => {
      const label = cameraName.get(row.deviceId) ?? `#${String(row.deviceId)}`
      const ok = await confirm({
        title: t('recordings.storageSection.prune', 'Prune {{label}}?', { label }),
        message: t(
          'recordings.storageSection.appliesTheRetentionPolicyNow',
          'Applies the retention policy now (reason: {{reason}}). Footage beyond the policy is permanently deleted.',
          { reason },
        ),
        confirmLabel: t('recordings.storageSection.pruneNow', 'Prune now'),
        variant: 'danger',
      })
      if (!ok) return
      prune.mutate({ deviceId: row.deviceId, reason })
    },
    [confirm, prune, reason, cameraName, t],
  )

  const handleDelete = useCallback(
    async (row: RecordingDeviceUsage): Promise<void> => {
      const label = cameraName.get(row.deviceId) ?? `#${String(row.deviceId)}`
      const ok = await confirm({
        title: t(
          'recordings.storageSection.deleteAllFootageFor',
          'Delete all footage for {{label}}?',
          { label },
        ),
        message: t(
          'recordings.storageSection.permanentlyDeletesOfRecordedFootage',
          'Permanently deletes {{value1}} of recorded footage for this camera. This cannot be undone.',
          { value1: formatBytes(row.usedBytes) },
        ),
        confirmLabel: t('recordings.storageSection.delete', 'Delete {{value1}}', {
          value1: formatBytes(row.usedBytes),
        }),
        variant: 'danger',
      })
      if (!ok) return
      remove.mutate({ deviceId: row.deviceId })
    },
    [confirm, remove, cameraName, t],
  )

  const columns = useMemo<readonly DataColumn<RecordingDeviceUsage>[]>(
    () => [
      {
        key: 'camera',
        header: t('recordings.storageSection.camera', 'Camera'),
        render: (r) => (
          <span className="text-foreground">
            {cameraName.get(r.deviceId) ?? `#${String(r.deviceId)}`}
          </span>
        ),
      },
      {
        key: 'disk',
        header: t('recordings.storageSection.disk', 'Disk'),
        nowrap: true,
        render: () =>
          disk === null ? (
            <span className="text-foreground-subtle">—</span>
          ) : (
            <span
              className={disk.exact ? 'text-foreground' : 'text-foreground-subtle'}
              title={
                disk.exact
                  ? t(
                      'recordings.storageSection.theOnlyRecordingsVolumeOn',
                      'The only recordings volume on this node — this camera can only be here.',
                    )
                  : t(
                      'recordings.storageSection.theRecordingsDefaultThisNode',
                      'The recordings DEFAULT. This node has several recordings volumes and the per-camera placement is not reported by recording.getStorageUsage, so this is where footage lands by default rather than a per-camera fact.',
                    )
              }
            >
              {disk.label}
              {!disk.exact && (
                <span className="ml-1 text-foreground-subtle">
                  {t('recordings.storageSection.default', '(default)')}
                </span>
              )}
            </span>
          ),
      },
      {
        key: 'used',
        header: t('recordings.storageSection.used', 'Used'),
        align: 'right',
        nowrap: true,
        render: (r) => <span className="tabular-nums">{formatBytes(r.usedBytes)}</span>,
      },
      {
        key: 'oldest',
        header: t('recordings.storageSection.oldestFootage', 'Oldest footage'),
        align: 'right',
        nowrap: true,
        render: (r) => (
          <span
            className="tabular-nums text-foreground-subtle"
            title={t(
              'recordings.storageSection.theOldestSegmentTheArchive',
              "The oldest segment the ARCHIVE holds for this camera — the per-camera answer to 'is retention actually holding?'.",
            )}
          >
            {formatOldest(r.oldestMs)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (r) => (
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={() => {
                void handlePrune(r)
              }}
              disabled={prune.isPending}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-foreground-subtle hover:bg-amber-500/10 hover:text-amber-500 disabled:opacity-50"
              title={t(
                'recordings.storageSection.applyRetentionPolicyNow',
                'Apply retention policy now',
              )}
            >
              <Scissors className="h-3 w-3" />
              {t('recordings.storageSection.prune2', 'Prune')}
            </button>
            <button
              onClick={() => {
                void handleDelete(r)
              }}
              disabled={remove.isPending}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              title={t('recordings.storageSection.deleteAllFootage', 'Delete all footage')}
            >
              <Trash2 className="h-3 w-3" />
              {t('common.delete', 'Delete')}
            </button>
          </div>
        ),
      },
    ],
    [cameraName, disk, handlePrune, handleDelete, prune.isPending, remove.isPending, t],
  )

  if (isLoading && !usage) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('recordings.storageSection.loadingStorageUsage', 'Loading storage usage…')}
      </div>
    )
  }

  if (!usage) {
    return (
      <EmptyState
        icon={HardDrive}
        title={t('recordings.storageSection.noStorageData', 'No storage data')}
        description={t(
          'recordings.storageSection.theRecordingNodeHasNot',
          'The recording node has not reported any storage usage yet.',
        )}
      />
    )
  }

  const cameraCount = usage.devices.length

  return (
    <div className="flex flex-col gap-6">
      {/* Totals + per-disk free */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <WidgetMetricCard
          label={t('recordings.storageSection.totalUsed', 'Total used')}
          icon={<HardDrive className="h-3 w-3" />}
          footer={`${String(cameraCount)} camera${cameraCount === 1 ? '' : 's'} on ${usage.nodeId}`}
        >
          {formatBytes(usage.totalUsedBytes)}
        </WidgetMetricCard>
        {fillSummary !== null && fillSummary.severity !== null && (
          <WidgetMetricCard
            label={t(
              'recordings.storageSection.freeOnRecordingsVolumes',
              'Free on recordings volumes',
            )}
            icon={<HardDrive className="h-3 w-3" />}
            footer={
              `across ${String(fillSummary.knownVolumes)} volume${
                fillSummary.knownVolumes === 1 ? '' : 's'
              } of ${formatBytes(fillSummary.totalBytes)}` +
              (fillSummary.unknownVolumes > 0
                ? ` · ${String(fillSummary.unknownVolumes)} did not report capacity`
                : '')
            }
          >
            <span className={`tabular-nums ${FILL_TEXT_CLASS[fillSummary.severity]}`}>
              {formatBytes(fillSummary.freeBytes)}
            </span>
          </WidgetMetricCard>
        )}
        {volumes.map((loc) => {
          const fill = resolveVolumeFill(loc)
          const key = loc.locationId ?? loc.root ?? 'default'
          const label = volumeLabel(loc, locationNames)
          return (
            <WidgetMetricCard
              key={key}
              label={t('recordings.storageSection.disk2', 'Disk: {{label}}', { label })}
              footer={
                fill === null
                  ? `${formatBytes(loc.usedBytes)} of recordings · volume capacity unknown`
                  : `${formatBytes(fill.freeBytes)} free of ${formatBytes(fill.totalBytes)} · ${formatBytes(loc.usedBytes)} recordings (${formatPercent(fill.recordingsFraction)})`
              }
            >
              {fill === null ? (
                <span className="tabular-nums">{formatBytes(loc.usedBytes)}</span>
              ) : (
                <div
                  className="flex items-center gap-2"
                  title={t(
                    'recordings.storageSection.volumeFillEverythingOnThe',
                    'Volume fill — everything on the disk, not only recordings. Warn at 85%, critical at 95%.',
                  )}
                >
                  <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className={`h-full rounded ${FILL_BAR_CLASS[fill.severity]}`}
                      style={{ width: formatPercent(fill.fraction) }}
                    />
                  </div>
                  <span className={`tabular-nums text-xs ${FILL_TEXT_CLASS[fill.severity]}`}>
                    {formatPercent(fill.fraction)}
                  </span>
                </div>
              )}
            </WidgetMetricCard>
          )
        })}
      </section>

      {/* Prune-reason selector (applies to per-camera Prune actions) */}
      <section className="flex items-center gap-2 text-xs">
        <label htmlFor="prune-reason" className="text-foreground-subtle">
          {t('recordings.storageSection.pruneReason', 'Prune reason')}
        </label>
        <select
          id="prune-reason"
          value={reason}
          onChange={(e) => {
            const next = PRUNE_REASONS.find((r) => r.value === e.target.value)
            if (next) setReason(next.value)
          }}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
        >
          {PRUNE_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {t(r.labelKey)}
            </option>
          ))}
        </select>
      </section>

      {/* Per-camera usage + actions */}
      {cameraCount === 0 ? (
        <EmptyState
          icon={HardDrive}
          title={
            usage.devicesRead === 'unavailable'
              ? t(
                  'recordings.storageSection.perCameraUsageUnavailable',
                  'Per-camera usage unavailable',
                )
              : t('recordings.storageSection.noRecordedFootage', 'No recorded footage')
          }
          description={
            usage.devicesRead === 'unavailable'
              ? t(
                  'recordings.storageSection.thisRecordingNodeHasNo',
                  'This recording node has no footage ledger, so it refused to answer the per-camera table rather than report what it happens to hold in memory. The disk totals above are unaffected.',
                )
              : t(
                  'recordings.storageSection.noCameraHasRecordedFootage',
                  'No camera has recorded footage on this node yet.',
                )
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={[...usage.devices]}
          rowKey={(r) => r.deviceId}
          minWidthPx={480}
        />
      )}
    </div>
  )
}
