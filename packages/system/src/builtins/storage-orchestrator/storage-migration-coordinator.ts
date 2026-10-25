import type {
  RelocatableMediaCount,
  RelocatableMediaCountInput,
  RelocateFootageInput,
  RelocateJob,
  RelocateMediaInput,
  RelocateResidue,
  RelocateResidueInput,
  StorageMigrationClass,
  StorageMigrationDrainInput,
  StorageMigrationFinding,
  StorageMigrationFootageMoveInput,
  StorageMigrationInput,
  StorageMigrationJob,
  StorageMigrationLane,
  StorageMigrationMediaMoveInput,
  StorageMigrationMode,
  StorageMigrationMove,
  StorageMigrationMover,
  StorageMigrationParticipant,
  StorageMigrationPlan,
  StorageMigrationResidue,
  UnstampedEventMediaCount,
  UnstampedRows,
} from '@camstack/types'
import { mayWriteToLocation, resolveLocationMode, withLocationMode } from '@camstack/types'
import type { StorageOrchestratorService } from './storage-orchestrator.service.js'

const STORAGE_CLASSES: readonly StorageMigrationClass[] = [
  'recordings',
  'recordingsLow',
  'eventMedia',
  'backups',
]
/** The classes footage/media movers actually own. Everything else is planned,
 *  reported and refused rather than silently accepted. */
const MOVER_CLASSES: readonly StorageMigrationClass[] = [
  'recordings',
  'recordingsLow',
  'eventMedia',
]
/** The two single-flight mover engines. Lanes run in parallel; within a lane,
 *  classes run FIFO because the engine refuses a second concurrent job. */
const MOVE_LANES: readonly StorageMigrationLane[] = ['media', 'footage']
const PARTICIPANTS: readonly StorageMigrationParticipant[] = ['pipeline', 'recorder', 'analytics']
const REVERSE_PARTICIPANTS: readonly StorageMigrationParticipant[] = [
  'analytics',
  'recorder',
  'pipeline',
]

export interface MigrationState {
  get(): Promise<StorageMigrationJob | null>
  set(value: StorageMigrationJob | null): Promise<void>
}

export interface MigrationHistoryState {
  get(): Promise<readonly StorageMigrationJob[]>
  set(value: readonly StorageMigrationJob[]): Promise<void>
}

export interface LeaseParticipant {
  pause(leaseId: string): Promise<void>
  resume(leaseId: string): Promise<void>
}

export interface FootageMigrationParticipant extends LeaseParticipant {
  startMove(input: StorageMigrationFootageMoveInput): Promise<{ jobId: string }>
  /**
   * The SAME engine, armed without a maintenance lease — `recording.relocateFootage`.
   * The `draining` phase runs after every writer has already been resumed, so
   * there is no lease left to present; a lease-gated call there would be
   * refused by the participant.
   */
  startDrain(input: RelocateFootageInput): Promise<{ jobId: string }>
  getMove(jobId: string): Promise<RelocateJob | null>
  cancelMove(jobId: string): Promise<boolean>
  refresh(leaseId: string): Promise<void>
  /** Every mover this engine knows about — including ones no migration armed. */
  listMovers(): Promise<readonly RelocateJob[]>
  /** What a source STILL holds, from the durable hour ledger (D295). */
  residue(input: RelocateResidueInput): Promise<RelocateResidue>
}

export interface MediaMigrationParticipant extends LeaseParticipant {
  startMove(input: StorageMigrationMediaMoveInput): Promise<{ jobId: string }>
  /** Unleased twin of {@link startMove} — `pipelineAnalytics.relocateMedia`.
   *  Also the only way to run the `seal` pass, which happens BEFORE any lease
   *  exists. */
  startDrain(input: RelocateMediaInput): Promise<{ jobId: string }>
  /** Rows that still carry no `locationId`. Read at plan time and re-read after
   *  the seal; never inferred from a seal job's terminal state. */
  countUnstamped(): Promise<UnstampedEventMediaCount>
  getMove(jobId: string): Promise<RelocateJob | null>
  cancelMove(jobId: string): Promise<boolean>
  refresh(leaseId: string): Promise<void>
  /** Every mover this engine knows about — including ones no migration armed. */
  listMovers(): Promise<readonly RelocateJob[]>
  /** How many rows a pass would still act on — the media lane's residue, from
   *  the same derivation that produces its `filesTotal`. */
  residue(input: RelocatableMediaCountInput): Promise<RelocatableMediaCount>
}

export interface StorageMigrationParticipants {
  readonly pipeline: LeaseParticipant
  readonly recorder: FootageMigrationParticipant
  readonly analytics: MediaMigrationParticipant
}

export interface StorageMigrationCoordinatorDeps {
  readonly locations: StorageOrchestratorService
  readonly state: MigrationState
  readonly history?: MigrationHistoryState
  readonly participants: StorageMigrationParticipants
  readonly now: () => number
  readonly newId: () => string
  readonly sleep?: (ms: number) => Promise<void>
  readonly pollMs?: number
  /**
   * A stable key for the PHYSICAL device behind a location — the orchestrator's
   * own `getLocationDeviceKey`, injected so the planner does not reach for
   * `fs` itself.
   *
   * `null` = not answerable here. It is PATH identity (a realpath), not
   * `st_dev`: two distinct directories on one filesystem produce two different
   * keys and are NOT detected as the same device. And a location can carry a
   * `nodeId`, in which case the realpath would have to be taken on THAT node —
   * so a remote location answers `null` rather than a meaningless local
   * answer. Both limits are surfaced to the operator as plan findings; neither
   * is papered over.
   */
  readonly deviceKeyOf?: (locationId: string) => Promise<string | null>
}

/**
 * One lane of the seal gate, as an operator reads it.
 *
 * "0" and "unknown" must not print the same, and neither may be silently
 * turned into the other: `{ present: true, rows: null }` is "there are some
 * and the count did not land", which is a refusal with a missing number, not a
 * clean lane.
 */
function describeUnstamped(lane: UnstampedRows): string {
  if (!lane.present) return '0'
  return lane.rows === null ? 'an unknown number of' : lane.rows.toString()
}

/**
 * Durable orchestration layer over the independent recorder and event-media
 * movers. It owns the only public migration state machine; participants expose
 * intentionally narrow lease/move primitives and never alter camera settings.
 */
export class StorageMigrationCoordinator {
  private active: StorageMigrationJob | null = null
  private runPromise: Promise<void> | null = null
  private startReserved = false

  constructor(private readonly deps: StorageMigrationCoordinatorDeps) {}

  async plan(input: StorageMigrationInput): Promise<StorageMigrationPlan> {
    refuseRetiredGalleryClass(input.destinations)
    const mode: StorageMigrationMode = input.mode ?? 'blocking'
    const moves: StorageMigrationMove[] = []
    const findings: StorageMigrationFinding[] = []
    for (const storageClass of STORAGE_CLASSES) {
      const targetId = input.destinations[storageClass]
      if (targetId === undefined) continue
      const namedSourceId = input.sources?.[storageClass]
      // The source of an unnamed cutover is derived from the WRITE SET, not
      // from a default (D383): the class writes to exactly one location other
      // than the target, and that is the one being cut over. Several ⇒ the
      // operator must say which, because a coordinator that picks one is making
      // a placement decision (D54).
      const writeSet = this.deps.locations.writeTargets(storageClass)
      const implicitSources = writeSet.filter((loc) => loc.id !== targetId)
      if (!namedSourceId && implicitSources.length > 1) {
        throw new Error(
          `"${storageClass}" writes to ${String(implicitSources.length)} locations ` +
            `(${implicitSources.map((loc) => loc.id).join(', ')}) — name the one to cut over ` +
            `explicitly with \`sources\`.`,
        )
      }
      const source = namedSourceId
        ? this.deps.locations.getLocationById(namedSourceId)
        : implicitSources[0]
      if (!source) {
        throw new Error(
          namedSourceId
            ? `Storage location "${namedSourceId}" not found`
            : `Storage location "${targetId}" is already the only write target for "${storageClass}" — there is nothing to cut over. Use storageMigration.drain to move what is left behind.`,
        )
      }
      if (source.type !== storageClass) {
        throw new Error(
          `Storage location "${source.id}" is type "${source.type}", expected "${storageClass}"`,
        )
      }
      const target = this.deps.locations.getLocationById(targetId)
      if (!target) throw new Error(`Storage location "${targetId}" not found`)
      if (target.type !== storageClass) {
        throw new Error(
          `Storage location "${targetId}" is type "${target.type}", expected "${storageClass}"`,
        )
      }
      if (source.id === target.id) {
        throw new Error(
          namedSourceId
            ? `Source and destination are the same location ("${targetId}")`
            : `Storage location "${targetId}" is already the only write target for "${storageClass}"`,
        )
      }
      // `freezeSource` is "the source is NOT a write target at plan time" — a
      // drain off a location the operator already disabled. The cutover phase
      // moves the write set itself (enable the destination, disable the source)
      // for every other move, so nothing has to be frozen afterwards.
      const freezeSource = !writeSet.some((loc) => loc.id === source.id)
      // ── Refusals ────────────────────────────────────────────────────────
      // A class with no mover would pause every writer, repoint the default,
      // and move nothing — the archive left on the source, the record saying
      // it moved. Refuse rather than plan it.
      if (!MOVER_CLASSES.includes(storageClass)) {
        throw new Error(
          `No mover owns "${storageClass}" — the migration can move its write set but cannot move its bytes. ` +
            `Move it by hand, then enable the destination (and disable the source) with upsertLocation.`,
        )
      }
      moves.push({
        storageClass,
        fromLocationId: source.id,
        toLocationId: target.id,
        freezeSource,
        moverJobId: null,
        state: null,
        error: null,
        progress: null,
      })
      findings.push(...(await this.deviceFindings(storageClass, source.id, target.id)))
    }
    if (moves.length === 0) throw new Error('select at least one storage class')

    // ── The `eventMedia` NULL-row gate ────────────────────────────────────
    // A row with `locationId: NULL` means "wherever eventMedia points NOW". The
    // instant a non-blocking cutover repoints the default, every such row reads
    // from the new disk while its bytes are on the old one — the archive goes
    // dark until a drain happens to stamp it. `blocking` does not have this
    // hole: its mover stamps every row BEFORE anything repoints.
    if (moves.some((move) => move.storageClass === 'eventMedia')) {
      const unstamped = await this.deps.participants.analytics.countUnstamped()
      // `null` = the analytics node could not say. That is NOT an absence, and
      // it is the failure this gate is most likely to meet: the count was
      // timing out on the live hub every time it ran. A cutover armed on an
      // unread collection is exactly the silent orphaning the gate exists to
      // prevent, so unknown refuses in non-blocking mode and is REPORTED in
      // blocking mode rather than passing as a clean plan.
      if (unstamped === null) {
        if (mode === 'nonBlocking') {
          throw new Error(
            'could not determine whether any event-media row still carries no locationId. ' +
              'A non-blocking cutover moves the write set and would silently orphan every such ' +
              'row, so an unmeasured collection is refused exactly like a non-empty one. Retry, ' +
              'or run the blocking mode, which stamps rows as it moves them.',
          )
        }
        findings.push({
          code: 'unstampedEventMediaRows',
          storageClass: 'eventMedia',
          message:
            'the count of event-media rows carrying no locationId could not be taken — treat it as ' +
            'unknown, not as zero. This blocking migration stamps them as it moves them, so it is ' +
            'safe regardless; a non-blocking one would be refused.',
        })
      } else if (unstamped.anyPresent) {
        // `anyPresent`, not `total > 0`: the existence probe is the load-bearing
        // fact and it survives a count that failed. `total: null` with rows
        // present must refuse, and `total > 0` alone would let it through.
        const scale = unstamped.total === null ? 'an unknown number of' : unstamped.total.toString()
        const perLane =
          `${describeUnstamped(unstamped.media)} media, ` +
          `${describeUnstamped(unstamped.retrainFrames)} retrain frames`
        if (mode === 'nonBlocking') {
          throw new Error(
            `${scale} event-media row(s) still carry no locationId ` +
              `(${perLane}). ` +
              `A non-blocking cutover would silently orphan them. Run the seal first: ` +
              `pipelineAnalytics.relocateMedia({ mode: "seal", toLocationId: "${
                this.deps.locations.writeTargets('eventMedia')[0]?.id ?? 'eventMedia'
              }" }).`,
          )
        }
        findings.push({
          code: 'unstampedEventMediaRows',
          storageClass: 'eventMedia',
          message:
            `${scale} event-media row(s) carry no locationId (${perLane}). This blocking ` +
            `migration stamps them as it moves them, but a non-blocking one would be refused until ` +
            `a seal pass drives the count to zero.`,
        })
      }
    }
    return {
      destinations: input.destinations,
      sources: input.sources,
      mode,
      moves: moves.map(({ storageClass, fromLocationId, toLocationId, freezeSource }) => ({
        storageClass,
        fromLocationId,
        toLocationId,
        freezeSource,
      })),
      findings,
    }
  }

  /** Same-device observations that are reported, not refused. */
  private async deviceFindings(
    storageClass: StorageMigrationClass,
    sourceId: string,
    targetId: string,
  ): Promise<readonly StorageMigrationFinding[]> {
    if (this.deps.deviceKeyOf === undefined) return []
    const [sourceKey, targetKey] = await Promise.all([
      this.deviceKey(sourceId),
      this.deviceKey(targetId),
    ])
    if (sourceKey === null || targetKey === null) {
      return [
        {
          code: 'deviceIdentityUnknown',
          storageClass,
          message:
            `Could not establish whether "${sourceId}" and "${targetId}" are on the same device ` +
            `(a location with no basePath, or pinned to another node — the realpath would have to ` +
            `be taken there). Note also that this check is PATH identity, not st_dev: two distinct ` +
            `directories on one filesystem are never detected as one device.`,
        },
      ]
    }
    if (sourceKey !== targetKey) return []
    return [
      {
        code: 'sharesDeviceWithSource',
        storageClass,
        message:
          `"${targetId}" resolves to the same path as "${sourceId}". The move will re-stamp rows ` +
          `rather than copy bytes, and it buys no redundancy — both "locations" are one disk.`,
      },
    ]
  }

  private async deviceKey(locationId: string): Promise<string | null> {
    if (this.deps.deviceKeyOf === undefined) return null
    return this.deps.deviceKeyOf(locationId)
  }

  async start(input: StorageMigrationInput): Promise<string> {
    if (this.startReserved) throw new Error('storage migration is already active')
    this.startReserved = true
    try {
      const existing = await this.status()
      if (existing && isTerminal(existing) && existing.pausedParticipants.length > 0) {
        await this.releaseAfterTerminal(existing)
        await this.persist(existing)
        if (existing.pausedParticipants.length > 0) {
          throw new Error(`storage migration ${existing.jobId} still holds maintenance leases`)
        }
      }
      if (existing && !isTerminal(existing)) {
        throw new Error(`storage migration is already active (${existing.jobId})`)
      }
      const plan = await this.plan(input)
      const now = this.deps.now()
      const job: StorageMigrationJob = {
        jobId: this.deps.newId(),
        phase: 'planning',
        mode: plan.mode,
        destinations: input.destinations,
        sources: input.sources,
        throttleMbps: input.throttleMbps ?? 40,
        moves: plan.moves.map((move) => ({
          ...move,
          moverJobId: null,
          state: null,
          error: null,
          progress: null,
        })),
        pauseLeaseId: null,
        pausedParticipants: [],
        repointed: false,
        cancelRequested: false,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
      }
      // Durable FIRST, in-memory second. A persist that throws must leave this
      // coordinator startable: on the live hub the reverse order published an
      // `active` job that had never landed, so `status` reported a migration
      // stuck in `planning` forever, `start` answered "already active" and
      // `cancel` re-entered the same failing write. Nothing short of a hub
      // restart cleared it.
      await this.persist(job)
      this.active = job
      this.runPromise = this.run(job)
      void this.runPromise
      return job.jobId
    } finally {
      this.startReserved = false
    }
  }

  async status(jobId?: string): Promise<StorageMigrationJob | null> {
    const job = this.active ?? (await this.deps.state.get())
    if (jobId !== undefined && job?.jobId !== jobId) return null
    return job
  }

  /** Finished jobs, newest first, excluding the one `status` currently shows. */
  async history(): Promise<readonly StorageMigrationJob[]> {
    const current = await this.status()
    const all = (await this.deps.history?.get()) ?? []
    return all.filter((job) => job.jobId !== current?.jobId)
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.status(jobId)
    // Once defaults changed, cancellation cannot safely undo the operation.
    // Keep every writer paused until cache refresh succeeds instead of
    // resuming against stale roots — that window is `refreshing`/`resuming`,
    // and only there.
    //
    // A non-blocking job spends most of its life repointed AND fully running
    // (`draining`), where a cancel is a perfectly good outcome: the movers stop
    // after the current hour, everything moved is readable at the destination,
    // everything not moved is readable at the source, and the class stays split
    // until someone re-drains it. Refusing there would have made the long half
    // of every non-blocking migration uncancellable.
    const cutoverInFlight =
      job !== null && job.repointed && (job.phase === 'refreshing' || job.phase === 'resuming')
    if (!job || isTerminal(job) || cutoverInFlight) return false
    job.cancelRequested = true
    await this.persist(job)
    await Promise.all(
      job.moves.filter((move) => move.moverJobId !== null).map((move) => this.cancelMove(move)),
    )
    return true
  }

  /**
   * Every mover running right now, in both lanes — including the ones no
   * migration armed.
   *
   * `status` already carries a migration's own progress (the coordinator folds
   * it onto each move from the poll it is already doing). This exists for the
   * other half: `recording.relocateFootage` and `pipelineAnalytics.relocateMedia`
   * are operator-callable, and until {@link drain} existed that was the only way
   * to run a drain at all. Such a mover has no job to fold into, so without this
   * read a five-hour operation is invisible in the UI.
   *
   * `migrationJobId` is best-effort by construction: the coordinator keeps ONE
   * durable job, so a mover armed by an older, since-overwritten migration
   * reports `null`. That is the honest answer — nothing here can still claim it.
   */
  async movers(): Promise<readonly StorageMigrationMover[]> {
    const job = await this.status()
    const owned = new Map<string, string>()
    for (const move of job?.moves ?? []) {
      if (move.moverJobId !== null) owned.set(move.moverJobId, job?.jobId ?? '')
    }
    const [footage, media] = await Promise.all([
      this.deps.participants.recorder.listMovers(),
      this.deps.participants.analytics.listMovers(),
    ])
    const observedAt = this.deps.now()
    const label = (
      lane: StorageMigrationLane,
      jobs: readonly RelocateJob[],
    ): readonly StorageMigrationMover[] =>
      jobs.map((mover) => ({
        lane,
        job: mover,
        migrationJobId: owned.get(mover.jobId) ?? null,
        observedAt,
      }))
    return [...label('footage', footage), ...label('media', media)]
  }

  /**
   * What every class's source STILL holds — the census behind a "drain
   * remaining" action.
   *
   * A class appears here only when something is (or might be) left on a
   * location outside its write set. An empty result therefore means exactly
   * "there is nothing to drain", which is what lets the UI offer the action
   * only when it is true, and what lets {@link drain} refuse rather than start
   * a job that would move nothing and report `done` — the failure mode D295
   * exists to end.
   *
   * `items: null` is "the archive could not be asked" and is still listed. A
   * residue nobody could measure is the case an operator most needs to see;
   * dropping it because the read failed would be the quiet success again.
   */
  async residue(): Promise<readonly StorageMigrationResidue[]> {
    const out: StorageMigrationResidue[] = []
    for (const storageClass of STORAGE_CLASSES) {
      if (!MOVER_CLASSES.includes(storageClass)) continue
      // Residue is what sits on a location OUTSIDE the write set (D383) — a
      // pool MEMBER holding footage is where the class writes, not something to
      // drain. The destination is the pool's first member by id; with several
      // enabled the drain verb takes a named target and the operator's choice
      // overrides this one.
      const writeSet = this.deps.locations.writeTargets(storageClass)
      const target = writeSet[0]
      if (!target) continue
      const inWriteSet = new Set(writeSet.map((loc) => loc.id))
      if (laneOf(storageClass) === 'media') {
        for (const source of this.deps.locations.listLocations({ type: storageClass })) {
          if (inWriteSet.has(source.id)) continue
          const count = await unanswerable(
            this.deps.participants.analytics.residue({
              toLocationId: target.id,
              fromLocationId: source.id,
              mode: 'move',
            }),
          )
          if (count !== null && count.rows === 0) continue
          out.push({
            storageClass,
            fromLocationId: source.id,
            toLocationId: target.id,
            items: count?.rows ?? null,
            bytes: null,
          })
        }
        continue
      }
      for (const source of this.deps.locations.listLocations({ type: storageClass })) {
        if (inWriteSet.has(source.id)) continue
        const census = await unanswerable(
          this.deps.participants.recorder.residue({
            fromLocationId: source.id,
            footageClass: storageClass === 'recordingsLow' ? 'recordingsLow' : 'recordings',
          }),
        )
        if (census !== null && census.segments === 0) continue
        out.push({
          storageClass,
          fromLocationId: source.id,
          toLocationId: target.id,
          items: census?.segments ?? null,
          bytes: census?.bytes ?? null,
        })
      }
    }
    return out
  }

  /**
   * Run the DRAIN half alone, against classes whose write set has already moved.
   *
   * ## Why this is a second verb rather than a looser `start`
   *
   * `start` refuses a destination that is already the class's only write target
   * (`"recordingsLow:ssd" is already the only write target for "recordingsLow"`). That refusal
   * is correct and it is load-bearing: there is genuinely nothing left to
   * repoint, and an operator must never be able to re-repoint a migrated class
   * by accident. Making `start` idempotent — "an already-repointed class
   * proceeds straight to draining" — would delete that protection AND make the
   * verb mean two different things depending on state, so the confirmation an
   * operator reads ("pauses the writers…") would be a lie half the time.
   *
   * `drain` instead cannot repoint AT ALL: it never touches
   * `setWriteTargets`, and its job starts in `draining` with `repointed`
   * already true, so the `repointing` / `refreshing` / `resuming` blocks of
   * {@link run} are behind it and unreachable. The two verbs are disjoint, and
   * `start`'s refusal keeps meaning exactly what it meant.
   *
   * ## Why it re-derives the work instead of resuming the old job
   *
   * The finished job is the audit of what happened; re-opening it destroys
   * that. And a drain is needed in cases where no migration job ever existed
   * (a mover armed by hand, footage stranded on a location an operator added
   * and then disabled again). One job = one operation, and the work list comes
   * from {@link residue} — the archive — not from what a previous job believed.
   */
  async drain(input: StorageMigrationDrainInput): Promise<string> {
    if (this.startReserved) throw new Error('storage migration is already active')
    this.startReserved = true
    try {
      const existing = await this.status()
      if (existing && isTerminal(existing) && existing.pausedParticipants.length > 0) {
        await this.releaseAfterTerminal(existing)
        await this.persist(existing)
        if (existing.pausedParticipants.length > 0) {
          throw new Error(`storage migration ${existing.jobId} still holds maintenance leases`)
        }
      }
      if (existing && !isTerminal(existing)) {
        throw new Error(`storage migration is already active (${existing.jobId})`)
      }
      for (const storageClass of input.classes) {
        if (MOVER_CLASSES.includes(storageClass)) continue
        throw new Error(
          `No mover owns "${storageClass}" — there is nothing that can drain it. ` +
            `Move it by hand.`,
        )
      }
      const residue = await this.residue()
      const moves: StorageMigrationMove[] = []
      const destinations: Partial<Record<StorageMigrationClass, string>> = {}
      for (const storageClass of input.classes) {
        const remaining = residue.filter((entry) => entry.storageClass === storageClass)
        if (remaining.length === 0) {
          throw new Error(
            `"${storageClass}" has nothing left outside its write set — there is nothing ` +
              `to drain. To CHANGE where it writes, use storageMigration.start with a new destination.`,
          )
        }
        for (const entry of remaining) {
          // A drain is a WRITE — the biggest one this system performs. Its
          // destination comes from the write set, which the orchestrator keeps
          // non-empty; a persisted row hydrated straight into the map can still
          // contradict that. Refuse rather than pour a six-figure file count
          // onto a disk the operator retired: the operator's flag is the
          // authority, and a drain has no "carry on under protest" mode the way
          // live recording does.
          const target = this.deps.locations.getLocationById(entry.toLocationId)
          if (target !== undefined && !mayWriteToLocation(target)) {
            throw new Error(
              `The "${storageClass}" drain destination "${entry.toLocationId}" is not a write ` +
                `target (mode: ${resolveLocationMode(target)}) — it takes no writes, and a drain ` +
                `is the largest write there is. Set it active on the Storage screen first.`,
            )
          }
          moves.push({
            storageClass,
            fromLocationId: entry.fromLocationId,
            toLocationId: entry.toLocationId,
            moverJobId: null,
            state: null,
            error: null,
            progress: null,
          })
          destinations[storageClass] = entry.toLocationId
        }
      }
      const now = this.deps.now()
      const job: StorageMigrationJob = {
        jobId: this.deps.newId(),
        // Straight into the long half. Everything before it in the state
        // machine either changes a default or pauses a writer, and this verb
        // does neither.
        phase: 'draining',
        mode: 'nonBlocking',
        destinations,
        throttleMbps: input.throttleMbps ?? 40,
        moves,
        // No lease is minted and no participant is paused: `draining` and the
        // `verifying` that follows it both run with every writer already up
        // (`runsUnleased`), which is the whole reason this half is safe to run
        // for hours.
        pauseLeaseId: null,
        pausedParticipants: [],
        repointed: true,
        cancelRequested: false,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
      }
      // Durable first, in-memory second — for the same reason `start` does it:
      // an `active` job that never landed is unstoppable without a hub restart.
      await this.persist(job)
      this.active = job
      this.runPromise = this.run(job)
      void this.runPromise
      return job.jobId
    } finally {
      this.startReserved = false
    }
  }

  /** Boot recovery resumes a durable unfinished state. A missing in-memory
   * child mover is recreated from the same copy-if-absent input. */
  async recover(): Promise<void> {
    const job = await this.deps.state.get()
    if (!job) return
    if (job.cancelRequested) {
      // This process may have restarted while participants stayed alive. Their
      // persisted lease token is the only safe fence; release it as-is.
      await Promise.all(
        job.moves.filter((move) => move.moverJobId !== null).map((move) => this.cancelMove(move)),
      )
      await this.waitForMoves(job)
      await this.releaseAfterTerminal(job)
      job.phase = 'cancelled'
      job.finishedAt ??= this.deps.now()
      await this.persist(job)
      return
    }
    if (isTerminal(job)) {
      if (job.pausedParticipants.length > 0) {
        await this.releaseAfterTerminal(job)
        await this.persist(job)
      }
      return
    }
    this.active = job
    // Participant leases live only in addon RAM. A coordinator restart must
    // never trust the persisted names/tokens: mint a fresh lease, re-drain
    // every participant, and only then continue a move or post-repoint phase.
    job.pauseLeaseId ??= this.deps.newId()
    if (job.repointed && job.phase === 'resuming') job.phase = 'refreshing'
    await this.persist(job)
    // `sealing` and `draining` are the two phases that run with every writer
    // UP, by construction. Re-acquiring a maintenance lease to recover one of
    // them would stop recording for the length of a drain — which is the exact
    // cost the non-blocking mode exists to avoid.
    if (!runsUnleased(job)) {
      try {
        await this.pauseParticipants(job, true)
      } catch (err) {
        // Fail closed. For a post-repoint job this is deliberately NOT terminal:
        // a later recovery must re-acquire and refresh before any resume.
        job.error = err instanceof Error ? err.message : String(err)
        await this.persist(job)
        return
      }
    }
    if (this.runPromise === null) {
      this.runPromise = this.run(job)
      void this.runPromise
    }
  }

  /**
   * The state machine. Both modes run the SAME phase handlers; only the order
   * differs, which is the whole of the non-blocking design — no second mover,
   * no parallel code path, nothing that can drift between the two.
   *
   *   blocking:    planning → pausing → moving → verifying → repointing →
   *                refreshing → resuming → done
   *   nonBlocking: planning → sealing → pausing → repointing → refreshing →
   *                resuming → draining → verifying → done
   *
   * Written as a straight-line sequence of `if (phase === X)` blocks so boot
   * recovery re-enters at whatever phase the durable record says, exactly as
   * before.
   */
  private async run(job: StorageMigrationJob): Promise<void> {
    const nonBlocking = job.mode === 'nonBlocking'
    try {
      if (job.phase === 'planning') await this.setPhase(job, nonBlocking ? 'sealing' : 'pausing')
      if (job.phase === 'sealing') {
        await this.sealEventMedia(job)
        if (job.cancelRequested) return this.finishCancelled(job)
        await this.setPhase(job, 'pausing')
      }
      if (job.phase === 'pausing') {
        job.pauseLeaseId ??= job.jobId
        await this.pauseParticipants(job)
        if (job.cancelRequested) return this.finishCancelled(job)
        await this.setPhase(job, nonBlocking ? 'repointing' : 'moving')
      }
      if (job.phase === 'moving') {
        await this.startOrResumeMoves(job)
        await this.waitForMoves(job)
        if (job.cancelRequested) return this.finishCancelled(job)
        await this.setPhase(job, 'verifying')
      }
      // `verifying` runs BEFORE `repointing` in blocking mode (nothing may move
      // the write set until every byte is on the destination) and AFTER
      // `draining` in non-blocking mode (the write set moved first, on
      // purpose).
      if (job.phase === 'verifying' && !nonBlocking) {
        await this.verifyMoves(job)
        if (job.cancelRequested) return this.finishCancelled(job)
        await this.freezeDrainedSources(job)
        await this.setPhase(job, 'repointing')
      }
      if (job.phase === 'repointing') {
        // The cutover, expressed in the only authority there is: the
        // destination JOINS the write set and the source LEAVES it. Every other
        // enabled location of the class is untouched — a migration is not a
        // licence to shrink the operator's pool (D383).
        const targets = new Map<string, boolean>()
        for (const move of job.moves) {
          if (move.freezeSource === true) continue
          targets.set(move.toLocationId, true)
          targets.set(move.fromLocationId, false)
        }
        if (targets.size > 0) await this.deps.locations.setWriteTargets(targets)
        job.repointed = true
        await this.setPhase(job, 'refreshing')
      }
      if (job.phase === 'refreshing') {
        const leaseId = requireLease(job)
        if (job.moves.some((move) => laneOf(move.storageClass) === 'footage')) {
          await this.deps.participants.recorder.refresh(leaseId)
        }
        if (job.moves.some((move) => laneOf(move.storageClass) === 'media')) {
          await this.deps.participants.analytics.refresh(leaseId)
        }
        await this.setPhase(job, 'resuming')
      }
      if (job.phase === 'resuming') {
        await this.resumeParticipants(job)
        await this.setPhase(job, nonBlocking ? 'draining' : 'done')
      }
      // Everything below here runs with every writer BACK UP, on the new
      // default, reading the past from both locations (§3 of the design).
      if (job.phase === 'draining') {
        await this.startOrResumeMoves(job)
        await this.waitForMoves(job)
        if (job.cancelRequested) return this.finishCancelled(job)
        await this.setPhase(job, 'verifying')
      }
      if (job.phase === 'verifying' && nonBlocking) {
        await this.verifyMoves(job)
        if (job.cancelRequested) return this.finishCancelled(job)
        await this.freezeDrainedSources(job)
        await this.setPhase(job, 'done')
      }
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err)
      if (job.repointed && job.pausedParticipants.length > 0) {
        // The effective defaults already changed AND writers are still paused.
        // Do not terminalize and release them with stale resolved roots: retain
        // the maintenance lease and make boot recovery retry `refreshing`.
        //
        // The `pausedParticipants` half is what makes this correct in
        // non-blocking mode: a `draining` failure happens with every writer
        // already back up on the new root, so it is an ordinary terminal
        // failure — the class stays readable from both locations, which is a
        // supported steady state, not a stall to be retried forever.
        job.phase = 'refreshing'
        job.finishedAt = null
        await this.persist(job)
        return
      }
      job.phase = 'failed'
      job.finishedAt = this.deps.now()
      await this.releaseAfterTerminal(job)
      await this.persist(job)
    } finally {
      if (isTerminal(job)) {
        await this.releaseAfterTerminal(job)
        this.active = job
      }
      this.runPromise = null
    }
  }

  private async pauseParticipants(job: StorageMigrationJob, reacquire = false): Promise<void> {
    const leaseId = requireLease(job)
    for (const name of PARTICIPANTS) {
      if (job.cancelRequested) return
      if (!reacquire && job.pausedParticipants.includes(name)) continue
      await this.participant(name).pause(leaseId)
      if (!job.pausedParticipants.includes(name)) job.pausedParticipants.push(name)
      await this.persist(job)
    }
  }

  private async resumeParticipants(job: StorageMigrationJob): Promise<void> {
    const leaseId = requireLease(job)
    for (const name of REVERSE_PARTICIPANTS) {
      if (!job.pausedParticipants.includes(name)) continue
      await this.participant(name).resume(leaseId)
      job.pausedParticipants = job.pausedParticipants.filter((participant) => participant !== name)
      await this.persist(job)
    }
  }

  private async releaseAfterTerminal(job: StorageMigrationJob): Promise<void> {
    if (job.pauseLeaseId === null) return
    for (const name of REVERSE_PARTICIPANTS) {
      if (!job.pausedParticipants.includes(name)) continue
      try {
        await this.participant(name).resume(job.pauseLeaseId)
        job.pausedParticipants = job.pausedParticipants.filter(
          (participant) => participant !== name,
        )
        await this.persist(job)
      } catch {
        // Continue releasing every participant. The retained durable state
        // tells boot recovery which lease still needs releasing.
        // Leave the participant in durable state for a later recovery retry.
      }
    }
  }

  /**
   * Start whatever is startable, honouring the ONE constraint the engines
   * impose: each is single-flight.
   *
   * Two lanes — the recorder's footage engine and post-analysis's media engine
   * — run in parallel with each other and strictly FIFO within themselves.
   * `eventMedia` is the only class on the media lane.
   */
  private async startOrResumeMoves(job: StorageMigrationJob): Promise<void> {
    if (job.cancelRequested) return
    for (const lane of MOVE_LANES) {
      const laneMoves = job.moves.filter((move) => laneOf(move.storageClass) === lane)
      for (let index = 0; index < laneMoves.length; index++) {
        const move = laneMoves[index]
        if (move === undefined || move.moverJobId !== null) continue
        const predecessors = laneMoves.slice(0, index)
        if (!predecessors.every((predecessor) => predecessor.state === 'done')) break
        move.moverJobId = await this.startMove(job, move)
        await this.persist(job)
        break
      }
    }
  }

  private async waitForMoves(job: StorageMigrationJob): Promise<void> {
    const sleep =
      this.deps.sleep ??
      ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
    const pollMs = this.deps.pollMs ?? 250
    for (;;) {
      if (!job.cancelRequested) await this.startOrResumeMoves(job)
      let complete = true
      for (const [index, move] of job.moves.entries()) {
        if (job.cancelRequested && move.moverJobId === null) continue
        // Not yet this move's turn in its lane — its predecessors have to
        // finish through the same single-flight engine first.
        if (
          job.moves
            .slice(0, index)
            .filter((predecessor) => laneOf(predecessor.storageClass) === laneOf(move.storageClass))
            .some((predecessor) => predecessor.state !== 'done')
        ) {
          complete = false
          continue
        }
        if (move.moverJobId === null) {
          if (!job.cancelRequested) complete = false
          continue
        }
        const status = await this.moveStatus(move)
        if (status === null) {
          if (job.cancelRequested) {
            // The addon restarted after cancellation. Do not resurrect a
            // copy-if-absent mover that could delete source bytes while the
            // coordinator is winding down.
            move.state = 'cancelled'
            continue
          }
          // Addons store mover progress in RAM. After their restart, start the
          // exact same resilient move again; copies already verified are adopted.
          move.moverJobId = await this.startMove(job, move)
          move.state = 'running'
          await this.persist(job)
          complete = false
          continue
        }
        move.state = status.state
        move.error = status.error
        // The counters ride the poll that is already happening. This is the
        // ONLY place a migration's progress becomes visible: there is no
        // progress event, on purpose — events are telemetry and may be dropped
        // (D8/D11), and a dropped one looks exactly like a stalled mover.
        move.progress = {
          filesMoved: status.filesMoved,
          filesTotal: status.filesTotal,
          bytesMoved: status.bytesMoved,
          // Carried, never defaulted to 0: a lane that cannot reconcile has no
          // answer here, and "none needed" and "not asked" are different facts.
          ...(status.rowsReconciled === undefined ? {} : { rowsReconciled: status.rowsReconciled }),
          startedAt: status.startedAt,
          observedAt: this.deps.now(),
        }
        if (status.state === 'failed')
          throw new Error(move.error ?? `${move.storageClass} move failed`)
        if (status.state === 'cancelled') {
          job.cancelRequested = true
          continue
        }
        if (status.state !== 'done') complete = false
      }
      await this.persist(job)
      if (complete) return
      await sleep(pollMs)
    }
  }

  /**
   * Nail every unstamped `eventMedia`/retrain row to the location its bytes are
   * ALREADY on, before anything repoints. Runs with every writer up — it moves
   * no bytes at all.
   *
   * The gate is the RE-COUNT, not the seal job's terminal state: a seal that
   * failed some rows still finishes, and "finished" is not "there are none
   * left". A remaining row here fails the job while nothing has been paused
   * and nothing has been repointed, which is the cheapest possible place to
   * discover it. So does a re-count that could not be TAKEN: the gate opens on
   * a measured absence, and only on that.
   *
   * The seal's own mover job id is deliberately NOT durable. It is idempotent
   * and cheap, so a coordinator restart mid-seal simply re-runs the whole
   * phase — and the count that follows is what actually decides, so a lost job
   * id cannot make the gate pass.
   */
  private async sealEventMedia(job: StorageMigrationJob): Promise<void> {
    const move = job.moves.find((candidate) => candidate.storageClass === 'eventMedia')
    if (move === undefined) return
    const before = await this.deps.participants.analytics.countUnstamped()
    // Unknown runs the seal. It is idempotent, moves no bytes, and the re-count
    // below is what decides — skipping it because the pre-count failed would
    // turn a bad read into a skipped safety pass.
    if (before === null || before.anyPresent) {
      // Stamp them with the location they are on TODAY — the source — not the
      // destination. These rows have not moved; the seal only stops them
      // meaning "wherever eventMedia points now".
      const started = await this.deps.participants.analytics.startDrain({
        toLocationId: move.fromLocationId,
        mode: 'seal',
      })
      await this.waitForSeal(job, started.jobId)
      if (job.cancelRequested) return
    }
    const after = await this.deps.participants.analytics.countUnstamped()
    if (after === null) {
      throw new Error(
        'event-media seal ran, but whether any row still carries no locationId could not be ' +
          'measured afterwards. Unknown is not zero; nothing has been paused or repointed.',
      )
    }
    if (after.anyPresent) {
      throw new Error(
        `event-media seal left ${after.total === null ? 'an unknown number of' : after.total.toString()} row(s) without a locationId ` +
          `(${describeUnstamped(after.media)} media, ${describeUnstamped(after.retrainFrames)} retrain frames). ` +
          `A non-blocking cutover would silently orphan them; nothing has been paused or repointed.`,
      )
    }
  }

  private async waitForSeal(job: StorageMigrationJob, moverJobId: string): Promise<void> {
    const sleep =
      this.deps.sleep ??
      ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
    const pollMs = this.deps.pollMs ?? 250
    for (;;) {
      if (job.cancelRequested) {
        await this.deps.participants.analytics.cancelMove(moverJobId)
        return
      }
      const status = await this.deps.participants.analytics.getMove(moverJobId)
      // A seal job the addon has forgotten (its restart) is not an error: the
      // re-count below decides, and it is the only thing that can.
      if (status === null || status.state === 'done' || status.state === 'cancelled') return
      if (status.state === 'failed') {
        throw new Error(status.error ?? 'event-media seal failed')
      }
      await sleep(pollMs)
    }
  }

  private async verifyMoves(job: StorageMigrationJob): Promise<void> {
    for (const move of job.moves) {
      if (move.state !== 'done') {
        throw new Error(`${move.storageClass} move did not complete verification`)
      }
    }
  }

  /**
   * After a from→to copy whose source was NOT a write target: stop new writes
   * to `from`. The rest of the write set is unchanged (that is the whole point
   * of naming a source outside it). A location that is already disabled is
   * left alone.
   */
  private freezeDrainedSources(job: StorageMigrationJob): void {
    for (const move of job.moves) {
      if (move.freezeSource !== true) continue
      const loc = this.deps.locations.getLocationById(move.fromLocationId)
      if (!loc || !mayWriteToLocation(loc)) continue
      const { createdAt: _c, updatedAt: _u, capacity: _cap, ...rest } = loc
      // Frozen = READ-ONLY, never `drain` or `disabled`: a drained source keeps
      // serving what is still on it, and freezing it must not start a second
      // erasure or hide the footage (D385).
      this.deps.locations.upsertLocation(withLocationMode(rest, 'readonly'))
    }
  }

  /**
   * Arm one class's mover.
   *
   * `draining` runs after every writer has been resumed, so there is no lease
   * left to present — it goes through the participants' UNLEASED entry points
   * (`recording.relocateFootage` / `pipelineAnalytics.relocateMedia`), which
   * are the same engines, not a second mover.
   */
  private async startMove(job: StorageMigrationJob, move: StorageMigrationMove): Promise<string> {
    const unleased = runsUnleased(job)
    if (laneOf(move.storageClass) === 'media') {
      const input: RelocateMediaInput = {
        toLocationId: move.toLocationId,
        fromLocationId: move.fromLocationId,
        throttleMbps: job.throttleMbps,
        mode: 'move',
      }
      const started = unleased
        ? await this.deps.participants.analytics.startDrain(input)
        : await this.deps.participants.analytics.startMove({
            ...input,
            leaseId: requireLease(job),
          })
      return started.jobId
    }
    const input: RelocateFootageInput = {
      fromLocationId: move.fromLocationId,
      toLocationId: move.toLocationId,
      footageClass: move.storageClass === 'recordingsLow' ? 'recordingsLow' : 'recordings',
      throttleMbps: job.throttleMbps,
    }
    const started = unleased
      ? await this.deps.participants.recorder.startDrain(input)
      : await this.deps.participants.recorder.startMove({
          ...input,
          leaseId: requireLease(job),
        })
    return started.jobId
  }

  private async moveStatus(move: StorageMigrationMove): Promise<RelocateJob | null> {
    if (move.moverJobId === null) return null
    return laneOf(move.storageClass) === 'media'
      ? this.deps.participants.analytics.getMove(move.moverJobId)
      : this.deps.participants.recorder.getMove(move.moverJobId)
  }

  private async cancelMove(move: StorageMigrationMove): Promise<void> {
    if (move.moverJobId === null) return
    if (laneOf(move.storageClass) === 'media') {
      await this.deps.participants.analytics.cancelMove(move.moverJobId)
    } else {
      await this.deps.participants.recorder.cancelMove(move.moverJobId)
    }
  }

  private participant(name: StorageMigrationParticipant): LeaseParticipant {
    return this.deps.participants[name]
  }

  private async setPhase(
    job: StorageMigrationJob,
    phase: StorageMigrationJob['phase'],
  ): Promise<void> {
    job.phase = phase
    if (isTerminal(job)) job.finishedAt = this.deps.now()
    await this.persist(job)
  }

  private async finishCancelled(job: StorageMigrationJob): Promise<void> {
    job.phase = 'cancelled'
    job.finishedAt = this.deps.now()
    await this.releaseAfterTerminal(job)
    await this.persist(job)
  }

  private async persist(job: StorageMigrationJob): Promise<void> {
    job.updatedAt = this.deps.now()
    await this.deps.state.set(job)
    if (!isTerminal(job) || this.deps.history === undefined) return
    const prev = [...((await this.deps.history.get()) ?? [])]
    await this.deps.history.set(
      [job, ...prev.filter((row) => row.jobId !== job.jobId)].slice(0, HISTORY_CAP),
    )
  }
}

/**
 * A residue read that FAILED is unanswerable, not zero — and it must not take
 * the other lane down with it.
 *
 * `residue` asks two addons. One of them being mid-restart is an ordinary
 * event, and letting that throw out of the whole call would blank the panel:
 * an operator with 80 GB stranded on a recordings disk would be told nothing,
 * because post-analysis was rebooting. `null` is the same "unknown" the
 * participants themselves return for a read they could not take, so the entry
 * is still LISTED and still labelled unknown — a drain attempted against it
 * then fails loudly with the participant's own message, which is the point.
 */
async function unanswerable<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read
  } catch {
    return null
  }
}

function requireLease(job: StorageMigrationJob): string {
  if (job.pauseLeaseId === null) throw new Error('storage migration has no maintenance lease')
  return job.pauseLeaseId
}

function isTerminal(job: StorageMigrationJob): boolean {
  return job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled'
}

const HISTORY_CAP = 20

/**
 * Which single-flight engine owns a class.
 */
function laneOf(storageClass: StorageMigrationClass): StorageMigrationLane {
  return storageClass === 'eventMedia' ? 'media' : 'footage'
}

/**
 * The enrolled gallery is the analytics addon's data dir, not a storage class
 * an operator migrates. A leftover destination from an older client is refused
 * rather than silently dropped.
 */
function refuseRetiredGalleryClass(destinations: StorageMigrationInput['destinations']): void {
  if (destinations.galleryMedia === undefined) return
  throw new Error(
    'galleryMedia is no longer a storage class. Enrolled gallery lives in the ' +
      'pipeline-analytics addon data directory, not a location the operator places.',
  )
}

/**
 * True when this phase runs with every writer already back up, so no
 * maintenance lease exists to present to a participant.
 *
 * `verifying` is in both camps: it precedes the repoint (paused) under
 * `blocking` and follows the drain (running) under `nonBlocking`.
 */
function runsUnleased(job: StorageMigrationJob): boolean {
  if (job.phase === 'sealing' || job.phase === 'draining') return true
  return job.phase === 'verifying' && job.mode === 'nonBlocking'
}
