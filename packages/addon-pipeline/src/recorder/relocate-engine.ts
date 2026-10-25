/**
 * Footage relocation engine (entity-routing spec, Phase 4) — the mover half
 * of disk decommissioning: mark the old location read-only (Phase 2), then
 * relocate its footage here, then delete the location.
 *
 * Mechanics, per HOUR (D291): throttled copy + size-verify of every file in the
 * hour → re-point the DURABLE hour row → delete the sources → re-point the RAM
 * index. The hour is the batch because the durable index is hour-granular, and
 * the sources outlive the durable write on purpose: between the copy and the
 * delete both locations hold the hour, so no crash can leave the index naming a
 * location without the bytes. The copy is `copy-if-absent` (an equal-size
 * destination is adopted, not re-copied), so cancel/crash/re-run RESUMES
 * instead of restarting, and a cancel inside an hour leaves that hour WHOLLY
 * readable at the source. Throttling is file-level pacing (segments are
 * ~1–8 MB / ~4 s, so per-file granularity bounds the rate tightly enough) —
 * the drain is a background chore that must never starve live writers.
 *
 * Runs INSIDE the recorder process — container uid, same-uid files, no host
 * chown trap (see docs/history 2026-07-29).
 *
 * ── Phase 2 (D116, multi-location) ────────────────────────────────────────
 * Two additions the OPERATOR-ARMED rebalance needs:
 *
 *   - A move is scoped to one CAMERA (and optionally to specific profiles),
 *     not just to a whole disk. The rebalance's unit is a (camera, profile)
 *     pile, because that is the unit the placement plan assigns.
 *   - Concurrent starts QUEUE instead of being refused. The engine is still
 *     single-flight — two movers on one disk thrash both — but a rebalance
 *     enqueues one job per pile, and refusing the second turned a
 *     fifteen-camera rebalance into fifteen manual retries. Jobs run FIFO; a
 *     job cancelled while queued never runs, and a job that FAILS does not
 *     strand the queue behind it.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  IScopedLogger,
  RelocateFootageClass,
  RelocateFootageInput,
  RelocateJob,
} from '@camstack/types'
import { physicalRootKey } from './addon/eviction-domain.js'
import type { RecordingsLocation } from './addon/roots.js'
import { locationMayBeWritten, locationMode } from './addon/roots.js'
import type { RecordingIndex } from './recording-index.js'
import { segmentRelPath } from './segment-path.js'
import type { ArchiveScope, FootageArchive, RelocatedSegment, SegmentRow } from './types.js'

const DEFAULT_THROTTLE_MBPS = 40
/** The durable index's bucket, and therefore this mover's batch. */
const HOUR_MS = 3_600_000
/** Progress callback cadence (files) — cheap enough to fire often. */
const PROGRESS_EVERY_FILES = 25
/** Free space a destination must keep when it declares no `config.minFreePercent`
 *  — the same default `roots.ts` documents for placement. */
const DEFAULT_MIN_FREE_PERCENT = 10
/** Prefix every destination-full error carries, so the coordinator can report
 *  "drain stalled: destination full" instead of a raw ENOSPC string. */
export const DESTINATION_FULL_PREFIX = 'destination full'
/**
 * Ghost rows one job may FORGET, as a share of its own census — and the floor
 * below which the share is not the bound.
 *
 * D148 is why this is bounded at all: the ledger forgets only on a trusted walk
 * or an eviction, so that a transient read error cannot erase an operator's
 * index of real footage. A per-path ENOENT on a path derived from the row is
 * strong evidence about THAT path (D296) and weak evidence about a mount: a
 * root that vanished answers ENOENT for every path it is asked about, and looks
 * exactly like a location that is genuinely empty. The bound is what makes the
 * difference survivable — past it the mover keeps moving, keeps skipping, and
 * REPORTS, so an operator gets a reconcile to act on instead of an archive that
 * quietly emptied itself.
 *
 * 17.5 % of `recordingsLow:default` was ghosts on 2026-08-30 (11 074 of
 * 63 346), so a quarter admits a real reconcile of that size in one pass while
 * refusing a whole-location erase.
 */
export const GHOST_FORGET_SHARE = 0.25
/** Small archives: a share of 12 rows is not a bound, it is a rounding error. */
export const GHOST_FORGET_FLOOR = 64

/**
 * The durable half of the index, as this engine needs it.
 *
 * Structural rather than `SegmentHourLedger` itself, so the engine keeps
 * knowing nothing about SQLite or the settings store — and so a test can watch
 * exactly WHEN the durable write lands relative to the source delete, which is
 * the half of D291's ordering this engine owns.
 */
export interface RelocateHourLedger extends FootageArchive {
  /**
   * Move these segments' bytes and counts from the hour they are accounted
   * under today to the same hour at `toLocationId`.
   *
   * It cannot refuse. Until D523 it could: the durable row carried a `paths`
   * column, appending to a row whose paths had not been read would have
   * rewritten the hour as the arriving paths alone, and a failed point read was
   * therefore a reason to keep the source bytes where they were. A row is ten
   * scalars now, the mirror always holds it, and the move is arithmetic.
   */
  readonly repointSegments: (
    rows: readonly RelocatedSegment[],
    toLocationId: string,
  ) => Promise<void>
  /**
   * Take rows whose file this mover CONFIRMED absent out of their hour's
   * account, per path.
   *
   * The same durable forget eviction uses, deliberately. Without this the
   * ENOENT branch re-pointed only RAM and the durable row survived every
   * restart — 11 074 of them on the live hub, re-walked and re-failed by every
   * subsequent drain.
   */
  readonly dropSegments: (rows: readonly SegmentRow[]) => Promise<void>
}

export interface RelocateEngineDeps {
  readonly index: RecordingIndex
  readonly locations: () => readonly RecordingsLocation[]
  /**
   * The durable hour ledger. ABSENT means this node has none (a non-recording
   * node, or a boot that could not declare the collection) — the mover then
   * re-points RAM only, exactly as it always did, and SAYS so per job.
   */
  readonly ledger?: () => RelocateHourLedger | null
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly newId: () => string
  /** Fired on completion (any terminal state) — the durable ops-log hook. */
  readonly onFinished?: (job: RelocateJob) => void
  /** Fired periodically while running (progress telemetry). */
  readonly onProgress?: (job: RelocateJob) => void
  /** Injectable sleep for tests. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Free space on the volume behind a root, as a percentage — injectable so a
   * test can pin the full-destination refusal without a real disk. `null` means
   * the question could not be ANSWERED (unstattable root, exotic filesystem),
   * which is not the same as "no room": see {@link RelocateEngine.headroomRefusal}.
   */
  readonly freePercentOf?: (root: string) => Promise<number | null>
  /**
   * Hard cap on ghost rows one job may forget. Absent ⇒ derived from the job's
   * own census (see {@link GHOST_FORGET_SHARE}); a job with NO census forgets
   * nothing, because a coverage it cannot state is not a coverage it may delete
   * on (D295).
   */
  readonly ghostForgetBudget?: number
}

interface MutableJob {
  jobId: string
  state: RelocateJob['state']
  fromLocationId: string
  toLocationId: string
  deviceId: number | null
  /** Segment profiles this job moves; empty = every profile. */
  profiles: readonly string[]
  footageClass: RelocateFootageClass | undefined
  /** Inclusive lower bound on segment startMs; null = no time filter. */
  sinceMs: number | null
  throttleMbps: number
  entities: string[]
  filesMoved: number
  bytesMoved: number
  filesTotal: number | null
  /** Rows whose recorded size disagreed with the file and were re-stamped. */
  rowsReconciled: number
  /** Ghost rows this job forgot durably — the file was confirmed absent. */
  rowsForgotten: number
  /** Ghost rows it left in the ledger because the budget was spent. */
  ghostsKept: number
  /** The budget refusal is announced ONCE per job, not once per hour. */
  budgetAnnounced: boolean
  startedAt: number
  finishedAt: number | null
  error: string | null
  cancelRequested: boolean
}

function snapshot(j: MutableJob): RelocateJob {
  return {
    jobId: j.jobId,
    state: j.state,
    fromLocationId: j.fromLocationId,
    toLocationId: j.toLocationId,
    deviceId: j.deviceId,
    entities: [...j.entities],
    filesMoved: j.filesMoved,
    bytesMoved: j.bytesMoved,
    filesTotal: j.filesTotal,
    rowsReconciled: j.rowsReconciled,
    rowsForgotten: j.rowsForgotten,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
  }
}

/**
 * The row's source file is not on disk.
 *
 * Carries `code: 'ENOENT'` because that is how every caller here already tells
 * a ghost row from a real failure, and {@link copyVerified} now discovers the
 * absence with a `stat` rather than by letting `copyFile` raise it.
 */
export class RelocateSourceMissingError extends Error {
  readonly code = 'ENOENT'
  constructor(src: string) {
    super(`relocate source missing: ${src}`)
    this.name = 'RelocateSourceMissingError'
  }
}

/** What one {@link copyVerified} did, and what it measured while doing it. */
export interface CopyVerifiedResult {
  /** Bytes copied — 0 when the destination already held a complete copy. */
  readonly copied: number
  /** The SOURCE's own size on disk. The caller compares this against what the
   *  index REMEMBERS; a disagreement is a fact about the row, not the copy. */
  readonly srcBytes: number
}

/**
 * One file's COPY: copy-if-absent → verify the destination against the SOURCE'S
 * OWN SIZE. The source is left in place.
 *
 * Split out of {@link moveFile} because the durable index re-point has to
 * happen while BOTH locations still hold the bytes — see
 * `SegmentHourLedger.repointSegments`.
 *
 * **`recordedBytes` is never the verify's reference.** It used to be, and it
 * cannot be: `fs.copyFile` truncates and replaces, so the destination always
 * equals the source, and comparing that result against a number the LEDGER
 * remembers can only ever fail when the ledger is wrong. On 2026-08-30 that
 * reported a byte-perfect copy as corruption and killed a 110 749-file drain
 * on its 12 440th file:
 *
 *     relocate verify failed: …/1787926410000-9966-274432.m4s
 *       is 783801B, expected 274432B
 *
 * Both files measured 783801 B on the hub. What is faithful is "the
 * destination equals the source", and that is what is asserted here; the
 * recorded number survives only as the reference for a destination whose
 * source is already GONE, where there is nothing else left to compare against.
 */
export async function copyVerified(
  src: string,
  dst: string,
  recordedBytes: number,
): Promise<CopyVerifiedResult> {
  const dstBytes = await fileSize(dst)
  const srcBytes = await fileSize(src)
  // Copy-if-absent: an already-complete destination is adopted, never
  // re-copied, which is what makes cancel/crash/re-run RESUME. Matched against
  // the source when there is one — matching it against the recorded size is
  // what made the failure above PERMANENT, because a restart re-copied the
  // same file and re-failed on it forever.
  if (dstBytes !== null && dstBytes === (srcBytes ?? recordedBytes)) {
    return { copied: 0, srcBytes: dstBytes }
  }
  if (srcBytes === null) throw new RelocateSourceMissingError(src)
  await fs.mkdir(path.dirname(dst), { recursive: true })
  await fs.copyFile(src, dst)
  const after = await fs.stat(dst)
  if (after.size !== srcBytes) {
    throw new Error(`relocate verify failed: ${dst} is ${after.size}B, expected ${srcBytes}B`)
  }
  return { copied: srcBytes, srcBytes }
}

/** One file's move: copy-if-absent → verify size → delete source. Returns the
 *  bytes that MOVED (0 when the destination was already complete). */
export async function moveFile(src: string, dst: string, recordedBytes: number): Promise<number> {
  const { copied } = await copyVerified(src, dst, recordedBytes)
  await fs.rm(src, { force: true })
  return copied
}

/** A file's size, or `null` when it is not there. */
async function fileSize(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return null
  }
}

export class RelocateEngine {
  private readonly jobs = new Map<string, MutableJob>()
  /** Job ids waiting for the mover, in enqueue order. */
  private readonly queue: string[] = []
  /** Set while a job is executing — the single-flight latch. */
  private draining = false

  constructor(private readonly deps: RelocateEngineDeps) {}

  list(): readonly RelocateJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(snapshot)
  }

  /**
   * Cancel a running OR queued job. A running job stops after its current
   * file; a queued job is terminated where it stands and never runs — which is
   * why this returns true for both, and why the cancelled job still gets its
   * `onFinished` audit row.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (job.state === 'running') {
      job.cancelRequested = true
      return true
    }
    if (job.state !== 'queued') return false
    job.cancelRequested = true
    job.state = 'cancelled'
    job.finishedAt = this.deps.now()
    const at = this.queue.indexOf(jobId)
    if (at >= 0) this.queue.splice(at, 1)
    this.deps.onFinished?.(snapshot(job))
    return true
  }

  /**
   * Enqueue a relocation and return its job id. Throws only on an input the
   * mover could never satisfy (unknown/identical/read-only locations) —
   * validated SYNCHRONOUSLY so a caller arming a rebalance learns about a bad
   * target before any job runs.
   *
   * Concurrency: the returned job may be `queued` rather than `running`. The
   * engine still moves one job at a time.
   */
  start(input: RelocateFootageInput): string {
    const locs = this.deps.locations()
    const from = locs.find((l) => l.id === input.fromLocationId)
    const to = locs.find((l) => l.id === input.toLocationId)
    if (!from) throw new Error(`unknown source location: ${input.fromLocationId}`)
    if (!to) throw new Error(`unknown target location: ${input.toLocationId}`)
    if (from.id === to.id) throw new Error('source and target locations are identical')
    // THE destination refusal (D385): a relocate may only land where the
    // system may WRITE. `readonly`, `drain` and `disabled` are all refused,
    // and they are refused the same way — before D385 a `config.readOnly`
    // target threw while an `enabled: false` one was waved through with a
    // warning, which is two answers to one question.
    if (!locationMayBeWritten(to)) {
      throw new Error(`target location is read-only (mode: ${locationMode(to)}): ${to.id}`)
    }

    const job: MutableJob = {
      jobId: this.deps.newId(),
      state: 'queued',
      fromLocationId: from.id,
      toLocationId: to.id,
      deviceId: input.deviceId ?? null,
      profiles: input.profiles ? [...input.profiles] : [],
      footageClass: input.footageClass,
      sinceMs: input.sinceMs ?? null,
      throttleMbps: input.throttleMbps ?? DEFAULT_THROTTLE_MBPS,
      entities: input.entities ? [...input.entities] : ['segments'],
      filesMoved: 0,
      bytesMoved: 0,
      filesTotal: null,
      rowsReconciled: 0,
      rowsForgotten: 0,
      ghostsKept: 0,
      budgetAnnounced: false,
      startedAt: this.deps.now(),
      finishedAt: null,
      error: null,
      cancelRequested: false,
    }
    this.jobs.set(job.jobId, job)
    this.queue.push(job.jobId)
    void this.drain()
    return job.jobId
  }

  /**
   * Run queued jobs one at a time, in enqueue order. Re-entrant by design: the
   * `draining` latch is the single-flight guarantee, and every terminal state
   * (including `failed`) falls through to the next job — a queue stranded
   * behind one bad camera is the failure mode FIFO exists to avoid.
   */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const jobId = this.queue.shift()
        if (jobId === undefined) return
        const job = this.jobs.get(jobId)
        // Cancelled while queued: already terminal, already audited.
        if (!job || job.state !== 'queued') continue
        const locs = this.deps.locations()
        const from = locs.find((l) => l.id === job.fromLocationId)
        const to = locs.find((l) => l.id === job.toLocationId)
        if (!from || !to) {
          // The location set changed under a queued job. Fail it LOUDLY rather
          // than moving bytes somewhere nobody asked for.
          job.state = 'failed'
          job.error = `location disappeared while queued: ${job.fromLocationId} → ${job.toLocationId}`
          job.finishedAt = this.deps.now()
          this.deps.logger.warn('relocate job failed', {
            ...(job.deviceId !== null ? { tags: { deviceId: job.deviceId } } : {}),
            meta: { jobId: job.jobId, error: job.error },
          })
          this.deps.onFinished?.(snapshot(job))
          continue
        }
        job.state = 'running'
        job.startedAt = this.deps.now()
        await this.run(job, from, to)
      }
    } finally {
      this.draining = false
    }
  }

  private async run(
    job: MutableJob,
    from: RecordingsLocation,
    to: RecordingsLocation,
  ): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const bytesPerMs = (job.throttleMbps * 1024 * 1024) / 1000
    try {
      const samePhysicalRoot = await rootsPhysicallySame(from.root, to.root)
      // Ask the cheap question first, before a single byte is read: a drain
      // that starts on a destination which is already past its floor only
      // discovers that as an ENOSPC somewhere in the middle. That failure is
      // SAFE (D291 orders the copy before the durable re-point, so nothing is
      // lost) but it is not graceful, and it leaves the operator with a raw
      // errno instead of "the disk you chose is full".
      const upFront = await this.headroomRefusal(job, to, samePhysicalRoot)
      if (upFront !== null) throw new Error(upFront)
      // The work list is the ARCHIVE's, not the RAM index's (D295).
      //
      // It used to be `index.segmentsOnLocation(from.id)`. Since D287 that
      // index holds the live tail plus whatever an operator happened to look
      // at, so on 2026-08-29 a drain of `recordingsLow:default` was handed a
      // short list, moved it, and reported `done` over 145 664 segments /
      // 80.3 GB it had never been told about. The ledger is the authority for
      // what EXISTS, and it is read one bounded page at a time — the
      // whole-collection fetch is the mistake D287 removed and must not come
      // back here.
      const archive = this.deps.ledger?.() ?? null
      const scope = scopeOf(job, from.id)
      const seenPaths = new Set<string>()
      if (job.entities.includes('segments') && scope !== null) {
        // `sinceMs` is a SEGMENT bound and the census is hour-granular, so a
        // windowed move has no honest M — `null` says that, and a number that
        // over-counts by up to an hour would not.
        job.filesTotal =
          archive === null || job.sinceMs !== null
            ? null
            : ((await archive.census(scope))?.segments ?? null)
        // HOUR-BATCHED, because the durable index is hour-granular: an hour's
        // files are all copied and verified first, the hour is re-pointed in
        // the ledger second, and only then are the source bytes deleted. A
        // cancel or a crash inside an hour therefore leaves that hour WHOLLY
        // at the source (plus adoptable copies at the target), never
        // half-described. A ledger PAGE is already hour-aligned, so grouping
        // inside it is complete for the hours it carries.
        for await (const page of this.workPages(job, scope, archive)) {
          if (job.cancelRequested) break
          for (const [, hourRows] of groupByHour(page)) {
            if (job.cancelRequested) break
            // Re-asked per hour, not only up front: a drain runs for hours
            // beside live writers filling the same destination, and the hour
            // is the unit that can be abandoned whole without leaving
            // anything half-described.
            const refusal = await this.headroomRefusal(job, to, samePhysicalRoot)
            if (refusal !== null) throw new Error(refusal)
            for (const row of hourRows) seenPaths.add(row.path)
            await this.moveHour(job, hourRows, from, to, samePhysicalRoot, sleep, bytesPerMs)
          }
        }
      }
      await this.reportCoverage(job, scope, archive, seenPaths.size)

      async function rootsPhysicallySame(from: string, to: string): Promise<boolean> {
        if (physicalRootKey(from) === physicalRootKey(to)) return true
        try {
          const [a, b] = await Promise.all([fs.stat(from), fs.stat(to)])
          return a.dev === b.dev && a.ino === b.ino
        } catch {
          return false
        }
      }

      job.state = job.cancelRequested ? 'cancelled' : 'done'
    } catch (err) {
      job.state = 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      this.deps.logger.warn('relocate job failed', {
        ...(job.deviceId !== null ? { tags: { deviceId: job.deviceId } } : {}),
        meta: { jobId: job.jobId, error: job.error },
      })
    } finally {
      job.finishedAt = this.deps.now()
      this.deps.onFinished?.(snapshot(job))
    }
  }

  /**
   * The job's work list, oldest-first, one bounded page at a time.
   *
   * With an archive this is the ledger's own stream. WITHOUT one — a node that
   * never declared the collection — it is the RAM index, which since D287
   * answers only about what is RESIDENT. That fallback is kept because a mover
   * that refuses to move is worse than one that moves what it can see, but it
   * is announced: an unannounced partial work list is precisely the defect
   * this method exists to end.
   */
  private async *workPages(
    job: MutableJob,
    scope: ArchiveScope,
    archive: RelocateHourLedger | null,
  ): AsyncGenerator<readonly SegmentRow[]> {
    const inWindow = (row: SegmentRow): boolean =>
      job.sinceMs === null || row.startMs >= job.sinceMs
    if (archive === null) {
      this.deps.logger.warn(
        'relocate: NO durable hour ledger on this node — the work list is what the RAM index holds, which is the live tail plus whatever was viewed, NOT the archive',
        {
          ...(job.deviceId !== null ? { tags: { deviceId: job.deviceId } } : {}),
          meta: { jobId: job.jobId, fromLocationId: job.fromLocationId },
        },
      )
      const profiles = scope.profiles ?? []
      yield this.deps.index
        .segmentsOnLocation(job.fromLocationId)
        .filter((r) => scope.deviceId === undefined || r.deviceId === scope.deviceId)
        .filter((r) => profiles.length === 0 || profiles.includes(r.profile))
        .filter(inWindow)
      return
    }
    for await (const page of archive.streamSegments(scope)) {
      const rows = page.filter(inWindow)
      if (rows.length > 0) yield rows
    }
  }

  /**
   * Say what this job SAW against what the archive says exists — and shout
   * when the two disagree.
   *
   * This class of bug is undetectable by construction: a partial work list
   * produces a job that finishes everything it was given and reports `done`.
   * The 2026-08-29 drain did exactly that over 80.3 GB and logged not one
   * line. So the terminal report is a re-census of the SAME scope: whatever
   * the work list was, whatever refused, whatever went missing, footage still
   * standing on the source after a drain is the one fact that cannot be
   * explained away.
   *
   * A `sinceMs` job is windowed on purpose and leaves the older footage where
   * it is, so it is reported without a shortfall verdict rather than accused
   * of one.
   */
  private async reportCoverage(
    job: MutableJob,
    scope: ArchiveScope | null,
    archive: RelocateHourLedger | null,
    seen: number,
  ): Promise<void> {
    if (scope === null || !job.entities.includes('segments')) return
    const tags = job.deviceId !== null ? { tags: { deviceId: job.deviceId } } : {}
    const base = {
      jobId: job.jobId,
      fromLocationId: job.fromLocationId,
      toLocationId: job.toLocationId,
      archiveSegments: job.filesTotal,
      seen,
      moved: job.filesMoved,
      // Rows this run corrected. Reported on EVERY terminal line, including the
      // happy one: a migration that quietly rewrote durable rows would be a
      // silent mutation, which is the same failure as a silent skip (D295).
      rowsReconciled: job.rowsReconciled,
      // Rows this run dropped because their file was confirmed gone, and rows
      // it left standing because the bound was spent. The second number is the
      // operator's reconcile backlog: it says the ledger is still wrong.
      rowsForgotten: job.rowsForgotten,
      ghostsKept: job.ghostsKept,
    }
    if (archive === null) {
      this.deps.logger.warn(
        'relocate: coverage UNKNOWN — with no durable ledger this node cannot say what the source still holds',
        { ...tags, meta: base },
      )
      return
    }
    const remaining = await archive.census(scope)
    if (remaining === null) {
      this.deps.logger.warn(
        'relocate: coverage UNCONFIRMED — the archive census failed, so "done" here means "the pages it read were moved", not "the source is empty"',
        { ...tags, meta: base },
      )
      return
    }
    if (remaining.segments === 0) {
      this.deps.logger.info(
        'relocate: source scope is empty — every segment the archive knew of moved',
        {
          ...tags,
          meta: { ...base, remainingSegments: 0 },
        },
      )
      return
    }
    const detail = {
      ...base,
      remainingSegments: remaining.segments,
      remainingBytes: remaining.bytes,
    }
    if (job.cancelRequested || job.sinceMs !== null) {
      this.deps.logger.info(
        'relocate: footage deliberately left on the source — this job was windowed or cancelled',
        { ...tags, meta: { ...detail, sinceMs: job.sinceMs, cancelled: job.cancelRequested } },
      )
      return
    }
    this.deps.logger.warn(
      'relocate: the source is NOT empty — this job moved a FRACTION of what the archive holds there and the rest was never touched',
      { ...tags, meta: detail },
    )
  }

  /**
   * Why this drain must not put another hour on `to`, or `null` to proceed.
   *
   * Three deliberate non-refusals:
   *
   *  - **Same physical root.** The move is a re-stamp, not a copy: it consumes
   *    one hour of transient duplication and gives it straight back. Refusing
   *    there would block the one relocation that RELIEVES a full disk.
   *  - **Unknown free space.** `null` is "the question was not answered", not
   *    "there is no room". Refusing on unknown would strand every drain on a
   *    filesystem `statfs` cannot describe, and the fallback — ENOSPC — is
   *    already safe: D291 copies and verifies before any durable re-point, so
   *    a full destination loses nothing. It is logged, because a check that
   *    silently never fires is worse than no check.
   *  - **`maxUsedGb`.** That is a cap on what recordings may OCCUPY, arbitrated
   *    by the eviction sweep against the archive ledger — not free space on a
   *    volume, and not a question a mover can answer with one syscall.
   */
  private async headroomRefusal(
    job: MutableJob,
    to: RecordingsLocation,
    samePhysicalRoot: boolean,
  ): Promise<string | null> {
    if (samePhysicalRoot) return null
    const freePercentOf = this.deps.freePercentOf ?? volumeFreePercent
    const free = await freePercentOf(to.root)
    if (free === null) {
      this.deps.logger.warn(
        'relocate: destination free space is UNREADABLE — draining anyway, a full disk will surface as ENOSPC',
        {
          ...(job.deviceId !== null ? { tags: { deviceId: job.deviceId } } : {}),
          meta: { jobId: job.jobId, toLocationId: to.id, root: to.root },
        },
      )
      return null
    }
    const floor = to.minFreePercent ?? DEFAULT_MIN_FREE_PERCENT
    if (free >= floor) return null
    this.deps.logger.warn('relocate: destination is at its free-space floor — drain stops here', {
      ...(job.deviceId !== null ? { tags: { deviceId: job.deviceId } } : {}),
      meta: {
        jobId: job.jobId,
        toLocationId: to.id,
        freePercent: Math.round(free * 100) / 100,
        minFreePercent: floor,
        filesMoved: job.filesMoved,
      },
    })
    return (
      `${DESTINATION_FULL_PREFIX}: ${to.id} has ${(Math.round(free * 100) / 100).toString()}% free, ` +
      `below its ${floor.toString()}% floor — everything not yet moved is still readable at ${job.fromLocationId}`
    )
  }

  /**
   * The row as the TARGET should record it, given what the source file
   * actually measured.
   *
   * Equal sizes — every ordinary segment — hand the row straight back. A
   * disagreement is reconciled rather than carried over, and reconciling it
   * means RENAMING: a segment's byte count is part of its name
   * (`segmentRelPath`), the durable hour row derives `bytes` from those names
   * (`hourAggregate`), and those sums are what `StorageEvictableProvider` reads
   * when a disk fills. Copying the file under its wrong name would carry the
   * wrong number to the new disk and leave nothing able to correct it — a disk
   * walk re-parses the same name and agrees with itself.
   *
   * The rename happens at the DESTINATION, before the ledger is touched, so a
   * crash here leaves the source wholly authoritative and untouched: the next
   * run re-copies under the old name and re-renames. Nothing is dropped
   * silently — every re-stamp is one `warn` with `tags: { deviceId }` and both
   * numbers, and the count rides the job record to the operator.
   */
  private async reconciled(
    job: MutableJob,
    row: SegmentRow,
    to: RecordingsLocation,
    srcBytes: number,
  ): Promise<RelocatedSegment> {
    if (srcBytes === row.bytes) return row
    const fixed = restampSegmentBytes(row, srcBytes)
    if (fixed === null) {
      this.deps.logger.warn(
        'relocate: the recorded size disagrees with the file, and the path is not a canonical segment name — moved as-is, the durable byte count stays WRONG',
        {
          tags: { deviceId: row.deviceId },
          meta: {
            jobId: job.jobId,
            path: row.path,
            recordedBytes: row.bytes,
            actualBytes: srcBytes,
          },
        },
      )
      return row
    }
    await fs.rename(path.join(to.root, row.path), path.join(to.root, fixed.path))
    job.rowsReconciled += 1
    this.deps.logger.warn(
      'relocate: RECONCILED a row whose recorded size disagreed with the file — the file is the fact, the name and the durable row now say so',
      {
        tags: { deviceId: row.deviceId },
        meta: {
          jobId: job.jobId,
          fromPath: row.path,
          toPath: fixed.path,
          recordedBytes: row.bytes,
          actualBytes: srcBytes,
          deltaBytes: srcBytes - row.bytes,
          toLocationId: to.id,
        },
      },
    )
    return fixed
  }

  /**
   * Forget the rows of one hour whose source file this mover CONFIRMED absent
   * — durably, under a bound, and never in silence.
   *
   * ## Why this observation is trustworthy enough to act on (D148)
   *
   * D148 lets the ledger forget only on a trusted walk or an eviction, so that
   * a fallible read can never delete an operator's index of real footage. This
   * is neither, and it is stronger than the walk it is not: the mover built the
   * absolute path from the ROW's own fields and `stat`ed exactly that path, so
   * the answer is per-path (D296) rather than "a directory listing came back
   * short" — the failure mode the walk-only rule exists to refuse. It is also
   * the same channel eviction already uses: `dropSegments` refuses an hour
   * whose detail it cannot read rather than emptying it, so a failed point read
   * here still changes nothing (D49).
   *
   * ## Why it is nevertheless BOUNDED
   *
   * Because per-path evidence is strong about a path and weak about a MOUNT. A
   * root that has gone away answers ENOENT for everything, and is
   * indistinguishable from a location that is genuinely empty — with the
   * archive as the difference. So the budget caps what one run may erase; past
   * it the mover keeps moving and keeps skipping, and the operator gets a
   * reported reconcile instead of an archive that emptied itself. A job with no
   * census forgets NOTHING: a coverage that cannot be stated is not one to
   * delete on (D295).
   */
  private async forgetGhosts(
    job: MutableJob,
    missing: readonly SegmentRow[],
    from: RecordingsLocation,
  ): Promise<void> {
    if (missing.length === 0) return
    const ledger = this.deps.ledger?.() ?? null
    const budget = this.ghostForgetBudget(job)
    const allowed =
      ledger === null ? 0 : Math.max(0, Math.min(missing.length, budget - job.rowsForgotten))
    if (allowed > 0 && ledger !== null) {
      await ledger.dropSegments(missing.slice(0, allowed))
      job.rowsForgotten += allowed
    }
    // Still one line per file, still `tags: { deviceId }` — a branch that drops
    // work says so, and these 11 074 lines are the only reason the ghost rows
    // were found at all. `forgotten` is what tells the next reader whether the
    // durable row went with the warning.
    missing.forEach((row, i) => {
      this.deps.logger.warn('relocate skipped missing source', {
        tags: { deviceId: row.deviceId },
        meta: {
          jobId: job.jobId,
          path: row.path,
          locationId: from.id,
          forgotten: i < allowed,
        },
      })
    })
    const kept = missing.length - allowed
    if (kept === 0) return
    job.ghostsKept += kept
    if (job.budgetAnnounced) return
    job.budgetAnnounced = true
    this.deps.logger.warn('relocate: ghost-row forget BUDGET reached — the durable rows are KEPT', {
      tags: { deviceId: missing[0]!.deviceId },
      meta: {
        jobId: job.jobId,
        fromLocationId: from.id,
        budget,
        forgotten: job.rowsForgotten,
        stillMissing: kept,
        archiveSegments: job.filesTotal,
        why:
          ledger === null
            ? 'no durable hour ledger on this node — a RAM-only mover may not erase durable rows'
            : 'a root that went away answers ENOENT for everything; past the bound this is reported, not deleted',
      },
    })
  }

  /**
   * How many ghost rows THIS job may forget: the operator/test override, else a
   * share of the census it reported itself against, else nothing.
   */
  private ghostForgetBudget(job: MutableJob): number {
    const override = this.deps.ghostForgetBudget
    if (override !== undefined) return override
    if (job.filesTotal === null) return 0
    return Math.max(GHOST_FORGET_FLOOR, Math.ceil(job.filesTotal * GHOST_FORGET_SHARE))
  }

  /**
   * Move ONE hour of one (device, profile): copy+verify every file, re-point
   * the durable hour row, delete the sources, re-point the RAM index.
   *
   * The order is the whole point. Between the copy and the delete both
   * locations hold every byte, so the ledger re-point in the middle can only
   * ever account for a location that HAS the files — which is what makes a
   * crash recoverable instead of a black window.
   *
   * There is no ledger refusal to handle any more (D523): the durable half is
   * arithmetic over a row the mirror already holds, so nothing on that path can
   * fail and stop an hour dead.
   */
  private async moveHour(
    job: MutableJob,
    rows: readonly SegmentRow[],
    from: RecordingsLocation,
    to: RecordingsLocation,
    samePhysicalRoot: boolean,
    sleep: (ms: number) => Promise<void>,
    bytesPerMs: number,
  ): Promise<void> {
    const movable: RelocatedSegment[] = []
    /** Rows of this hour whose source file the mover CONFIRMED absent. */
    const missing: SegmentRow[] = []
    let copiedBytes = 0
    if (samePhysicalRoot) {
      // A same-root move is a pure row re-stamp: no file is opened, so nothing
      // here can measure one. It therefore cannot reconcile a row either, and
      // deliberately does not try — a `stat` per file would turn the one
      // relocation that costs no I/O into a full archive walk. Such a row is
      // reconciled by the first move that actually copies it.
      movable.push(...rows)
    } else {
      for (const row of rows) {
        if (job.cancelRequested) return
        const src = path.join(from.root, row.path)
        const dst = path.join(to.root, row.path)
        // Paced by what was actually there, not by what the row remembered.
        let pacedBytes = row.bytes
        try {
          const outcome = await copyVerified(src, dst, row.bytes)
          pacedBytes = outcome.srcBytes
          copiedBytes += outcome.copied
          movable.push(await this.reconciled(job, row, to, outcome.srcBytes))
        } catch (err) {
          if (!isEnoent(err)) throw err
          // The source is gone AND the target holds no complete copy — a
          // stranded copy is never reached here, because `copyVerified` adopts
          // an equal-sized destination before it ever touches the source. So
          // this is a genuine ghost (evicted, never flushed, ENOSPC) and
          // dropping the row loses nothing that exists.
          //
          // RAM here, DURABLY below: `storageMigration.residue` reads the
          // ledger, so a row forgotten only in the index survives the restart
          // and the next drain walks to it again. That is the 11 074 rows /
          // 5.65 GB the 2026-08-30 drain reported and could not clear.
          this.deps.index.removeSegments([row.path])
          missing.push(row)
        }
        // Pace to the throttle: sleep the time this file "cost" at the cap.
        await sleep(pacedBytes / bytesPerMs)
      }
    }
    // Before the movable half, and outside it: an hour can be ENTIRELY ghosts —
    // that is the production shape, whole hour rows whose directory no longer
    // exists — and such an hour never reaches the code below.
    await this.forgetGhosts(job, missing, from)
    if (movable.length === 0) return
    if (job.cancelRequested) return

    const ledger = this.deps.ledger?.() ?? null
    if (ledger === null) {
      this.deps.logger.warn(
        'relocate: NO durable hour ledger on this node — the re-point is RAM-only and will not survive a restart',
        {
          tags: { deviceId: movable[0]!.deviceId },
          meta: { jobId: job.jobId, toLocationId: to.id },
        },
      )
    } else {
      await ledger.repointSegments(movable, to.id)
    }

    // The SOURCE is always named by `fromPath`: a reconciled row's `path` is
    // the corrected name, which exists only at the destination.
    if (!samePhysicalRoot) {
      for (const row of movable)
        await fs.rm(path.join(from.root, row.fromPath ?? row.path), { force: true })
    }
    for (const row of movable) {
      this.deps.index.removeSegments([row.fromPath ?? row.path])
      this.deps.index.addSegment({
        deviceId: row.deviceId,
        profile: row.profile,
        startMs: row.startMs,
        durMs: row.durMs,
        bytes: row.bytes,
        path: row.path,
        locationId: to.id,
      })
    }
    job.filesMoved += movable.length
    job.bytesMoved += copiedBytes
    if (job.filesMoved % PROGRESS_EVERY_FILES < movable.length)
      this.deps.onProgress?.(snapshot(job))
  }
}

/**
 * The same segment, recorded at its REAL size — or `null` when this path is not
 * one this repo names, in which case nothing here may rename it.
 *
 * The refusal is a round-trip, not a shape guess: the canonical name for the
 * row's own fields must reproduce `row.path` exactly before the corrected name
 * is trusted. A path that fails it came from somewhere else (a hand-placed
 * file, a future layout), and renaming it would move footage to a name no
 * reader derives.
 */
function restampSegmentBytes(row: SegmentRow, actualBytes: number): RelocatedSegment | null {
  const canonical = segmentRelPath(row.deviceId, row.profile, row.startMs, row.durMs, row.bytes)
  if (canonical !== row.path) return null
  return {
    ...row,
    bytes: actualBytes,
    path: segmentRelPath(row.deviceId, row.profile, row.startMs, row.durMs, actualBytes),
    fromPath: row.path,
  }
}

/**
 * The archive slice this job moves, or `null` when it selects nothing at all.
 *
 * ONE derivation for the census and for the stream. Deriving them separately
 * is how "I saw N of M" ends up comparing two different archives: an M counted
 * over every profile against an N moved for one of them reads as a permanent
 * 66 % shortfall, and a guard nobody believes gets switched off.
 */
function scopeOf(job: MutableJob, fromLocationId: string): ArchiveScope | null {
  return relocateScope({
    fromLocationId,
    footageClass: job.footageClass,
    ...(job.deviceId !== null ? { deviceId: job.deviceId } : {}),
    profiles: job.profiles,
  })
}

/** What a relocation SELECTS, as an archive scope — the input half of
 *  {@link scopeOf}, without a running job. */
export interface RelocateScopeInput {
  readonly fromLocationId: string
  readonly footageClass?: RelocateFootageClass
  readonly deviceId?: number
  readonly profiles?: readonly string[]
}

/**
 * The scope a relocation of this shape would move — and, read on its own, the
 * scope whose census answers "what is still on the source".
 *
 * Exported so `recording.getRelocateResidue` asks about EXACTLY the slice a
 * drain would move. A residue derived from its own filter is how an operator
 * gets offered a drain of footage the drain would then skip, or told a source
 * is empty while a whole profile still sits on it.
 */
export function relocateScope(input: RelocateScopeInput): ArchiveScope | null {
  const given = input.profiles ?? []
  const declared = given.length > 0 ? given : profilesOfClass(input.footageClass)
  const profiles = declared.filter((p) => profileBelongsToClass(p, input.footageClass))
  if (declared.length > 0 && profiles.length === 0) return null
  return {
    locationId: input.fromLocationId,
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(profiles.length > 0 ? { profiles } : {}),
  }
}

/** The segment profiles a footage class owns. Empty = the class was not given,
 *  which means every profile — not "none". */
function profilesOfClass(footageClass: RelocateFootageClass | undefined): readonly string[] {
  if (footageClass === undefined) return []
  return footageClass === 'recordingsLow' ? ['low'] : ['high', 'mid']
}

/**
 * The job's rows bucketed by the hour row that describes them — `(device,
 * profile, hour)`, the durable ledger's own key minus its location half.
 * Insertion order preserves the caller's start-ascending sort, so a drain
 * still empties the oldest footage first.
 */
function groupByHour(rows: readonly SegmentRow[]): ReadonlyMap<string, readonly SegmentRow[]> {
  const out = new Map<string, SegmentRow[]>()
  for (const row of rows) {
    const key = `${row.deviceId}|${row.profile}|${Math.floor(row.startMs / HOUR_MS)}`
    const found = out.get(key)
    if (found) found.push(row)
    else out.set(key, [row])
  }
  return out
}

/** Free space on the volume behind `root`, as a percentage of total blocks.
 *  `null` when the volume cannot be described — never a number that guesses. */
async function volumeFreePercent(root: string): Promise<number | null> {
  try {
    const st = await fs.statfs(root)
    if (st.blocks <= 0) return null
    return (st.bavail / st.blocks) * 100
  } catch {
    return null
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

/** Logical migration classes are profile-derived, never location-derived:
 * high+mid are `recordings`; low is `recordingsLow`. */
export const profileBelongsToClass = (
  profile: string,
  footageClass: RelocateFootageClass | undefined,
): boolean => {
  if (footageClass === undefined) return true
  return footageClass === 'recordingsLow'
    ? profile === 'low'
    : profile === 'high' || profile === 'mid'
}
