import { z } from 'zod'

/**
 * Entity-relocation job state (storage entity-routing spec, Phase 4).
 *
 * One shape shared by the recorder and pipeline-analytics internal movers.
 * The public admin surface is `storage-migration`; child jobs remain in RAM
 * because copy-if-absent, verify, delete and index/row repoint are resumable.
 * Each completed/failed run also lands one durable ops-log row on its owning
 * addon surface.
 */
/**
 * `queued` exists because the recorder mover is SINGLE-FLIGHT and an operator
 * rebalance enqueues one job per (camera, profile). Refusing the second job —
 * what the engine did before — turned a fifteen-camera rebalance into fifteen
 * manual retries. Queued jobs run FIFO; a queued job that is cancelled never
 * runs at all.
 */
export const RelocateJobStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled'])
export type RelocateJobState = z.infer<typeof RelocateJobStateSchema>

export const RelocateJobSchema = z.object({
  jobId: z.string(),
  state: RelocateJobStateSchema,
  /** Source location — for media relocation this is informational ('*': rows
   *  move from wherever they are to the target). */
  fromLocationId: z.string(),
  toLocationId: z.string(),
  /** Scoped device, or null = every device. */
  deviceId: z.number().nullable(),
  /** What the job moves (owner-addon specific: segments or media). */
  entities: z.array(z.string()),
  filesMoved: z.number().int(),
  bytesMoved: z.number().int(),
  /** Total files discovered up front; null while (or when) unknown. */
  filesTotal: z.number().int().nullable(),
  /**
   * Rows this run CORRECTED while moving them — a durable mutation the move
   * made that nobody asked for, so it is reported where the operator reads the
   * job rather than only in a log line.
   *
   * A footage segment records its byte count in its own NAME, and the durable
   * hour row derives its aggregates from those names. A file that does not
   * match its name therefore makes the ledger's sums — and with them quota and
   * pressure eviction — wrong by the difference, and only a rename can fix it.
   * On 2026-08-30 one such row also stalled a 110 749-file drain permanently.
   *
   * Absent on lanes where the question has no meaning: a media blob's size is
   * in its row, not in its name, so `MediaRelocateEngine` never reconciles one.
   */
  rowsReconciled: z.number().int().nonnegative().optional(),
  /**
   * Rows this run FORGOT because the file they name is not on disk.
   *
   * The mover derived the path from the row's own fields and `stat`ed it; an
   * ENOENT there is a per-path confirmation that the segment is gone (D296),
   * and the durable row is dropped through the same channel eviction uses. It
   * is reported for the same reason `rowsReconciled` is: this is a durable
   * mutation nobody asked for, and a migration that quietly erases hour rows is
   * the same failure as one that quietly skips them (D295).
   *
   * The production drain of 2026-08-30 would have reported 11 074 here — the
   * ledger claimed 5.65 GB of footage that no longer existed.
   */
  rowsForgotten: z.number().int().nonnegative().optional(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
})
export type RelocateJob = z.infer<typeof RelocateJobSchema>

/** Profile-derived footage selection used only by the migration coordinator:
 * `recordings` owns high+mid; `recordingsLow` owns low. */
export const RelocateFootageClassSchema = z.enum(['recordings', 'recordingsLow'])
export type RelocateFootageClass = z.infer<typeof RelocateFootageClassSchema>

export const RelocateFootageInputSchema = z.object({
  fromLocationId: z.string(),
  toLocationId: z.string(),
  entities: z.array(z.enum(['segments'])).optional(),
  /** Limits relocation to the logical profile class. Omit only for the
   * pre-orchestration compatibility path. */
  footageClass: RelocateFootageClassSchema.optional(),
  /** Scope the move to ONE camera. Absent = every camera on the source, which
   *  is what a whole-disk drain means. The rebalance path always sets it: its
   *  unit is a (camera, profile) pile, not a disk. */
  deviceId: z.number().int().optional(),
  /** Scope the move to specific segment profiles (`high` / `mid` / `low`).
   *  Finer than `footageClass`, which cannot separate high from mid — and the
   *  placement plan assigns those two independently, so a rebalance that could
   *  only say "recordings" would move footage the plan never asked to move. */
  profiles: z.array(z.string()).optional(),
  /** Copy throttle in MB/s (default 40) — the drain is a background chore,
   *  never allowed to starve live writers. */
  throttleMbps: z.number().min(1).max(1000).optional(),
  /** Move only segments whose startMs is >= this. Absent = the whole source
   *  pile. Used when a full drain is too expensive and the operator only
   *  wants the recent window on the new disk. */
  sinceMs: z.number().int().optional(),
})
export type RelocateFootageInput = z.infer<typeof RelocateFootageInputSchema>

/** Internal, lease-scoped participant operation. It is intentionally separate
 * from persistent recording settings: a migration never changes
 * `RecordingConfig.enabled` or camera wrapper bindings. */
export const StorageMigrationLeaseInputSchema = z.object({ leaseId: z.string().min(1) })
export type StorageMigrationLeaseInput = z.infer<typeof StorageMigrationLeaseInputSchema>

export const StorageMigrationFootageMoveInputSchema = RelocateFootageInputSchema.extend({
  leaseId: z.string().min(1),
})
export type StorageMigrationFootageMoveInput = z.infer<
  typeof StorageMigrationFootageMoveInputSchema
>

/**
 * What a `relocateMedia` pass DOES. One engine, three passes — never a second
 * mover (the engine already walks both collections with a timestamp cursor and
 * already has a stamp-without-copy path).
 *
 *  - `move`    — the default and the historical behaviour: event-media and
 *                retrain blobs move to `toLocationId` and their rows are
 *                stamped. The enrolled gallery is skipped (D197).
 *  - `seal`    — ROWS ONLY, no bytes. Every row whose `locationId` is NULL is
 *                stamped with `toLocationId`. `toLocationId` here is the id the
 *                bytes ALREADY sit on — today's `eventMedia` default — because
 *                a NULL row means "wherever `eventMedia` points *now*", and the
 *                instant a repoint moves that pointer the row reads from the
 *                new disk while its bytes are on the old one.
 *  - `gallery` — the inverse selection of `move`: ONLY the retention-exempt
 *                (enrolled-gallery) rows, which `move` deliberately skips.
 *                `galleryMedia` is `cardinality: 'single'`, so this pass can
 *                never run beside a live second location: it is stop-the-world
 *                by construction, which is acceptable only because the gallery
 *                is a few KB per enrolled sample.
 */
export const MediaRelocateModeSchema = z.enum(['move', 'seal', 'gallery'])
export type MediaRelocateMode = z.infer<typeof MediaRelocateModeSchema>

export const RelocateMediaInputSchema = z.object({
  toLocationId: z.string(),
  /**
   * Restrict the pass to rows currently on this location. Omitted / `'*'` =
   * every row that is not already on `toLocationId` (the historical
   * behaviour). A named source is what a from→to migration needs: without it
   * "move events off disk 2" also emptied disk 1.
   */
  fromLocationId: z.string().optional(),
  throttleMbps: z.number().min(1).max(1000).optional(),
  /** Omitted = `move`, the pre-existing behaviour. */
  mode: MediaRelocateModeSchema.optional(),
})
export type RelocateMediaInput = z.infer<typeof RelocateMediaInputSchema>

/**
 * The unstamped population of ONE collection — split, because the gate and the
 * operator ask two different questions and only one of them has to be cheap.
 *
 * `present` is the GATE: "is there at least one row that would be orphaned by a
 * repoint". It is a single indexed seek to the first matching row, so it stays
 * answerable on a saturated disk and answers in O(log n) precisely in the state
 * that matters — after a seal, when the population is empty.
 *
 * `rows` is the NUMBER, for the refusal message and the operator's sense of
 * scale. It is a second, indexed `COUNT(*)`, and `null` means **not
 * measurable** — never zero. `{ present: true, rows: null }` is a legitimate
 * and useful answer: "there are some, and this read could not say how many"
 * still refuses the cutover, which is the whole job.
 */
export const UnstampedRowsSchema = z.object({
  present: z.boolean(),
  rows: z.number().int().nonnegative().nullable(),
})
export type UnstampedRows = z.infer<typeof UnstampedRowsSchema>

/**
 * How many rows still carry NO `locationId` — the population a repoint would
 * silently re-aim at a disk that does not hold their bytes.
 *
 * **`null` = the count could not be taken**, and it is NOT permission to cut
 * over. The gate opens on a measured absence and on nothing else; an unread
 * collection and an empty one are different facts, and this repo has already
 * paid for conflating them (`RelocateResidueSchema`, D295).
 */
export const UnstampedEventMediaCountSchema = z
  .object({
    media: UnstampedRowsSchema,
    retrainFrames: UnstampedRowsSchema,
    /** True when EITHER collection holds one. The refusal reads this. */
    anyPresent: z.boolean(),
    /** Sum across both, or `null` when either lane could not be counted. */
    total: z.number().int().nonnegative().nullable(),
  })
  .nullable()
export type UnstampedEventMediaCount = z.infer<typeof UnstampedEventMediaCountSchema>
export const StorageMigrationMediaMoveInputSchema = RelocateMediaInputSchema.extend({
  leaseId: z.string().min(1),
})
export type StorageMigrationMediaMoveInput = z.infer<typeof StorageMigrationMediaMoveInputSchema>

/** The independently selectable logical storage classes — every class
 * `storage.listLocationDeclarations` reports, so an operator never meets a
 * Zod enum error where they should meet an explanation.
 *
 * `recordings` encompasses the high and mid segment profiles; `recordingsLow`
 * is low segments; `eventMedia` is post-analysis blobs; `galleryMedia` is the
 * enrolled gallery; `backups` is the system backup archive. The last two have
 * their own rules — see {@link StorageMigrationFindingCodeSchema}. */
export const StorageMigrationClassSchema = z.enum([
  'recordings',
  'recordingsLow',
  'eventMedia',
  'backups',
  'galleryMedia',
])
export type StorageMigrationClass = z.infer<typeof StorageMigrationClassSchema>

/** A destination is always an existing, fully-qualified location id. The
 * migration API intentionally never changes a source location's `basePath`:
 * callers create a new `<type>:<slug>` location, then select it here. */
export const StorageMigrationDestinationsSchema = z
  .object({
    recordings: z.string().min(1).optional(),
    recordingsLow: z.string().min(1).optional(),
    eventMedia: z.string().min(1).optional(),
    backups: z.string().min(1).optional(),
    galleryMedia: z.string().min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'select at least one storage class',
  })
export type StorageMigrationDestinations = z.infer<typeof StorageMigrationDestinationsSchema>

/**
 * Optional named source per class. Omitted = the class's current default
 * (the historical behaviour). A named source that is NOT the default is a
 * drain of that disk: bytes move, the default stays, and the source is
 * disabled when the move finishes.
 */
export const StorageMigrationSourcesSchema = z
  .object({
    recordings: z.string().min(1).optional(),
    recordingsLow: z.string().min(1).optional(),
    eventMedia: z.string().min(1).optional(),
    backups: z.string().min(1).optional(),
    galleryMedia: z.string().min(1).optional(),
  })
  .optional()
export type StorageMigrationSources = z.infer<typeof StorageMigrationSourcesSchema>

/**
 * How a migration sequences the cutover against the byte move.
 *
 *  - `blocking`     — the historical order: pause, move every byte, repoint,
 *                     resume. Recording is stopped for the whole move. Right
 *                     for a small or a cold class, and the only legal mode for
 *                     a `cardinality: 'single'` class.
 *  - `nonBlocking`  — repoint FIRST, drain behind: seal, pause, repoint,
 *                     refresh, resume, then move the past with everything
 *                     running. The pause is three bounded instants (a detach +
 *                     attach round, a write-gate drain, a lease) instead of one
 *                     bounded by bytes. 1.09 TB at 7–14 MB/s is thirty hours of
 *                     stopped recording under `blocking`; the same move is
 *                     seconds of stopped recording under `nonBlocking`.
 *
 * The mode is on the JOB, not only on the input, because `status` is where an
 * operator finds out which one is running.
 */
export const StorageMigrationModeSchema = z.enum(['blocking', 'nonBlocking'])
export type StorageMigrationMode = z.infer<typeof StorageMigrationModeSchema>

/** Shared input for planning and starting an orchestrated storage migration. */
export const StorageMigrationInputSchema = z.object({
  destinations: StorageMigrationDestinationsSchema,
  /** Omitted = each class's current default. */
  sources: StorageMigrationSourcesSchema,
  throttleMbps: z.number().min(1).max(1000).optional(),
  /** Omitted = `blocking`, which stays the default. */
  mode: StorageMigrationModeSchema.optional(),
})
export type StorageMigrationInput = z.infer<typeof StorageMigrationInputSchema>

/**
 * The durable coordinator state machine.
 *
 * `blocking`:
 *   planning → pausing → moving → verifying → repointing → refreshing → resuming → done
 *
 * `nonBlocking`:
 *   planning → sealing → pausing → repointing → refreshing → resuming → draining → verifying → done
 *
 * Same phases, different order plus two new ones — not a second mover.
 * `sealing` closes the `eventMedia` NULL-row hole BEFORE anything is paused;
 * `draining` runs the same movers UNLEASED, after every writer is back up.
 * `repointing` is still the only phase that changes a default location.
 */
export const StorageMigrationPhaseSchema = z.enum([
  'planning',
  'sealing',
  'pausing',
  'moving',
  'draining',
  'verifying',
  'repointing',
  'refreshing',
  'resuming',
  'done',
  'failed',
  'cancelled',
])
export type StorageMigrationPhase = z.infer<typeof StorageMigrationPhaseSchema>

export const StorageMigrationParticipantSchema = z.enum(['pipeline', 'recorder', 'analytics'])
export type StorageMigrationParticipant = z.infer<typeof StorageMigrationParticipantSchema>

/**
 * The mover's own numbers, folded onto the coordinator's durable move record.
 *
 * The long half of a non-blocking migration is `draining`, and it is measured
 * in hours: 136 885 files at ~4 MB/s is about five of them. Before this shape
 * existed the only place those numbers appeared was a Loki line, so an operator
 * watching the Admin UI saw `phase: draining` and nothing else for a whole
 * afternoon.
 *
 * It is POLLED, never pushed. Events are telemetry and may be dropped
 * (D8/D11), and a dropped progress event is indistinguishable from a stalled
 * mover — which is the exact failure this is meant to end. The coordinator's
 * `waitForMoves` already fetches the whole {@link RelocateJob} on every tick to
 * read `state`; folding the counters costs no extra read and makes the durable
 * record say afterwards how far a move actually got.
 *
 * `filesTotal` is `null` for "no honest denominator" and is never zero-filled:
 * a windowed footage job (`sinceMs`) and a node with no ledger both genuinely
 * cannot say M, and a 0 there would render as "100 % done".
 */
export const StorageMigrationMoveProgressSchema = z.object({
  filesMoved: z.number().int().nonnegative(),
  /** The archive census — the **M** of "N of M" (D295). `null` = unknowable. */
  filesTotal: z.number().int().nonnegative().nullable(),
  bytesMoved: z.number().int().nonnegative(),
  /** Rows the mover corrected while moving them — see `RelocateJob`. Absent on
   *  a lane that cannot reconcile. A migration that silently rewrote durable
   *  rows would be the same failure as one that silently skipped them. */
  rowsReconciled: z.number().int().nonnegative().optional(),
  /** The MOVER's start, not the migration's: a drain restarted after an addon
   *  crash gets a new mover, and a rate computed from the migration's start
   *  would silently average in the time nothing was running. */
  startedAt: z.number(),
  /** When the coordinator last read these numbers. Paired with `startedAt` it
   *  is the only honest rate: both clocks are the hub's, so a UI never has to
   *  subtract its own. */
  observedAt: z.number(),
})
export type StorageMigrationMoveProgress = z.infer<typeof StorageMigrationMoveProgressSchema>

export const StorageMigrationMoveSchema = z.object({
  storageClass: StorageMigrationClassSchema,
  fromLocationId: z.string(),
  toLocationId: z.string(),
  /**
   * True when `from` was NOT the class default at plan time. The move still
   * copies bytes, but the default is left alone and the source is disabled
   * once the copy verifies. Absent on jobs planned before this field existed
   * — those jobs always repointed, which is `false`.
   */
  freezeSource: z.boolean().optional(),
  moverJobId: z.string().nullable(),
  state: RelocateJobStateSchema.nullable(),
  error: z.string().nullable(),
  /** Last observed mover counters; `null` until the mover has been polled once. */
  progress: StorageMigrationMoveProgressSchema.nullable(),
})
export type StorageMigrationMove = z.infer<typeof StorageMigrationMoveSchema>

export const StorageMigrationJobSchema = z.object({
  jobId: z.string(),
  phase: StorageMigrationPhaseSchema,
  /** Which order this job is running. `status` is the only place an operator
   *  can tell a seconds-long cutover from a thirty-hour one. */
  mode: StorageMigrationModeSchema,
  destinations: StorageMigrationDestinationsSchema,
  sources: StorageMigrationSourcesSchema,
  throttleMbps: z.number(),
  moves: z.array(StorageMigrationMoveSchema),
  pauseLeaseId: z.string().nullable(),
  pausedParticipants: z.array(StorageMigrationParticipantSchema),
  repointed: z.boolean(),
  cancelRequested: z.boolean(),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
})
export type StorageMigrationJob = z.infer<typeof StorageMigrationJobSchema>

/**
 * What the planner NOTICED but did not refuse.
 *
 * A refusal throws — the operator cannot miss it. A finding is the other half:
 * something true about this plan that changes what the operator should expect,
 * surfaced where they read it rather than in a document they will not open.
 *
 *  - `sharesDeviceWithSource` — the destination realpath's to the same place as
 *    the source. The move will be a row re-stamp, not a byte move, and it buys
 *    no redundancy. NOTE: this is PATH identity, not `st_dev` — two distinct
 *    directories on one filesystem are NOT detected. See
 *    `deviceIdentityUnknown`.
 *  - `deviceIdentityUnknown` — a location carries a `nodeId` other than this
 *    one (or has no `basePath`), so its realpath cannot be taken here and the
 *    same-device question was not answered at all. Stated rather than assumed
 *    clear: a check that silently never fires is worse than no check.
 *  - `unstampedEventMediaRows` — how many `eventMedia`/retrain rows still carry
 *    no `locationId`. Non-zero refuses a `nonBlocking` cutover.
 *  - `blockingOnly` — this class is `cardinality: 'single'`, so it can never
 *    span two locations and can only ever be moved stop-the-world.
 *  - `noMover` — the class is selectable and planned, but no addon owns a mover
 *    for it. The migration cannot move its bytes.
 */
export const StorageMigrationFindingCodeSchema = z.enum([
  'sharesDeviceWithSource',
  'deviceIdentityUnknown',
  'unstampedEventMediaRows',
  'blockingOnly',
  'noMover',
])
export type StorageMigrationFindingCode = z.infer<typeof StorageMigrationFindingCodeSchema>

export const StorageMigrationFindingSchema = z.object({
  code: StorageMigrationFindingCodeSchema,
  storageClass: StorageMigrationClassSchema,
  /** Human-readable, already carrying the ids and counts. */
  message: z.string(),
})
export type StorageMigrationFinding = z.infer<typeof StorageMigrationFindingSchema>

export const StorageMigrationPlanSchema = z.object({
  destinations: StorageMigrationDestinationsSchema,
  sources: StorageMigrationSourcesSchema,
  /** The mode this plan was built for. A plan is only valid for its mode: the
   *  `eventMedia` seal gate and the single-cardinality refusal both depend on
   *  it. */
  mode: StorageMigrationModeSchema,
  moves: z.array(
    z.object({
      storageClass: StorageMigrationClassSchema,
      fromLocationId: z.string(),
      toLocationId: z.string(),
      freezeSource: z.boolean().optional(),
    }),
  ),
  findings: z.array(StorageMigrationFindingSchema),
})
export type StorageMigrationPlan = z.infer<typeof StorageMigrationPlanSchema>

/**
 * Which single-flight engine owns a class of work.
 *
 * Shared rather than re-declared per consumer: the coordinator lanes its moves
 * by it, and `storageMigration.movers` labels a mover with it so an operator
 * can see *which* engine is busy when a drain refuses to start beside another.
 */
export const StorageMigrationLaneSchema = z.enum(['footage', 'media'])
export type StorageMigrationLane = z.infer<typeof StorageMigrationLaneSchema>

/**
 * A mover as it exists RIGHT NOW, whether or not a migration job owns it.
 *
 * The coordinator's job record is the state of record for a migration, and its
 * moves carry {@link StorageMigrationMoveProgress}. But the movers are usable
 * standalone — `recording.relocateFootage` and `pipelineAnalytics.relocateMedia`
 * are both operator-callable, and on 2026-08-29 a five-hour drain was armed that
 * way because no supported UI path existed. A mover armed like that has no job
 * to fold progress into, so it has to be readable on its own or it is invisible.
 *
 * `migrationJobId` is what tells the two apart: `null` means nothing here
 * orchestrated it.
 */
export const StorageMigrationMoverSchema = z.object({
  lane: StorageMigrationLaneSchema,
  job: RelocateJobSchema,
  /** The coordinator job that armed this mover, or `null` for a mover armed
   *  directly against the owning addon. */
  migrationJobId: z.string().nullable(),
  /** When the hub read these counters. Stamped here so a rate is `bytesMoved`
   *  over (`observedAt` − `job.startedAt`) with BOTH ends on the hub's clock —
   *  a browser subtracting its own `Date.now()` from a server `startedAt` is a
   *  rate made of two different clocks. */
  observedAt: z.number(),
})
export type StorageMigrationMover = z.infer<typeof StorageMigrationMoverSchema>

/**
 * What a SOURCE still holds for one storage class — the number that makes a
 * "drain remaining" action honest rather than hopeful.
 *
 * It comes from the archive (`SegmentHourLedger.census` for footage, the media
 * engine's own selection count for media), never from the resident index: a
 * drain sized off `RecordingIndex` is what reported `done` over 80.3 GB it had
 * never been told about (D295).
 *
 * `items`/`bytes` are `null` for "the archive could not be asked", which is
 * deliberately NOT zero: a drain is still offered for an unknown residue,
 * because refusing on an unanswerable read would hide exactly the case an
 * operator needs to act on.
 */
export const StorageMigrationResidueSchema = z.object({
  storageClass: StorageMigrationClassSchema,
  /** The location still holding the data. `'*'` for the media lane, whose rows
   *  move from wherever they are rather than from one named source. */
  fromLocationId: z.string(),
  /** Where a drain would move it — the class's CURRENT default. */
  toLocationId: z.string(),
  /** Segments (footage lane) or rows (media lane) still on the source. */
  items: z.number().int().nonnegative().nullable(),
  /** Bytes on the source; `null` when the lane counts rows rather than bytes. */
  bytes: z.number().int().nonnegative().nullable(),
})
export type StorageMigrationResidue = z.infer<typeof StorageMigrationResidueSchema>

/**
 * Run the DRAIN half and nothing else.
 *
 * A migration that reached `done` has already repointed, so `start` correctly
 * refuses its destination ("already the default") — there is nothing left to
 * repoint. But the drain can fail, be cancelled, be interrupted by a restart,
 * or finish against a work list that was a tenth of the archive (D295), and
 * before this there was no supported way to run only that half: the only way
 * through was calling `recording.relocateFootage` by hand over admin tRPC.
 *
 * `drain` NEVER calls `setDefaultLocations`. That is what keeps `start`'s
 * refusal meaningful: the two verbs are disjoint, so nothing here can silently
 * re-repoint a class that is already migrated.
 */
export const StorageMigrationDrainInputSchema = z.object({
  /** The classes to drain. Each must appear in `storageMigration.residue`, so
   *  a class whose source is already empty is refused rather than started. */
  classes: z.array(StorageMigrationClassSchema).min(1),
  throttleMbps: z.number().min(1).max(1000).optional(),
})
export type StorageMigrationDrainInput = z.infer<typeof StorageMigrationDrainInputSchema>

/** What a footage source still holds, asked of the durable hour ledger. */
export const RelocateResidueInputSchema = z.object({
  fromLocationId: z.string().min(1),
  /** Narrow to one logical class; omit for every profile on the location. */
  footageClass: RelocateFootageClassSchema.optional(),
})
export type RelocateResidueInput = z.infer<typeof RelocateResidueInputSchema>

/** `null` = the archive could not answer (no ledger on this node, or the
 *  aggregate failed). Never conflated with an empty source. */
export const RelocateResidueSchema = z
  .object({
    segments: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .nullable()
export type RelocateResidue = z.infer<typeof RelocateResidueSchema>

/**
 * Ask one location whether its durable hour rows describe the disk — the walk
 * (D319).
 *
 * `apply` DEFAULTS TO FALSE and that default is the product: the operator's
 * missing tool is the question, and the dry run is how they sanity-check the
 * destructive run before authorising it.
 */
export const LedgerWalkInputSchema = z.object({
  locationId: z.string().min(1),
  /** Forget the confirmed-absent rows, rather than only counting them. */
  apply: z.boolean().optional(),
  /** Narrow to one camera. */
  deviceId: z.number().int().positive().optional(),
  /** Narrow to these recording profiles; empty/absent = every profile. */
  profiles: z.array(z.string().min(1)).optional(),
})
export type LedgerWalkInput = z.infer<typeof LedgerWalkInputSchema>

/** Why a whole walk did nothing. Every one leaves the ledger untouched. */
export const LedgerWalkRefusalSchema = z.enum([
  'location-unknown',
  'source-writable',
  'no-ledger',
  'archive-unreadable',
  'anchor-absent',
  'anchor-unreadable',
  'anchor-moved',
])
export type LedgerWalkRefusal = z.infer<typeof LedgerWalkRefusalSchema>

/** Why one hour was left exactly as it was found. */
export const LedgerWalkSkipReasonSchema = z.enum([
  'live-tail',
  'listing-error',
  'path-mismatch',
  'durable-refused',
])
export type LedgerWalkSkipReason = z.infer<typeof LedgerWalkSkipReasonSchema>

/** Every skip reason, always present, always a number — so a reason that never
 *  fired reports as zero rather than absent and the report shape is constant
 *  between passes. Spelled out rather than `z.record` for exactly that. */
export const LedgerWalkSkipCountsSchema = z.object({
  'live-tail': z.number().int().nonnegative(),
  'listing-error': z.number().int().nonnegative(),
  'path-mismatch': z.number().int().nonnegative(),
  'durable-refused': z.number().int().nonnegative(),
})
export type LedgerWalkSkipCounts = z.infer<typeof LedgerWalkSkipCountsSchema>

/** One camera's share of a walk, so a report names cameras and not rows. */
export const LedgerWalkDeviceReportSchema = z.object({
  deviceId: z.number().int(),
  hoursWalked: z.number().int().nonnegative(),
  hoursMissing: z.number().int().nonnegative(),
  ghostSegments: z.number().int().nonnegative(),
  ghostBytes: z.number().int().nonnegative(),
  forgottenSegments: z.number().int().nonnegative(),
  orphanFiles: z.number().int().nonnegative(),
})
export type LedgerWalkDeviceReport = z.infer<typeof LedgerWalkDeviceReportSchema>

/**
 * What one walk claimed, listed, found and (only when armed) forgot.
 *
 * `archiveSegments` is the **M** and `segmentsClaimed` the **N** (D295), so a
 * walk that saw a fraction of the location is visible in its own report rather
 * than in the absence of one.
 */
export const LedgerWalkReportSchema = z.object({
  locationId: z.string(),
  applied: z.boolean(),
  refused: LedgerWalkRefusalSchema.nullable(),
  archiveSegments: z.number().int().nonnegative().nullable(),
  archiveBytes: z.number().int().nonnegative().nullable(),
  hoursClaimed: z.number().int().nonnegative(),
  hoursWalked: z.number().int().nonnegative(),
  hoursMissing: z.number().int().nonnegative(),
  /** `readdir` calls issued — the cost, stated in the unit that is paid. */
  listings: z.number().int().nonnegative(),
  segmentsClaimed: z.number().int().nonnegative(),
  ghostSegments: z.number().int().nonnegative(),
  ghostBytes: z.number().int().nonnegative(),
  ghostHoursWhole: z.number().int().nonnegative(),
  forgottenSegments: z.number().int().nonnegative(),
  forgottenBytes: z.number().int().nonnegative(),
  /** Files under a claimed hour that no durable row names. Never deleted. */
  orphanFiles: z.number().int().nonnegative(),
  orphanSample: z.array(z.string()).readonly(),
  hoursSkipped: z.number().int().nonnegative(),
  skippedByReason: LedgerWalkSkipCountsSchema,
  /** The walk stopped at its per-pass hour bound with claims unwalked. */
  bounded: z.boolean(),
  byDevice: z.array(LedgerWalkDeviceReportSchema).readonly(),
})
export type LedgerWalkReport = z.infer<typeof LedgerWalkReportSchema>

/** How many rows a media pass would still act on against a given target — the
 *  media lane's denominator AND its residue, from ONE derivation so the two can
 *  never disagree. `null` = the count could not be taken. */
export const RelocatableMediaCountSchema = z
  .object({ rows: z.number().int().nonnegative() })
  .nullable()
export type RelocatableMediaCount = z.infer<typeof RelocatableMediaCountSchema>

export const RelocatableMediaCountInputSchema = z.object({
  toLocationId: z.string().min(1),
  /** Restrict the count to one source; omitted / `'*'` = every non-target row. */
  fromLocationId: z.string().optional(),
  /** Omitted = `move`. */
  mode: MediaRelocateModeSchema.optional(),
})
export type RelocatableMediaCountInput = z.infer<typeof RelocatableMediaCountInputSchema>

/**
 * Operator cleanup of leftover analytics rows, optional debug media, and
 * ghost ledger entries on frozen footage locations.
 *
 * A pass is tens of minutes on a standing backlog. The hub method RETURNS
 * `{ jobId }` immediately; progress is `cleanupStatus`. Awaiting the work
 * is how `addons.custom` hit the 60 s UDS deadline while reclaim continued
 * with no operator-visible status.
 */
export const StorageCleanupPhaseSchema = z.enum([
  'orphans',
  'debug-media',
  'ghost-ledger',
  'done',
  'failed',
  'cancelled',
])
export type StorageCleanupPhase = z.infer<typeof StorageCleanupPhaseSchema>

export const StorageCleanupInputSchema = z.object({
  /** Also walk motion stills / track filmstrips. Off by default. */
  includeDebugMedia: z.boolean().optional(),
})
export type StorageCleanupInput = z.infer<typeof StorageCleanupInputSchema>

export const StorageCleanupJobSchema = z.object({
  jobId: z.string(),
  phase: StorageCleanupPhaseSchema,
  includeDebugMedia: z.boolean(),
  orphansReclaimed: z.number().int().nonnegative(),
  orphanBytesReclaimed: z.number().int().nonnegative(),
  debugMediaReclaimed: z.number().int().nonnegative(),
  debugMediaBytesReclaimed: z.number().int().nonnegative(),
  ghostsForgotten: z.number().int().nonnegative(),
  ghostBytesForgotten: z.number().int().nonnegative(),
  /** Short operator-facing line: current collection, pass, or location. */
  detail: z.string().nullable(),
  cancelRequested: z.boolean(),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
})
export type StorageCleanupJob = z.infer<typeof StorageCleanupJobSchema>

export const StorageCleanupStatusInputSchema = z.object({ jobId: z.string().optional() })
export type StorageCleanupStatusInput = z.infer<typeof StorageCleanupStatusInputSchema>

/** The orchestrator's answer to "may a mover touch these locations now?". */
export interface MoverClearanceAnswer {
  readonly clear: boolean
  readonly repointLocationId?: string | undefined
}

export interface MoverStartDeps {
  /** `storageMigration.moverClearance` — the orchestrator owns one claim per physical root. */
  readonly clearance: (locationIds: readonly string[]) => Promise<MoverClearanceAnswer>
  /** Registers and starts the job; returns its id. */
  readonly start: () => string
  readonly cancel: (jobId: string) => void
  /** The locations the job reads or writes (`*` = every eventMedia location). */
  readonly locationIds: readonly string[]
}

/**
 * Start a mover only when no single-location repoint holds an overlapping
 * physical root. Asks BEFORE (cheap refusal, no job) and AFTER registering the
 * job: the repoint announces its claim and then lists movers, so a mover that
 * registers first is seen by it and one that registers second sees the claim —
 * neither side can miss the other (2026-10-20: a repoint and a relocate job
 * moved and deleted the same event media with no lock between them).
 *
 * Fail CLOSED: a clearance that cannot be asked refuses the start.
 */
export async function startMoverUnderClearance(deps: MoverStartDeps): Promise<string> {
  const refuse = (detail: string): never => {
    throw new Error(`mover refused: ${detail}`)
  }
  const ask = async (): Promise<MoverClearanceAnswer> => {
    try {
      return await deps.clearance(deps.locationIds)
    } catch (err: unknown) {
      return refuse(
        `the storage orchestrator could not be asked (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  const blocked = (answer: MoverClearanceAnswer): string =>
    `a re-point of "${answer.repointLocationId ?? 'a location'}" holds an overlapping storage root`
  const before = await ask()
  if (!before.clear) return refuse(blocked(before))
  const jobId = deps.start()
  const after = await ask().catch((err: unknown) => {
    deps.cancel(jobId)
    throw err
  })
  if (!after.clear) {
    deps.cancel(jobId)
    return refuse(blocked(after))
  }
  return jobId
}
