/**
 * RestoreWizard — 3-step modal wizard (Phase 4 / Task 25).
 *
 * Steps:
 *   1) Pick destination + archive (pre-filled when opened from a
 *      drill-in row's "Restore" button).
 *   2) Pick which top-level location categories to restore. The
 *      checklist is sourced from the embedded archive manifest's
 *      `.locations` field (`db`, `addons`, `addons-data`, `tls`,
 *      `cache`, …) — every category present is checked by default.
 *   3) Confirm + run via `useBackupRestore`. An ENCRYPTED archive asks for
 *      the backup key here (the secret shown once when encryption was set
 *      up); the hub refuses a missing or wrong key before downloading. A
 *      plain archive needs none. The orchestrator emits
 *      `BackupRestored` and writes a restore marker; the operator
 *      restarts the server to apply.
 *
 * Progress: the orchestrator does NOT emit a `restore.progress`
 * event today — `BackupRestored` fires once the marker is written,
 * but the actual extraction happens at next-boot. We therefore show
 * a "Scheduled — restart to apply" success state instead of a fake
 * progress bar.
 */

import type { DataStoreDatabase } from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  useBackupGetEntries,
  useBackupListArchives,
  useBackupListDestinations,
  useBackupRestore,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Loader2, Lock, RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { formatBytes } from '../../lib/format-size'
import { BackupDatabaseBadges } from './BackupDatabaseBadges'
import { databasesOfArchive, isSnapshotsOnly } from './backup-databases'

const QUERY_KEY_LIST = [['backup', 'list']] as const

interface DestinationRow {
  readonly id: string
  readonly displayName: string
  readonly kind: string
  readonly restoreSupported: boolean
}

interface ArchiveRow {
  readonly id: string
  readonly createdAt: number
  readonly sizeBytes: number
  readonly label?: string
  readonly locations: readonly string[]
  readonly databases?: readonly DataStoreDatabase[]
  readonly encryption?: { readonly scheme: string; readonly keyId: string }
}

export interface RestoreWizardProps {
  readonly initialDestinationId?: string
  readonly initialArchiveId?: string
  readonly onClose: () => void
  /** Notifies the parent so it can render the "Restart now" banner. */
  readonly onScheduled: () => void
}

type Step = 1 | 2 | 3

export function RestoreWizard({
  initialDestinationId,
  initialArchiveId,
  onClose,
  onScheduled,
}: RestoreWizardProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>(initialDestinationId && initialArchiveId ? 2 : 1)

  const [destinationId, setDestinationId] = useState<string | undefined>(initialDestinationId)
  const [archiveId, setArchiveId] = useState<string | undefined>(initialArchiveId)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [backupKey, setBackupKey] = useState('')

  const { data: destinations } = useBackupListDestinations()
  const dests = (destinations ?? []) as readonly DestinationRow[]

  const { data: archivesData, isLoading: archivesLoading } = useBackupListArchives(
    { destinationId: destinationId ?? '' },
    { enabled: !!destinationId },
  )
  const archives = (archivesData ?? []) as readonly ArchiveRow[]

  // Auto-pick a default destination if there's only one with restore
  // support — saves a click in the common single-destination case.
  useEffect(() => {
    if (destinationId !== undefined) return
    const restoreable = dests.filter((d) => d.restoreSupported)
    if (restoreable.length === 1) setDestinationId(restoreable[0]!.id)
  }, [destinationId, dests])

  const { data: manifest } = useBackupGetEntries(
    {
      destinationId: destinationId ?? '',
      backupId: archiveId ?? '',
    },
    { enabled: !!destinationId && !!archiveId },
  )

  const manifestLocations = useMemo(() => manifest?.locations ?? [], [manifest])
  // Default-pick every location once the manifest arrives. We use an
  // effect (not a useMemo) so the user's deselects survive a re-render.
  useEffect(() => {
    if (manifestLocations.length === 0) return
    setPicked((prev) => (prev.size === 0 ? new Set(manifestLocations) : prev))
  }, [manifestLocations])

  const restore = useBackupRestore({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_LIST })
      onScheduled()
      onClose()
    },
  })

  const togglePicked = (loc: string): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(loc)) next.delete(loc)
      else next.add(loc)
      return next
    })
  }

  const selectedArchive = archives.find((a) => a.id === archiveId)
  const needsKey = selectedArchive?.encryption !== undefined
  // What this archive carries; a weekly (events + history) is snapshots-only.
  const archiveDatabases = databasesOfArchive(selectedArchive?.databases, manifest?.sqliteSnapshots)
  const snapshotsOnly = isSnapshotsOnly(archiveDatabases)
  const canStep1Next = !!destinationId && !!archiveId
  const canStep2Next = snapshotsOnly || picked.size > 0
  const canSubmit =
    canStep1Next && canStep2Next && !restore.isPending && (!needsKey || backupKey.trim().length > 0)

  const submit = (): void => {
    if (!destinationId || !archiveId) return
    restore.mutate({
      destinationId,
      backupId: archiveId,
      // A snapshots-only archive has no file locations: restore it whole (its databases only).
      ...(snapshotsOnly ? {} : { locations: [...picked] }),
      ...(needsKey ? { backupSecretKey: backupKey.trim() } : {}),
    })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="md" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('backup.restoreWizard.restoreBackup', 'Restore Backup')}</DialogTitle>
          <p className="text-xs text-foreground-subtle">
            {t('backup.restoreWizard.stepOf', {
              step,
              name:
                step === 1
                  ? t('backup.restoreWizard.pickSource', 'pick source')
                  : step === 2
                    ? t('backup.restoreWizard.pickLocations', 'pick locations')
                    : t('backup.restoreWizard.confirmStep'),
            })}
          </p>
        </DialogHeader>
        <DialogBody>
          {step === 1 && (
            <Step1
              destinations={dests}
              destinationId={destinationId}
              onPickDestination={(id) => {
                setDestinationId(id)
                setArchiveId(undefined)
                setPicked(new Set())
              }}
              archives={archives}
              archivesLoading={archivesLoading}
              archiveId={archiveId}
              onPickArchive={setArchiveId}
            />
          )}
          {step === 2 && (
            <Step2
              locations={manifestLocations}
              picked={picked}
              onToggle={togglePicked}
              databases={archiveDatabases}
              snapshotsOnly={snapshotsOnly}
            />
          )}
          {step === 3 && (
            <Step3
              destinationName={
                dests.find((d) => d.id === destinationId)?.displayName ?? destinationId ?? ''
              }
              archive={selectedArchive}
              picked={[...picked]}
              databases={archiveDatabases}
              snapshotsOnly={snapshotsOnly}
            />
          )}
          {step === 3 && selectedArchive?.encryption !== undefined && (
            <BackupKeyField
              keyId={selectedArchive.encryption.keyId}
              value={backupKey}
              onChange={setBackupKey}
            />
          )}
          {step === 3 && restore.error && (
            <p role="alert" className="px-4 pb-2 text-xs text-danger">
              {restore.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="justify-between">
          <div>
            {step > 1 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>
                <ArrowLeft className="h-3 w-3" />
                {t('common.back', 'Back')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </Button>
            {step < 3 ? (
              <Button
                size="sm"
                disabled={(step === 1 && !canStep1Next) || (step === 2 && !canStep2Next)}
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
              >
                {t('common.next', 'Next')}
                <ArrowRight className="h-3 w-3" />
              </Button>
            ) : (
              <Button size="sm" onClick={submit} disabled={!canSubmit}>
                {restore.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" />
                )}
                {t('backup.restoreWizard.scheduleRestore', 'Schedule Restore')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface Step1Props {
  readonly destinations: readonly DestinationRow[]
  readonly destinationId?: string
  readonly onPickDestination: (id: string) => void
  readonly archives: readonly ArchiveRow[]
  readonly archivesLoading: boolean
  readonly archiveId?: string
  readonly onPickArchive: (id: string) => void
}

function Step1({
  destinations,
  destinationId,
  onPickDestination,
  archives,
  archivesLoading,
  archiveId,
  onPickArchive,
}: Step1Props) {
  const { t } = useTranslation()
  const restoreable = destinations.filter((d) => d.restoreSupported)
  return (
    <div className="p-4 space-y-3">
      <div className="space-y-1.5">
        <label className="text-[10px] text-foreground-subtle uppercase tracking-wide">
          {t('backup.restoreWizard.destination', 'Destination')}
        </label>
        <Select
          value={destinationId ?? ''}
          onChange={(e) => onPickDestination(e.target.value)}
          options={[
            {
              value: '',
              label: t('backup.restoreWizard.selectDestination', 'Select destination…'),
            },
            ...restoreable.map((d) => ({ value: d.id, label: `${d.displayName} (${d.kind})` })),
          ]}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] text-foreground-subtle uppercase tracking-wide">
          {t('backup.restoreWizard.archive', 'Archive')}
        </label>
        {!destinationId && (
          <div className="text-xs text-foreground-subtle italic">
            {t('backup.restoreWizard.pickADestinationFirst', 'Pick a destination first.')}
          </div>
        )}
        {destinationId && archivesLoading && (
          <div className="text-xs text-foreground-subtle animate-pulse">
            {t('backup.restoreWizard.readingArchives', 'Reading archives…')}
          </div>
        )}
        {destinationId && !archivesLoading && archives.length === 0 && (
          <div className="text-xs text-foreground-subtle italic">
            {t(
              'backup.restoreWizard.noArchivesAvailableAtThis',
              'No archives available at this destination.',
            )}
          </div>
        )}
        {destinationId && archives.length > 0 && (
          <div className="rounded border border-border bg-background divide-y divide-border max-h-64 overflow-y-auto">
            {archives.map((a) => {
              const checked = archiveId === a.id
              return (
                <label
                  key={a.id}
                  className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer ${checked ? 'bg-primary/10' : 'hover:bg-primary/5'}`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="archive"
                      checked={checked}
                      onChange={() => onPickArchive(a.id)}
                      className="accent-primary"
                    />
                    <div>
                      <div className="flex items-center gap-1 font-medium text-foreground">
                        {a.encryption !== undefined && (
                          <Lock
                            className="h-3 w-3 text-success"
                            aria-label={t(
                              'backup.restoreWizard.encryptedKey',
                              'encrypted (key {{keyId}})',
                              { keyId: a.encryption.keyId },
                            )}
                          />
                        )}
                        {a.label ?? a.id}
                      </div>
                      <div className="text-[10px] text-foreground-subtle">
                        {new Date(a.createdAt).toLocaleString()}
                      </div>
                      <div className="pt-1">
                        <BackupDatabaseBadges
                          databases={databasesOfArchive(a.databases, undefined)}
                        />
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] text-foreground-subtle tabular-nums">
                    {formatBytes(a.sizeBytes)}
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

interface Step2Props {
  readonly locations: readonly string[]
  readonly picked: ReadonlySet<string>
  readonly onToggle: (loc: string) => void
  readonly databases: readonly DataStoreDatabase[]
  readonly snapshotsOnly: boolean
}

function Step2({ locations, picked, onToggle, databases, snapshotsOnly }: Step2Props) {
  const { t } = useTranslation()
  if (snapshotsOnly) {
    return (
      <div className="space-y-3 p-4">
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
            {t('backup.restoreWizard.databasesInThisArchive', 'Databases in this archive')}
          </div>
          <BackupDatabaseBadges databases={databases} />
        </div>
        <div className="rounded border border-info/30 bg-info/10 px-3 py-2 text-[11px] text-info">
          {t(
            'backup.restoreWizard.snapshotsOnlyRestoringThisArchive',
            'Snapshots only: restoring this archive replaces just these databases. It does NOT touch configuration, addons, addon data or certificates.',
          )}
        </div>
      </div>
    )
  }
  if (locations.length === 0) {
    return (
      <div className="p-4">
        <div className="text-xs text-foreground-subtle">
          {t(
            'backup.restoreWizard.loadingArchiveManifestIfThis',
            'Loading archive manifest… If this persists, the archive may predate manifests — restoring will apply everything in the tarball.',
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="p-4 space-y-3">
      <div className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('backup.restoreWizard.databasesInThisArchive', 'Databases in this archive')}
        </div>
        <BackupDatabaseBadges databases={databases} />
      </div>
      <div className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
        {t(
          'backup.restoreWizard.selectedEntriesWillOverwriteLive',
          'Selected entries will overwrite live data on the next server restart. Unchecked entries stay current.',
        )}
      </div>
      <div className="space-y-1.5">
        <label className="text-[10px] text-foreground-subtle uppercase tracking-wide">
          {t('common.apply', 'Apply')}
        </label>
        <div className="rounded border border-border bg-background divide-y divide-border max-h-64 overflow-y-auto">
          {locations.map((loc) => (
            <label
              key={loc}
              className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-primary/5 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={picked.has(loc)}
                onChange={() => onToggle(loc)}
                className="accent-primary"
              />
              <span className="font-mono text-foreground">{loc}</span>
              <span className="ml-auto text-[10px] text-foreground-subtle">
                {describeLocation(loc)}
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

interface Step3Props {
  readonly destinationName: string
  readonly archive?: {
    readonly label?: string
    readonly id: string
    readonly createdAt: number
    readonly sizeBytes: number
  }
  readonly picked: readonly string[]
  readonly databases: readonly DataStoreDatabase[]
  readonly snapshotsOnly: boolean
}

function Step3({ destinationName, archive, picked, databases, snapshotsOnly }: Step3Props) {
  const { t } = useTranslation()
  return (
    <div className="p-4 space-y-3 text-xs">
      <div className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
        {t(
          'backup.restoreWizard.restoreIsAppliedAtNext',
          'Restore is applied at next server boot. Active connections will drop when you restart.',
        )}
      </div>
      <dl className="space-y-1.5">
        <Detail term="Destination" value={destinationName} />
        <Detail term="Archive" value={archive?.label ?? archive?.id ?? '—'} />
        {archive && (
          <Detail
            term="Created"
            value={`${new Date(archive.createdAt).toLocaleString()} · ${formatBytes(archive.sizeBytes)}`}
          />
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-foreground-subtle">
            {t('backup.restoreWizard.databases', 'Databases')}
          </dt>
          <dd className="text-right">
            <BackupDatabaseBadges databases={databases} />
          </dd>
        </div>
        <Detail
          term="Locations"
          value={
            snapshotsOnly
              ? 'none (configuration is not touched)'
              : picked.length > 0
                ? picked.join(', ')
                : '— (full archive)'
          }
        />
      </dl>
    </div>
  )
}

/** The backup secret key for an encrypted archive — sent once, never stored. */
function BackupKeyField({
  keyId,
  value,
  onChange,
}: {
  readonly keyId: string
  readonly value: string
  readonly onChange: (v: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5 px-4 pb-3">
      <label
        htmlFor="restore-backup-key"
        className="text-[10px] uppercase tracking-wide text-foreground-subtle"
      >
        {t('backup.restoreWizard.backupKey', 'Backup key')}
      </label>
      <input
        id="restore-backup-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(
          'backup.restoreWizard.camstackBackupSecretV1',
          'camstack-backup-secret-v1:…',
        )}
        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <p className="text-[11px] text-foreground-subtle">
        <Trans
          i18nKey="backup.restoreWizard.encryptedTo"
          values={{ keyId }}
          components={{ mono: <span className="font-mono" /> }}
        />
      </p>
    </div>
  )
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-foreground-subtle">{term}</dt>
      <dd className="text-foreground font-mono text-right truncate">{value}</dd>
    </div>
  )
}

const LOCATION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  db: 'Database',
  addons: 'Addon configs',
  'addons-data': 'Addon data',
  tls: 'TLS certificates',
  cache: 'Cache',
  data: 'Top-level data',
}

function describeLocation(loc: string): string {
  return LOCATION_DESCRIPTIONS[loc] ?? ''
}
