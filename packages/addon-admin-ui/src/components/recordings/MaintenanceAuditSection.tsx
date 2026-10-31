/**
 * MaintenanceAuditSection — Recordings → Management audit toolbar.
 *
 * One safe pass stacks consecutive reports (orphans, debug media, frozen
 * ledger). Apply lives under a report that found work. Disk-wins reconcile
 * and storage migration are not this panel.
 */

import type { LedgerWalkReport, StorageLocation } from '@camstack/types'
import {
  useAddonsCustom,
  useConfirm,
  usePipelineAnalyticsGetMediaReclaimStatus,
  usePipelineAnalyticsReclaimDebugMedia,
  useRecordingArchiveReconcileLedgerAgainstDisk,
  useStorageListLocations,
  Button,
} from '@camstack/ui-library'
import { ClipboardList, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatBytes } from '../../lib/format-size'
import { footageLocationFrozen } from './footage-location-frozen'
import { HOUSEKEEPING_BTN } from './housekeeping-btn'
import {
  type MaintenanceMediaReport,
  type MaintenanceOrphanReport,
  readMaintenanceAudit,
  writeMaintenanceAudit,
} from './maintenance-audit-session'
import { useTranslation } from 'react-i18next'

const ORPHAN_ADDON = 'pipeline-analytics'
const ORPHAN_ACTION = 'retention.orphanAudit'
const FOOTAGE_TYPES = new Set(['recordings', 'recordingsLow'])
const MEDIA_POLL_MS = 2_000
const MEDIA_POLL_MAX = 180

type OrphanReport = MaintenanceOrphanReport
type MediaReport = MaintenanceMediaReport

function asOrphanReport(raw: unknown): OrphanReport | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['ran'] !== 'boolean') return null
  if (o['mode'] !== 'report' && o['mode'] !== 'reclaim') return null
  if (typeof o['totalOrphans'] !== 'number') return null
  if (typeof o['totalReclaimed'] !== 'number') return null
  if (typeof o['totalBytesReclaimed'] !== 'number') return null
  return {
    ran: o['ran'],
    mode: o['mode'],
    totalOrphans: o['totalOrphans'],
    totalReclaimed: o['totalReclaimed'],
    totalBytesReclaimed: o['totalBytesReclaimed'],
  }
}

function footageLocations(all: readonly StorageLocation[] | undefined): StorageLocation[] {
  return (all ?? []).filter((loc) => FOOTAGE_TYPES.has(loc.type))
}

async function waitForMediaIdle(
  refetch: () => Promise<{ data?: MediaReportSnapshot | undefined }>,
): Promise<MediaReportSnapshot | undefined> {
  for (let i = 0; i < MEDIA_POLL_MAX; i++) {
    const result = await refetch()
    const data = result.data
    if (data !== undefined && data.running !== true) return data
    await new Promise((resolve) => setTimeout(resolve, MEDIA_POLL_MS))
  }
  return undefined
}

interface MediaReportSnapshot {
  readonly running: boolean
  readonly totalEligible: number
  readonly totalExamined: number
  readonly totalReclaimed: number
  readonly totalBytesReclaimed: number
  readonly error: string | null
}

function mediaFromSnapshot(
  snap: MediaReportSnapshot | undefined,
  alreadyRunning: boolean,
): MediaReport {
  return {
    alreadyRunning,
    totalEligible: snap?.totalEligible ?? 0,
    totalExamined: snap?.totalExamined ?? 0,
    totalReclaimed: snap?.totalReclaimed ?? 0,
    totalBytesReclaimed: snap?.totalBytesReclaimed ?? 0,
    error: snap?.error ?? null,
  }
}

export function MaintenanceAuditSection() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const custom = useAddonsCustom()
  const startMedia = usePipelineAnalyticsReclaimDebugMedia()
  const mediaStatus = usePipelineAnalyticsGetMediaReclaimStatus({})
  const walk = useRecordingArchiveReconcileLedgerAgainstDisk()
  const { data: allLocations } = useStorageListLocations({})

  const saved = readMaintenanceAudit()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(saved?.error ?? null)
  const [orphans, setOrphans] = useState<OrphanReport | null>(saved?.orphans ?? null)
  const [debugMedia, setDebugMedia] = useState<MediaReport | null>(saved?.debugMedia ?? null)
  const [ledgers, setLedgers] = useState<LedgerWalkReport[]>([...(saved?.ledgers ?? [])])
  const [ledgerSkipped, setLedgerSkipped] = useState(saved?.ledgerSkipped ?? false)

  useEffect(() => {
    writeMaintenanceAudit({
      orphans,
      debugMedia,
      ledgers,
      ledgerSkipped,
      error,
    })
  }, [orphans, debugMedia, ledgers, ledgerSkipped, error])

  const frozen = footageLocations(allLocations).filter(footageLocationFrozen)

  const runAudit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setOrphans(null)
    setDebugMedia(null)
    setLedgers([])
    setLedgerSkipped(false)
    try {
      const orphanRaw = await custom.mutateAsync({
        addonId: ORPHAN_ADDON,
        action: ORPHAN_ACTION,
        input: { mode: 'report' },
      })
      const orphanParsed = asOrphanReport(orphanRaw)
      if (orphanParsed === null) {
        setError('Unexpected orphan-audit reply')
        return
      }
      setOrphans(orphanParsed)

      const mediaStart = await startMedia.mutateAsync({ mode: 'report' })
      const mediaSnap = await waitForMediaIdle(() => mediaStatus.refetch())
      setDebugMedia(mediaFromSnapshot(mediaSnap, mediaStart.alreadyRunning === true))

      if (frozen.length === 0) {
        setLedgerSkipped(true)
      } else {
        const next: LedgerWalkReport[] = []
        for (const loc of frozen) {
          next.push(await walk.mutateAsync({ locationId: loc.id }))
          setLedgers([...next])
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const reclaimOrphans = async (): Promise<void> => {
    const ok = await confirm({
      title: t(
        'recordings.maintenanceAuditSection.reclaimOrphanedAnalyticsRows',
        'Reclaim orphaned analytics rows?',
      ),
      message: t(
        'recordings.maintenanceAuditSection.deletesIndexRowsAndTheir',
        'Deletes index rows (and their blobs) whose owning track, event or group is already gone. Enrolled gallery media is skipped.',
      ),
      confirmLabel: t('recordings.maintenanceAuditSection.reclaimOrphans', 'Reclaim orphans'),
      variant: 'warning',
    })
    if (!ok) return
    setError(null)
    try {
      const raw = await custom.mutateAsync({
        addonId: ORPHAN_ADDON,
        action: ORPHAN_ACTION,
        input: { mode: 'reclaim' },
      })
      const parsed = asOrphanReport(raw)
      if (parsed === null) {
        setError('Unexpected orphan-audit reply')
        return
      }
      setOrphans(parsed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const reclaimDebug = async (): Promise<void> => {
    const ok = await confirm({
      title: t('recordings.maintenanceAuditSection.reclaimDebugMedia', 'Reclaim debug media?'),
      message: t(
        'recordings.maintenanceAuditSection.deletesMotionVisitStillsAnd',
        'Deletes motion-visit stills and track filmstrips. Key frames and enrolled gallery stay. Paced at 2 MB/s — you can leave this page.',
      ),
      confirmLabel: t(
        'recordings.maintenanceAuditSection.reclaimDebugMedia2',
        'Reclaim debug media',
      ),
      variant: 'warning',
    })
    if (!ok) return
    setError(null)
    try {
      const result = await startMedia.mutateAsync({ mode: 'reclaim' })
      const snap = await waitForMediaIdle(() => mediaStatus.refetch())
      setDebugMedia(mediaFromSnapshot(snap, result.alreadyRunning === true))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const forgetGhosts = async (locationId: string): Promise<void> => {
    const ok = await confirm({
      title: t(
        'recordings.maintenanceAuditSection.forgetGhostRowsOn',
        'Forget ghost rows on {{locationId}}?',
        { locationId },
      ),
      message: t(
        'recordings.maintenanceAuditSection.dropsDurableHourRowsWhose',
        'Drops durable hour rows whose files are not on disk. Files the ledger does not name are reported, never deleted.',
      ),
      confirmLabel: t('recordings.maintenanceAuditSection.forgetGhosts', 'Forget ghosts'),
      variant: 'danger',
    })
    if (!ok) return
    setError(null)
    try {
      const next = await walk.mutateAsync({ locationId, apply: true })
      setLedgers((prev) => prev.map((row) => (row.locationId === locationId ? next : row)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const applying = custom.isPending || startMedia.isPending || walk.isPending
  const locationsReady = allLocations !== undefined

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t('recordings.maintenanceAuditSection.countLeftovers', 'Count leftovers')}
      </h3>
      <p className="mt-1 text-[11px] text-foreground-subtle">
        {t(
          'recordings.maintenanceAuditSection.orphanAnalyticsRowsDebugStills',
          'Orphan analytics rows, debug stills/filmstrips, and ghost hours on a frozen recordings folder. Counts only — Reclaim or Forget deletes after you confirm.',
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="unstyled"
          type="button"
          onClick={() => void runAudit()}
          disabled={busy || applying || !locationsReady}
          className={HOUSEKEEPING_BTN}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ClipboardList className="h-3.5 w-3.5" />
          )}
          {busy
            ? t('recordings.maintenanceAuditSection.auditing', 'Auditing…')
            : t('recordings.maintenanceAuditSection.runAudit', 'Run audit')}
        </Button>
      </div>

      {orphans !== null ? (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-[11px] text-foreground-subtle">
            {orphans.ran === false
              ? t(
                  'recordings.maintenanceAuditSection.orphansAlreadyRunningRequestIgnored',
                  'Orphans: already running — request ignored.',
                )
              : orphans.mode === 'reclaim'
                ? t('recordings.maintenanceAuditSection.orphansReclaimed', {
                    count: orphans.totalOrphans,
                    reclaimed: String(orphans.totalReclaimed),
                  })
                : t('recordings.maintenanceAuditSection.orphansSummary', {
                    count: orphans.totalOrphans,
                  })}
          </p>
          {orphans.ran && orphans.totalOrphans > 0 && orphans.mode === 'report' ? (
            <Button
              variant="unstyled"
              type="button"
              onClick={() => void reclaimOrphans()}
              disabled={busy || applying}
              className={HOUSEKEEPING_BTN}
            >
              {t('recordings.maintenanceAuditSection.reclaimOrphans', 'Reclaim orphans')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {debugMedia !== null ? (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-[11px] text-foreground-subtle">
            {debugMedia.alreadyRunning
              ? t(
                  'recordings.maintenanceAuditSection.debugMediaAlreadyRunningShowing',
                  'Debug media: already running — showing last pass.',
                )
              : debugMedia.totalBytesReclaimed > 0
                ? t('recordings.maintenanceAuditSection.debugEligibleSize', {
                    count: debugMedia.totalEligible,
                    size: formatBytes(debugMedia.totalBytesReclaimed),
                  })
                : t('recordings.maintenanceAuditSection.debugEligible', {
                    count: debugMedia.totalEligible,
                  })}
            {debugMedia.error !== null ? ` — ${debugMedia.error}` : ''}
          </p>
          {debugMedia.totalEligible > 0 ? (
            <Button
              variant="unstyled"
              type="button"
              onClick={() => void reclaimDebug()}
              disabled={busy || applying}
              className={HOUSEKEEPING_BTN}
            >
              {t('recordings.maintenanceAuditSection.reclaimDebugMedia2', 'Reclaim debug media')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {ledgers.map((report) => (
        <div key={report.locationId} className="mt-3 flex flex-col gap-1">
          {report.refused !== null ? (
            <p className="text-[11px] text-destructive">
              {t('recordings.maintenanceAuditSection.walkRefused', {
                location: report.locationId,
                reason: report.refused,
              })}
            </p>
          ) : (
            <>
              <p className="text-[11px] text-foreground-subtle">
                {t('recordings.maintenanceAuditSection.ghosts', {
                  location: report.locationId,
                  count: report.ghostSegments,
                })}
                {report.ghostBytes > 0 ? ` (${formatBytes(report.ghostBytes)})` : ''}
                {report.applied
                  ? t('recordings.maintenanceAuditSection.forgot', ', forgot {{value1}}', {
                      value1: String(report.forgottenSegments),
                    })
                  : ''}
                {report.orphanFiles > 0
                  ? t(
                      'recordings.maintenanceAuditSection.orphanFilesLeftOnDisk',
                      ', {{value1}} orphan files left on disk',
                      { value1: String(report.orphanFiles) },
                    )
                  : ''}
              </p>
              {report.ghostSegments > 0 && !report.applied ? (
                <Button
                  variant="unstyled"
                  type="button"
                  onClick={() => void forgetGhosts(report.locationId)}
                  disabled={busy || applying}
                  className={HOUSEKEEPING_BTN}
                >
                  {t('recordings.maintenanceAuditSection.forgetGhosts', 'Forget ghosts')}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ))}

      {ledgerSkipped ? (
        <p className="mt-3 text-[11px] text-foreground-subtle">
          {t(
            'recordings.maintenanceAuditSection.noFrozenLocationSkipped',
            'No frozen location — skipped.',
          )}
        </p>
      ) : null}

      {error !== null ? <p className="mt-3 text-[11px] text-destructive">{error}</p> : null}
    </section>
  )
}
