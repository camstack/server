/**
 * StorageMigrationSection — Recordings → Management → Move storage.
 *
 * One coordinated, verified move of recordings / low-res recordings / event
 * media to new storage locations: pauses the owning writers, copies via the
 * coordinator's internal per-addon movers, verifies the copy, then moves the
 * WRITE SET (the destination is enabled, the source disabled — D383). This is
 * now the *only* supported way to move a storage
 * location's data in the Admin UI — the legacy ad-hoc per-location
 * "Relocate" action on the Storage tab (`RelocateModal`) has been removed;
 * this coordinated flow replaces it.
 *
 * Backed by the `storage-migration` capability
 * (`packages/types/src/capabilities/storage-migration.cap.ts`), wired into
 * `@camstack/ui-library`'s generated hooks as `useStorageMigrationPlan` /
 * `useStorageMigrationStart` / `useStorageMigrationStatus` /
 * `useStorageMigrationCancel`. Only these four operator-facing methods are
 * called here — the per-participant primitives
 * (`recording.startStorageMigrationMove`, `pipelineAnalytics.*ForStorageMigration`,
 * etc.) are internal to the coordinator and must never be invoked directly
 * from the UI.
 *
 * There is deliberately no per-camera/device scope here: a migration moves a
 * whole storage class's write set atomically at the end of the job, so it
 * always covers every camera. Scoping to a subset of devices would be unsafe —
 * it would silently leave some cameras still writing to a location the class
 * had stopped writing to.
 *
 * The capability is a `system`-scope singleton builtin (always registered),
 * but this section still gates on a real, working-today runtime signal rather
 * than assuming every deployed hub version has it. That signal is
 * `useCapabilityPresence` (`../../../lib/capability-presence`), which asks the
 * hub's capability registry about THIS ONE capability and answers with a state
 * that can say "not yet known".
 *
 * It used to gate on `useNodesTopology()`, and that was wrong twice over:
 *
 *   - **It lied while loading.** `(topology ?? []).some(…)` turns "no answer
 *     yet" into "no node has it", so the panel told the operator the component
 *     was NOT INSTALLED for the whole of the wait. Reported from the field on
 *     2026-08-31 as ten seconds of "nessun recorder manager installato" on a
 *     hub where it was installed and running.
 *   - **It cost the whole cluster.** `nodes.topology` fans out per node
 *     (`$agent.status` + `$process.list`, a `ps` sample of every child pid, a
 *     durable history write per online node) to draw a diagram nothing here
 *     renders: 32.4–51.1 s measured on the production hub, against 0.15 s for
 *     the registry read that answers the actual question.
 */

import type {
  StorageLocation,
  StorageMigrationClass,
  StorageMigrationDestinations,
  StorageMigrationMove,
  StorageMigrationPlan,
  StorageMigrationResidue,
  StorageMigrationSources,
} from '@camstack/types'
import {
  EmptyState,
  useConfirm,
  useStorageListLocations,
  useStorageMigrationCancel,
  useStorageMigrationDrain,
  useStorageMigrationHistory,
  useStorageMigrationMovers,
  useStorageMigrationPlan,
  useStorageMigrationResidue,
  useStorageMigrationStart,
  useStorageMigrationStatus,
} from '@camstack/ui-library'
import { AlertTriangle, ArrowRightLeft, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useCapabilityPresence } from '../../../lib/capability-presence'
import { formatBytes } from '../../../lib/format-size'
import { describeProgress, progressSummary } from './mover-progress'
import { useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

const STORAGE_MIGRATION_CAPABILITY_ID = 'storage-migration'

const STORAGE_CLASSES: readonly {
  readonly id: StorageMigrationClass
  readonly labelKey: string
  readonly locationType: string
}[] = [
  {
    id: 'recordings',
    labelKey: 'recordings.storageMigrationSection.classRecordings',
    locationType: 'recordings',
  },
  {
    id: 'recordingsLow',
    labelKey: 'recordings.storageMigrationSection.classRecordingsLow',
    locationType: 'recordingsLow',
  },
  {
    id: 'eventMedia',
    labelKey: 'recordings.storageMigrationSection.classEventMedia',
    locationType: 'eventMedia',
  },
]

/**
 * Phases the coordinator reports while a migration is actively running.
 *
 * `sealing` and `draining` belong here as much as any of the others, and
 * leaving them out is not cosmetic: `draining` is the LONG half — hours — and
 * without it the panel showed no spinner and, worse, no Cancel button for the
 * whole of it, and re-enabled the destination selects underneath a live job.
 */
const ACTIVE_PHASES = new Set([
  'planning',
  'sealing',
  'pausing',
  'moving',
  'draining',
  'verifying',
  'repointing',
  'refreshing',
  'resuming',
])

/**
 * The gate. Four answers, four renders — and the absent copy is reachable from
 * exactly one of them: the registry having ANSWERED that nothing provides the
 * capability. `pending` and `unknown` each get their own words, because
 * "loading" and "the registry did not answer" are both true statements and
 * "not installed" is not.
 */
export function StorageMigrationSection() {
  const { t } = useTranslation()
  const presence = useCapabilityPresence(STORAGE_MIGRATION_CAPABILITY_ID)

  if (presence === 'pending') {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-foreground-subtle">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t(
          'migration.storageMigrationSection.checkingWhetherStorageMigrationIs',
          'Checking whether storage migration is installed…',
        )}
      </div>
    )
  }

  if (presence === 'unknown') {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t(
          'migration.storageMigrationSection.couldnTCheckWhetherStorage',
          "Couldn't check whether storage migration is installed",
        )}
        description={t(
          'migration.storageMigrationSection.theCapabilityRegistryDidNot',
          'The capability registry did not answer, so this panel has nothing to report either way — it is not a statement that the capability is missing. Reload to ask again.',
        )}
      />
    )
  }

  if (presence === 'absent') {
    return (
      <EmptyState
        icon={ArrowRightLeft}
        title={t(
          'migration.storageMigrationSection.storageMigrationNotInstalled',
          'Storage migration not installed',
        )}
        description={t(
          'migration.storageMigrationSection.theCapabilityRegistryAnsweredNo',
          'The capability registry answered: no addon in this cluster provides storage-migration. Once one is deployed, this panel moves recordings, low-res recordings and event media to new storage locations in one coordinated, verified operation.',
        )}
      />
    )
  }

  return <StorageMigrationPanel />
}

function StorageMigrationPanel() {
  const { t } = useTranslation()
  const confirm = useConfirm()

  const { data: locations } = useStorageListLocations({})

  const [destinationByClass, setDestinationByClass] = useState<
    Partial<Record<StorageMigrationClass, string>>
  >({})
  const [sourceByClass, setSourceByClass] = useState<
    Partial<Record<StorageMigrationClass, string>>
  >({})
  const [plan, setPlan] = useState<StorageMigrationPlan | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const locationsByType = useMemo<ReadonlyMap<string, readonly StorageLocation[]>>(() => {
    const map = new Map<string, StorageLocation[]>()
    for (const loc of locations ?? []) {
      const arr = map.get(loc.type)
      if (arr) arr.push(loc)
      else map.set(loc.type, [loc])
    }
    return map
  }, [locations])

  /**
   * The class's SOLE write target, per type — the source a cutover assumes when
   * the operator names none. There is no default any more (D383): with several
   * enabled locations of a type the server refuses an unnamed source, so this
   * map deliberately holds nothing for that type and the operator must pick.
   */
  const soleWriteTargetByType = useMemo<ReadonlyMap<string, string>>(() => {
    const enabledByType = new Map<string, string[]>()
    for (const loc of locations ?? []) {
      if (loc.enabled === false) continue
      const ids = enabledByType.get(loc.type)
      if (ids) ids.push(loc.id)
      else enabledByType.set(loc.type, [loc.id])
    }
    const map = new Map<string, string>()
    for (const [type, ids] of enabledByType) if (ids.length === 1) map.set(type, ids[0]!)
    return map
  }, [locations])

  const jobQuery = useStorageMigrationStatus({}, { refetchInterval: 2_000 })
  const job = jobQuery.data ?? null
  const running = job !== null && ACTIVE_PHASES.has(job.phase)

  const destinations = useMemo<StorageMigrationDestinations | undefined>(() => {
    const dest: Partial<Record<StorageMigrationClass, string>> = {}
    for (const cls of STORAGE_CLASSES) {
      const value = destinationByClass[cls.id]
      if (value) dest[cls.id] = value
    }
    return Object.keys(dest).length > 0 ? (dest as StorageMigrationDestinations) : undefined
  }, [destinationByClass])

  const sources = useMemo<StorageMigrationSources>(() => {
    const src: NonNullable<StorageMigrationSources> = {}
    for (const cls of STORAGE_CLASSES) {
      if (!destinationByClass[cls.id]) continue
      const from = sourceByClass[cls.id] ?? soleWriteTargetByType.get(cls.locationType)
      if (from) src[cls.id] = from
    }
    return Object.keys(src).length > 0 ? src : undefined
  }, [destinationByClass, sourceByClass, soleWriteTargetByType])

  const planInput = useMemo(
    () => ({ destinations: destinations ?? {}, ...(sources ? { sources } : {}) }),
    [destinations, sources],
  )

  // Query-shaped: fired on-demand from the Plan button via `refetch()` below,
  // never eagerly on mount (the `enabled: false` here just registers the
  // query with the *current* destinations so refetch() re-runs it with
  // whatever the operator has selected at click time).
  const planQuery = useStorageMigrationPlan(planInput, { enabled: false, retry: false })
  const startMigration = useStorageMigrationStart()
  const cancelMigration = useStorageMigrationCancel()

  const handlePlan = async (): Promise<void> => {
    if (!destinations) return
    setActionError(null)
    const result = await planQuery.refetch()
    if (result.error) {
      setActionError(result.error instanceof Error ? result.error.message : String(result.error))
      return
    }
    setPlan(result.data ?? null)
  }

  const handleStart = async (): Promise<void> => {
    if (!destinations) return
    const ok = await confirm({
      title: t(
        'migration.storageMigrationSection.startStorageMigration',
        'Start storage migration?',
      ),
      message: t(
        'migration.storageMigrationSection.copiesTheSelectedClassesFrom',
        'Copies the selected classes from the chosen source to the destination, verifies, then either makes the destination the default (if the source was) or disables the source. Safe to re-run if interrupted.',
      ),
      confirmLabel: t('migration.storageMigrationSection.startMigration', 'Start migration'),
      variant: 'danger',
    })
    if (!ok) return
    setActionError(null)
    try {
      await startMigration.mutateAsync(planInput)
      setPlan(null)
      await jobQuery.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (!job) return
    const ok = await confirm({
      title: t('migration.storageMigrationSection.cancelMigration', 'Cancel migration?'),
      message: t(
        'migration.storageMigrationSection.stopsTheInProgressMigration',
        'Stops the in-progress migration. Data already moved and verified stays at the destination; anything already repointed is not reverted.',
      ),
      confirmLabel: t('migration.storageMigrationSection.cancelMigration2', 'Cancel migration'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await cancelMigration.mutateAsync({ jobId: job.jobId })
      await jobQuery.refetch()
    } catch {
      /* poll shows the truth */
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-md border border-border bg-surface p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <ArrowRightLeft className="h-3.5 w-3.5" />
          {t('migration.storageMigrationSection.storageMigration', 'Storage migration')}
        </h3>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'migration.storageMigrationSection.moveRecordingsLowResRecordings',
            'Move recordings, low-res recordings and/or event media from one location to another: copies via the recorder / pipeline-analytics movers, verifies, then either repoints the default (when the source was the default) or disables the source (when it was not). Skip a class with an empty destination.',
          )}
        </p>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {STORAGE_CLASSES.map((cls) => {
            const options = locationsByType.get(cls.locationType) ?? []
            const soleWriteTargetId = soleWriteTargetByType.get(cls.locationType) ?? ''
            return (
              <div key={cls.id} className="space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                  {t(cls.labelKey)}
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor={`migration-from-${cls.id}`}
                    className="text-[10px] text-foreground-subtle"
                  >
                    {t('recordings.storageMigrationSection.classFrom', { label: t(cls.labelKey) })}
                  </label>
                  <select
                    id={`migration-from-${cls.id}`}
                    value={sourceByClass[cls.id] ?? soleWriteTargetId}
                    onChange={(e) => {
                      const value = e.target.value
                      setSourceByClass((prev) => ({ ...prev, [cls.id]: value }))
                    }}
                    disabled={running}
                    className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
                  >
                    {options.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.displayName}
                        {loc.enabled === false
                          ? ` (${t('recordings.storageMigrationSection.readOnly')})`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor={`migration-dest-${cls.id}`}
                    className="text-[10px] text-foreground-subtle"
                  >
                    {t('recordings.storageMigrationSection.classTo', { label: t(cls.labelKey) })}
                  </label>
                  <select
                    id={`migration-dest-${cls.id}`}
                    value={destinationByClass[cls.id] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value
                      setDestinationByClass((prev) => ({ ...prev, [cls.id]: value }))
                    }}
                    disabled={running}
                    className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
                  >
                    <option value="">
                      {t('migration.storageMigrationSection.skip', '— skip —')}
                    </option>
                    {options.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )
          })}
        </div>

        {actionError && <p className="mt-2 text-[11px] text-danger">{actionError}</p>}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void handlePlan()
            }}
            disabled={!destinations || planQuery.isFetching || running}
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-foreground-subtle hover:text-foreground hover:bg-surface-hover disabled:opacity-50"
          >
            {planQuery.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('migration.storageMigrationSection.plan', 'Plan')}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleStart()
            }}
            disabled={!destinations || startMigration.isPending || running}
            className="inline-flex items-center gap-1.5 rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {startMigration.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('migration.storageMigrationSection.startMigration', 'Start migration')}
          </button>
        </div>

        {plan && (
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {plan.moves.length === 0 ? (
              <p className="px-2.5 py-1.5 text-[11px] text-foreground-subtle">
                {t(
                  'migration.storageMigrationSection.nothingToMoveSelectedDestinations',
                  'Nothing to move — selected destinations match the current defaults.',
                )}
              </p>
            ) : (
              plan.moves.map((m) => (
                <div
                  key={`${m.storageClass}-${m.toLocationId}`}
                  className="px-2.5 py-1.5 text-[11px] text-foreground"
                >
                  {m.storageClass}: {m.fromLocationId} → {m.toLocationId}
                </div>
              ))
            )}
          </div>
        )}

        {job && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-foreground">
                {t('migration.storageMigrationSection.migrationStatus', 'Migration status')}
              </h4>
              {running && (
                <button
                  type="button"
                  onClick={() => {
                    void handleCancel()
                  }}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10"
                >
                  <X className="h-3 w-3" />
                  {t('common.cancel', 'Cancel')}
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-foreground">
              {t('migration.storageMigrationSection.phase', 'Phase:')}{' '}
              <span className="font-medium">{job.phase}</span>
              {running && <Loader2 className="ml-2 inline h-3 w-3 animate-spin text-primary" />}
            </p>
            {job.error && <p className="mt-1 text-[11px] text-danger">{job.error}</p>}
            {job.pausedParticipants.length > 0 && (
              <p className="mt-1 text-[11px] text-foreground-subtle">
                {t('migration.storageMigrationSection.paused', 'Paused:')}{' '}
                {job.pausedParticipants.join(', ')}
              </p>
            )}
            <div className="mt-2 divide-y divide-border rounded-md border border-border">
              {job.moves.map((m) => (
                <MoveRow key={`${m.storageClass}-${m.fromLocationId}`} move={m} />
              ))}
            </div>
          </div>
        )}

        <MigrationHistory />
      </section>

      <DrainSection running={running} />
      <UnmanagedMovers />
    </div>
  )
}

/**
 * One move, with the mover's own numbers under it.
 *
 * Before this the row said `draining` and nothing else for five hours. The
 * counters are POLLED off the durable job record (`storageMigration.status`,
 * refetched every 2 s) — there is no progress event, deliberately: an event may
 * be dropped, and a dropped one is indistinguishable from a stalled mover.
 */
interface MoveRowProps {
  readonly move: StorageMigrationMove
}

function MoveRow({ move }: MoveRowProps) {
  const { t } = useTranslation()
  const line = move.progress === null ? null : describeProgress(move.progress)
  return (
    <div className="px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-foreground">
          {move.storageClass}: {move.fromLocationId} → {move.toLocationId}
        </span>
        <span className="text-foreground-subtle">
          {move.state ?? t('common.pending')}
          {move.error ? ` (${move.error})` : ''}
        </span>
      </div>
      {move.progress !== null && (
        <div className="mt-1 space-y-1">
          {line !== null && line.fraction !== null && (
            <div className="h-1 w-full overflow-hidden rounded bg-border">
              <div
                className="h-full bg-primary"
                style={{ width: `${(line.fraction * 100).toFixed(1)}%` }}
              />
            </div>
          )}
          <p className="text-[10px] text-foreground-subtle">{progressSummary(move.progress)}</p>
        </div>
      )}
    </div>
  )
}

function MigrationHistory() {
  const { t } = useTranslation()
  const { data: jobs } = useStorageMigrationHistory({})
  if (!jobs || jobs.length === 0) return null
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h4 className="text-xs font-semibold text-foreground">
        {t('migration.storageMigrationSection.migrationHistory', 'Migration history')}
      </h4>
      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {jobs.map((job) => (
          <div key={job.jobId} className="px-2.5 py-1.5 text-[11px] text-foreground-subtle">
            <span className="font-medium text-foreground">{job.phase}</span>
            {' · '}
            {Object.entries(job.destinations)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
              .map(([cls, dest]) => `${cls} → ${dest}`)
              .join(', ')}
            {' · '}
            {new Date(job.startedAt).toLocaleString()}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * "Drain remaining" — the supported way to run the second half alone.
 *
 * It exists because a migration that reached `done` has already repointed, so
 * `storageMigration.start` correctly refuses its destination ("already the
 * default") while the archive is still sitting on the source. That refusal is
 * kept exactly as it was: `drain` is a different verb that cannot repoint
 * anything.
 *
 * The button is driven by `storageMigration.residue`, which is a ledger census
 * (D295). An empty residue renders NOTHING — no button, no "drain" affordance —
 * so the action can never be offered for a source that is already empty.
 */
interface DrainSectionProps {
  /** A migration is in flight; the coordinator would refuse a drain anyway, so
   *  the button is disabled rather than left to fail. */
  readonly running: boolean
}

function DrainSection({ running }: DrainSectionProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  /**
   * OPERATOR-DRIVEN, and deliberately not on a timer.
   *
   * This was `refetchInterval: 10_000`. `storageMigration.residue` reaches
   * `pipelineAnalytics.countRelocatableMedia`, which WALKS the 1.26 M-row
   * `media` collection twice plus `retrain-frames` once — ~12 600 store round
   * trips per answer — and the walk had no stop signal, so a ten-second timer
   * did not replace the previous census, it ADDED one. Measured on the live hub
   * 2026-08-31: that single query shape was 88.7 % of the settings engine's
   * wall clock, top-1 in 359 of 359 profiler windows over six hours, with an
   * inferred ~500 walks in flight and a ~16 s standing FIFO queue in front of
   * every store call in the cluster. Nothing but a runner respawn cleared them.
   *
   * `staleTime: Infinity` + `refetchOnWindowFocus: false` because every other
   * way React Query would re-run this on its own is the same defect with a
   * different trigger. What stays live is the MIGRATION — `status` and
   * `movers` poll every 2 s, and they are bounded reads of one job record.
   */
  const residueQuery = useStorageMigrationResidue(
    {},
    { staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
  )
  const drainMigration = useStorageMigrationDrain()
  const [drainError, setDrainError] = useState<string | null>(null)
  const residue = residueQuery.data ?? []

  if (residue.length === 0) return null

  const handleDrain = async (entry: StorageMigrationResidue): Promise<void> => {
    const ok = await confirm({
      title: t(
        'migration.storageMigrationSection.drainRemaining',
        'Drain remaining {{storageClass}}?',
        { storageClass: entry.storageClass },
      ),
      message:
        `Moves what is still on ${entry.fromLocationId} to ${entry.toLocationId}. Nothing is paused ` +
        `and no default is changed — this is the second half of a migration, run on its own. ` +
        `It is resumable: cancelling leaves everything readable from both locations.`,
      confirmLabel: t('migration.storageMigrationSection.drainRemaining2', 'Drain remaining'),
      variant: 'danger',
    })
    if (!ok) return
    setDrainError(null)
    try {
      await drainMigration.mutateAsync({ classes: [entry.storageClass] })
      await residueQuery.refetch()
    } catch (err) {
      setDrainError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          {t('migration.storageMigrationSection.leftOnTheOldLocation', 'Left on the old location')}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[10px] text-foreground-subtle">
            {residueQuery.dataUpdatedAt > 0
              ? t('migration.storageMigrationSection.measured', 'Measured {{value1}}', {
                  value1: new Date(residueQuery.dataUpdatedAt).toLocaleTimeString(),
                })
              : t('migration.storageMigrationSection.measuredNever', 'Measured — never')}
          </span>
          <button
            type="button"
            onClick={() => {
              void residueQuery.refetch()
            }}
            /* A second press while one is in flight would start a SECOND
             * whole-collection walk — the accumulation, by hand. The label
             * changes with the state so a disabled button is never a mystery. */
            disabled={residueQuery.isFetching}
            className="rounded border border-border px-2 py-1 text-[10px] font-medium text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
          >
            {residueQuery.isFetching
              ? t('migration.storageMigrationSection.counting', 'Counting…')
              : t('common.refresh', 'Refresh')}
          </button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-foreground-subtle">
        {t(
          'migration.storageMigrationSection.aMigrationRepointsFirstAnd',
          'A migration repoints first and drains behind. If the drain was cancelled, failed, or was interrupted by a restart, the data below is still on the source — readable, but not where the defaults now point. Draining moves it; it changes no default and pauses nothing.',
        )}
      </p>
      <p className="mt-1 text-[10px] text-foreground-subtle">
        {t(
          'migration.storageMigrationSection.thisCountIsTakenOn',
          'This count is taken on demand: measuring it walks the whole media collection, so it is not refreshed on a timer. Press Refresh after a drain finishes.',
        )}
      </p>
      {drainError && <p className="mt-2 text-[11px] text-danger">{drainError}</p>}
      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {residue.map((entry) => (
          <div
            key={`${entry.storageClass}-${entry.fromLocationId}`}
            className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]"
          >
            <span className="text-foreground">
              {entry.storageClass}: {entry.fromLocationId} → {entry.toLocationId}
              <span className="ml-2 text-foreground-subtle">{describeResidue(entry)}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                void handleDrain(entry)
              }}
              disabled={running || drainMigration.isPending}
              className="shrink-0 rounded border border-border px-2 py-1 text-[10px] font-medium text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
            >
              {t('migration.storageMigrationSection.drainRemaining2', 'Drain remaining')}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * How much is left, worded so an unmeasurable answer never reads as an empty
 * source. `items: null` means the archive could not be asked (D295) — the whole
 * point of the shape is that it is not a zero.
 */
function describeResidue(entry: StorageMigrationResidue): string {
  if (entry.items === null) return i18n.t('recordings.storageMigrationSection.residueUnknown')
  const items = entry.items.toLocaleString('en-US')
  return entry.bytes === null
    ? i18n.t('recordings.storageMigrationSection.residueRows', { count: entry.items, items })
    : i18n.t('recordings.storageMigrationSection.residueSegments', {
        count: entry.items,
        items,
        size: formatBytes(entry.bytes),
      })
}

/**
 * Movers nothing here armed.
 *
 * `recording.relocateFootage` and `pipelineAnalytics.relocateMedia` are both
 * operator-callable, and until "Drain remaining" existed that was the only way
 * to run a drain at all — a five-hour job with no UI. Shown separately from the
 * migration's own moves so it is obvious the coordinator is not driving it.
 */
function UnmanagedMovers() {
  const { t } = useTranslation()
  const { data } = useStorageMigrationMovers({}, { refetchInterval: 2_000 })
  const unmanaged = (data ?? []).filter(
    (mover) => mover.migrationJobId === null && mover.job.state === 'running',
  )
  if (unmanaged.length === 0) return null
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t(
          'migration.storageMigrationSection.moversRunningOutsideAMigration',
          'Movers running outside a migration',
        )}
      </h3>
      <div className="mt-2 divide-y divide-border rounded-md border border-border">
        {unmanaged.map((mover) => (
          <div key={mover.job.jobId} className="px-2.5 py-1.5 text-[11px]">
            <div className="text-foreground">
              {mover.lane}: {mover.job.fromLocationId} → {mover.job.toLocationId}
            </div>
            {/* Both timestamps are the HUB's — `observedAt` is stamped by the
                coordinator when it read the mover — so the rate is not made of
                two different clocks. */}
            <p className="mt-1 text-[10px] text-foreground-subtle">
              {progressSummary({
                filesMoved: mover.job.filesMoved,
                filesTotal: mover.job.filesTotal,
                bytesMoved: mover.job.bytesMoved,
                startedAt: mover.job.startedAt,
                observedAt: mover.observedAt,
              })}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
