/**
 * One writer per staging directory (D667).
 *
 * A staging directory `.rec-tmp/<deviceId>/<profile>/` is written by exactly
 * one ffmpeg: its `live.m3u8` is a rolling list the watcher tails, and its
 * segments are named after the epoch second they start in. Two writers in one
 * directory rewrite each other's playlist and collide on names.
 *
 * Nothing used to stop a second one. On 2026-09-28 the hub recorder runner
 * died of a V8 OOM (SIGABRT — no JS runs, no shutdown hook). Its 28 ffmpeg
 * writers survived it: ffmpeg ignores SIGPIPE and does not quit on stdin EOF,
 * so losing its parent means nothing to it. The respawned runner spawned 28
 * more into the SAME directories. For 13 minutes every camera had two writers;
 * the new watchers never saw their own entries (1 512 "rolled past … processed
 * = 0"), liveness declared every new writer dead, and the runner churned its
 * own writers 169 times while the orphans kept writing.
 *
 * Three entry points, one reap:
 *
 * - {@link StagingWriterReaper.sweep} with no device — at BOOT, before the
 *   staging recovery and before any writer spawns: every foreign writer under
 *   any staging root, whether or not its camera will be attached again.
 * - {@link StagingWriterReaper.sweep} with a device — at the start of an
 *   attach: every profile of that camera in one table read and one window.
 * - {@link StagingWriterReaper.claim} — right before each spawn, the one
 *   directory the spawn will write. This is the guarantee; the sweeps make it
 *   cheap.
 *
 * A reap is SIGTERM, a bounded wait, SIGKILL, a bounded wait — confirmed by
 * re-reading the table, never assumed. A foreign writer still there afterwards,
 * one the kernel will not let us signal (EPERM), or one whose death cannot be
 * confirmed because the table stopped answering is a REFUSAL: the caller does
 * not spawn. A refused directory is held for {@link REFUSAL_RETRY_MS}: until
 * then a claim refuses at once, without a table read or a signal, and the
 * ERROR is written once per change of state.
 */
import type { IScopedLogger } from '@camstack/types'
import { segmentListPath } from './ffmpeg-args.js'
import type {
  ListedProcess,
  ProcessLister,
  ProcessSignaller,
  SignalOutcome,
} from './process-table.js'
import {
  DEFAULT_EXECUTABLE_MARKER,
  isWriterExecutable,
  SEGMENT_LIST_FLAG,
  stagingTargetOf,
  type WriterTarget,
  writesPlaylist,
} from './staging-writer-match.js'

export { SEGMENT_LIST_FLAG, writesPlaylist, type WriterTarget } from './staging-writer-match.js'

/** How long a SIGTERM'd writer gets to finish its segment and exit. */
export const TERM_GRACE_MS = 2_000
/** How long a SIGKILL'd writer gets to disappear before the spawn is refused. */
export const KILL_GRACE_MS = 1_000
/** A refused directory is not retried sooner than this. */
export const REFUSAL_RETRY_MS = 60_000
/** A table read this recent is good enough for a claim. Foreign writers only
 *  come from a predecessor, which exists before the read — and every signal
 *  this guard sends invalidates the cache. */
export const CLAIM_LIST_MAX_AGE_MS = 1_000
/** Two sightings of one pid whose start times differ by more than this are two
 *  processes: `ps` reports elapsed time in whole seconds. */
const SAME_START_TOLERANCE_MS = 2_000
const POLL_MS = 100

export type StagingGuardLogger = Pick<IScopedLogger, 'debug' | 'info' | 'warn' | 'error'>

export interface StagingWriterGuardDeps {
  readonly lister: ProcessLister
  readonly signaller: ProcessSignaller
  readonly logger: StagingGuardLogger
  /** This process — never a candidate, whatever its argv says. */
  readonly selfPid: number
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  /** What the executable's name must contain. Default `ffmpeg`. */
  readonly executableMarker?: string
  readonly termGraceMs?: number
  readonly killGraceMs?: number
  readonly pollMs?: number
  readonly refusalRetryMs?: number
}

export interface StagingClaim {
  readonly deviceId: number
  readonly profile: string
  /** The location root `outDir` lives under. */
  readonly root: string
  readonly outDir: string
  /** Pids of the writers the caller is tracking — never reaped. */
  readonly ownPids: ReadonlySet<number>
}

export interface StagingSweep {
  readonly roots: readonly string[]
  /** Only this camera's directories; `null` = every directory (boot). */
  readonly deviceId: number | null
  readonly ownPids: ReadonlySet<number>
}

/** A foreign writer this guard removed. */
export interface ReapedWriter {
  readonly target: WriterTarget
  readonly pid: number
  readonly ppid: number | null
  readonly ageMs: number | null
  /** The strongest signal it took. */
  readonly signal: 'SIGTERM' | 'SIGKILL'
  readonly waitedMs: number
}

/**
 * Why a foreign writer was left in place.
 * - `survived`: still there after SIGKILL and its grace (a D-state process).
 * - `denied`: the kernel refused the signal (EPERM); waiting cannot help.
 * - `table-unreadable`: the table stopped answering mid-reap, so its death
 *   could not be confirmed and nothing further was sent to an unverified pid.
 * - `held`: refused less than {@link REFUSAL_RETRY_MS} ago; not retried yet.
 */
export type RefusalReason = 'survived' | 'denied' | 'table-unreadable' | 'held'

export interface RefusedWriter {
  readonly target: WriterTarget
  readonly pid: number
  readonly ppid: number | null
  readonly ageMs: number | null
  readonly reason: RefusalReason
}

export type StagingClaimResult =
  /** Nothing foreign was writing (or everything that was is gone). Spawn. */
  | { readonly outcome: 'clear'; readonly reaped: readonly ReapedWriter[] }
  /** A foreign writer is still there. Do NOT spawn. */
  | { readonly outcome: 'refused'; readonly survivors: readonly RefusedWriter[] }
  /** The table could not be read before anything was found. */
  | { readonly outcome: 'unverified'; readonly error: string }

export type StagingSweepResult =
  | {
      readonly outcome: 'swept'
      readonly reaped: readonly ReapedWriter[]
      readonly refused: readonly RefusedWriter[]
    }
  | { readonly outcome: 'unverified'; readonly error: string }

/**
 * Checks staging directories for writers that are not the caller's.
 *
 * `unverified` is deliberately NOT a refusal: a host whose process table
 * cannot be read at all would otherwise record nothing, a larger loss than the
 * risk it guards against. It is logged every time, so it is never mistaken
 * for "checked and clear". Once a foreign writer HAS been seen, a table that
 * stops answering is a refusal — never a co-write.
 */
export interface StagingWriterGuard {
  claim(request: StagingClaim): Promise<StagingClaimResult>
  sweep(request: StagingSweep): Promise<StagingSweepResult>
}

interface Candidate {
  readonly proc: ListedProcess
  readonly target: WriterTarget
}

/** A directory refused earlier, remembered so the next claim does not repeat it. */
interface RefusalRecord {
  readonly pid: number
  /** `null` when the table gave no age. */
  readonly startedAtMs: number | null
  readonly reason: RefusalReason
  readonly firstMs: number
  readonly lastAttemptMs: number
  readonly attempts: number
}

interface Listing {
  readonly at: number
  readonly rows: readonly ListedProcess[]
}

interface InflightListing {
  readonly startedAt: number
  readonly promise: Promise<Listing>
}

interface ReapOutcome {
  readonly reaped: readonly ReapedWriter[]
  readonly refused: readonly RefusedWriter[]
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ageSec(ageMs: number | null): number | null {
  return ageMs === null ? null : Math.round(ageMs / 1000)
}

export class StagingWriterReaper implements StagingWriterGuard {
  private refusals = new Map<string, RefusalRecord>()
  private cache: Listing | null = null
  private inflight: InflightListing | null = null

  constructor(private readonly deps: StagingWriterGuardDeps) {}

  async claim(request: StagingClaim): Promise<StagingClaimResult> {
    const target: WriterTarget = {
      deviceId: request.deviceId,
      profile: request.profile,
      root: request.root,
      outDir: request.outDir,
    }
    const held = this.heldRecord(request.outDir)
    if (held !== null) {
      const survivor: RefusedWriter = {
        target,
        pid: held.pid,
        ppid: null,
        ageMs: null,
        reason: 'held',
      }
      this.logHeld(survivor, held)
      return { outcome: 'refused', survivors: [survivor] }
    }

    let rows: readonly ListedProcess[]
    try {
      rows = await this.list(this.deps.now() - CLAIM_LIST_MAX_AGE_MS)
    } catch (err: unknown) {
      this.deps.logger.warn(
        'recorder: could not read the process table — spawning a writer WITHOUT checking its staging directory for another writer',
        {
          tags: { deviceId: request.deviceId },
          meta: { profile: request.profile, outDir: request.outDir, error: errMsg(err) },
        },
      )
      return { outcome: 'unverified', error: errMsg(err) }
    }

    const playlist = segmentListPath(request.outDir)
    const candidates: Candidate[] = rows
      .filter(
        (proc) => this.isForeignWriter(proc, request.ownPids) && writesPlaylist(proc, playlist),
      )
      .map((proc) => ({ proc, target }))
    if (candidates.length === 0) {
      this.forgetRefusal(target)
      return { outcome: 'clear', reaped: [] }
    }
    const outcome = await this.reap(candidates)
    if (outcome.refused.length > 0) return { outcome: 'refused', survivors: outcome.refused }
    return { outcome: 'clear', reaped: outcome.reaped }
  }

  async sweep(request: StagingSweep): Promise<StagingSweepResult> {
    const startedMs = this.deps.now()
    const tags = request.deviceId === null ? undefined : { deviceId: request.deviceId }
    let rows: readonly ListedProcess[]
    try {
      rows = await this.list(startedMs)
    } catch (err: unknown) {
      this.deps.logger.warn(
        'recorder: could not read the process table — a previous runner’s writers cannot be swept',
        { ...(tags ? { tags } : {}), meta: { roots: request.roots, error: errMsg(err) } },
      )
      return { outcome: 'unverified', error: errMsg(err) }
    }
    const candidates: Candidate[] = []
    for (const proc of rows) {
      if (!this.isForeignWriter(proc, request.ownPids)) continue
      const target = stagingTargetOf(proc, request.roots)
      if (target === null) continue
      if (request.deviceId !== null && target.deviceId !== request.deviceId) continue
      candidates.push({ proc, target })
    }
    const outcome: ReapOutcome =
      candidates.length === 0 ? { reaped: [], refused: [] } : await this.reap(candidates)
    if (request.deviceId === null) {
      // The boot line, always: "the sweep ran and found nothing" is an answer
      // the next crash investigation needs as much as a reap.
      this.deps.logger.info('recorder: boot sweep for a previous runner’s writers', {
        meta: {
          roots: request.roots,
          found: candidates.length,
          reaped: outcome.reaped.length,
          refused: outcome.refused.length,
          ms: this.deps.now() - startedMs,
        },
      })
    }
    return { outcome: 'swept', reaped: outcome.reaped, refused: outcome.refused }
  }

  private isForeignWriter(proc: ListedProcess, ownPids: ReadonlySet<number>): boolean {
    return (
      proc.pid !== this.deps.selfPid &&
      !ownPids.has(proc.pid) &&
      isWriterExecutable(proc, this.deps.executableMarker ?? DEFAULT_EXECUTABLE_MARKER)
    )
  }

  /**
   * One SIGTERM → SIGKILL window for every candidate at once. Candidates whose
   * directory is held are refused without a signal.
   */
  private async reap(candidates: readonly Candidate[]): Promise<ReapOutcome> {
    const started = this.deps.now()
    const refused: RefusedWriter[] = []
    const active: Candidate[] = []
    for (const candidate of candidates) {
      const held = this.heldRecord(candidate.target.outDir)
      if (held === null) {
        active.push(candidate)
        continue
      }
      const survivor = this.refusedOf(candidate, 'held')
      this.logHeld(survivor, held)
      refused.push(survivor)
    }

    const terminated = this.signalAll(active, 'SIGTERM', refused)
    let signalled: readonly Candidate[] = terminated
    const killed = new Set<number>()
    if (terminated.length > 0) {
      const afterTerm = await this.waitGone(terminated, this.deps.termGraceMs ?? TERM_GRACE_MS)
      if (afterTerm === null) {
        // Nothing confirms they left, and a SIGKILL to a pid nobody re-read is
        // a destructive act on a failed read (D49). Refuse instead.
        for (const candidate of terminated) {
          refused.push(this.refusedOf(candidate, 'table-unreadable'))
        }
        signalled = []
      } else if (afterTerm.length > 0) {
        const toKill = this.signalAll(afterTerm, 'SIGKILL', refused)
        for (const candidate of toKill) killed.add(candidate.proc.pid)
        if (toKill.length > 0) {
          const afterKill = await this.waitGone(toKill, this.deps.killGraceMs ?? KILL_GRACE_MS)
          const reason: RefusalReason = afterKill === null ? 'table-unreadable' : 'survived'
          for (const candidate of afterKill ?? toKill) {
            refused.push(this.refusedOf(candidate, reason))
          }
        }
      }
    }

    const waitedMs = this.deps.now() - started
    const refusedPids = new Set(refused.map((writer) => writer.pid))
    const reaped: ReapedWriter[] = []
    for (const candidate of signalled) {
      if (refusedPids.has(candidate.proc.pid)) continue
      const writer: ReapedWriter = {
        target: candidate.target,
        pid: candidate.proc.pid,
        ppid: candidate.proc.ppid,
        ageMs: candidate.proc.ageMs,
        signal: killed.has(candidate.proc.pid) ? 'SIGKILL' : 'SIGTERM',
        waitedMs,
      }
      reaped.push(writer)
      this.logReaped(writer)
    }
    for (const writer of refused) {
      if (writer.reason !== 'held') this.recordRefusal(writer, waitedMs)
    }
    return { reaped, refused }
  }

  /**
   * Send `signal` to each candidate. A candidate the kernel refuses (EPERM) is
   * refused at once — waiting out a grace for a signal that was never
   * delivered cannot change anything. Returns the ones worth waiting for.
   */
  private signalAll(
    candidates: readonly Candidate[],
    signal: 'SIGTERM' | 'SIGKILL',
    refused: RefusedWriter[],
  ): readonly Candidate[] {
    if (candidates.length === 0) return []
    const pending: Candidate[] = []
    for (const candidate of candidates) {
      const outcome: SignalOutcome = this.deps.signaller.send(candidate.proc.pid, signal)
      if (outcome === 'denied') refused.push(this.refusedOf(candidate, 'denied'))
      else pending.push(candidate)
    }
    // Whatever we just did to the table, a cached read no longer describes it.
    this.cache = null
    return pending
  }

  /**
   * Poll until none of `targets` is still writing its playlist, or the grace
   * runs out. Returns who is left, or `null` when the table could not be read
   * twice in a row. A zombie or a recycled pid is "gone" by this test, because
   * it is the ARGV that makes a writer, not the pid.
   */
  private async waitGone(
    targets: readonly Candidate[],
    graceMs: number,
  ): Promise<readonly Candidate[] | null> {
    const deadline = this.deps.now() + graceMs
    for (;;) {
      await this.deps.sleep(this.deps.pollMs ?? POLL_MS)
      const rows = await this.freshRowsOrNull()
      if (rows === null) return null
      const left = targets.filter((candidate) =>
        rows.some(
          (proc) =>
            proc.pid === candidate.proc.pid &&
            isWriterExecutable(proc, this.deps.executableMarker ?? DEFAULT_EXECUTABLE_MARKER) &&
            writesPlaylist(proc, segmentListPath(candidate.target.outDir)),
        ),
      )
      if (left.length === 0 || this.deps.now() >= deadline) return left
    }
  }

  /** One fresh read, and ONE retry after a poll interval. */
  private async freshRowsOrNull(): Promise<readonly ListedProcess[] | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.list(this.deps.now())
      } catch {
        if (attempt === 0) await this.deps.sleep(this.deps.pollMs ?? POLL_MS)
      }
    }
    return null
  }

  /**
   * The process table, read at or after `notBeforeMs`. Concurrent callers
   * share one read in flight, so eight attaches at boot cost one `ps`, not
   * eight.
   */
  private async list(notBeforeMs: number): Promise<readonly ListedProcess[]> {
    if (this.cache !== null && this.cache.at >= notBeforeMs) return this.cache.rows
    if (this.inflight !== null && this.inflight.startedAt >= notBeforeMs) {
      return (await this.inflight.promise).rows
    }
    const startedAt = this.deps.now()
    const promise = this.deps.lister
      .list(SEGMENT_LIST_FLAG)
      .then((rows) => ({ at: startedAt, rows }))
    const entry = { startedAt, promise }
    this.inflight = entry
    try {
      const listing = await promise
      if (this.cache === null || this.cache.at <= listing.at) this.cache = listing
      return listing.rows
    } finally {
      if (this.inflight === entry) this.inflight = null
    }
  }

  private refusedOf(candidate: Candidate, reason: RefusalReason): RefusedWriter {
    return {
      target: candidate.target,
      pid: candidate.proc.pid,
      ppid: candidate.proc.ppid,
      ageMs: candidate.proc.ageMs,
      reason,
    }
  }

  private heldRecord(outDir: string): RefusalRecord | null {
    const record = this.refusals.get(outDir)
    if (record === undefined) return null
    const retryMs = this.deps.refusalRetryMs ?? REFUSAL_RETRY_MS
    return this.deps.now() - record.lastAttemptMs < retryMs ? record : null
  }

  private startedAtOf(ageMs: number | null): number | null {
    return ageMs === null ? null : this.deps.now() - ageMs
  }

  /** ERROR on a new refusal state, DEBUG on a repeat of the same one. */
  private recordRefusal(writer: RefusedWriter, waitedMs: number): void {
    const now = this.deps.now()
    const startedAtMs = this.startedAtOf(writer.ageMs)
    const previous = this.refusals.get(writer.target.outDir)
    const same =
      previous !== undefined &&
      previous.pid === writer.pid &&
      previous.reason === writer.reason &&
      (previous.startedAtMs === null ||
        startedAtMs === null ||
        Math.abs(previous.startedAtMs - startedAtMs) <= SAME_START_TOLERANCE_MS)
    const attempts = same ? previous.attempts + 1 : 1
    this.refusals = new Map(this.refusals).set(writer.target.outDir, {
      pid: writer.pid,
      startedAtMs,
      reason: writer.reason,
      firstMs: same ? previous.firstMs : now,
      lastAttemptMs: now,
      attempts,
    })
    const extras = {
      tags: { deviceId: writer.target.deviceId },
      meta: {
        profile: writer.target.profile,
        pid: writer.pid,
        ppid: writer.ppid,
        ageSec: ageSec(writer.ageMs),
        reason: writer.reason,
        attempts,
        waitedMs,
        retryInMs: this.deps.refusalRetryMs ?? REFUSAL_RETRY_MS,
        outDir: writer.target.outDir,
      },
    }
    if (same) {
      this.deps.logger.debug(
        'recorder: staging directory still refused — same foreign writer',
        extras,
      )
      return
    }
    this.deps.logger.error(
      'recorder: REFUSED to spawn a writer — another writer on this staging directory could not be removed',
      extras,
    )
  }

  private logHeld(writer: RefusedWriter, record: RefusalRecord): void {
    this.deps.logger.debug('recorder: staging directory held after a refusal — not retried yet', {
      tags: { deviceId: writer.target.deviceId },
      meta: {
        profile: writer.target.profile,
        pid: record.pid,
        reason: record.reason,
        attempts: record.attempts,
        heldForMs: this.deps.now() - record.firstMs,
        outDir: writer.target.outDir,
      },
    })
  }

  private forgetRefusal(target: WriterTarget): void {
    const record = this.refusals.get(target.outDir)
    if (record === undefined) return
    const next = new Map(this.refusals)
    next.delete(target.outDir)
    this.refusals = next
    this.deps.logger.info(
      'recorder: staging directory no longer refused — the foreign writer is gone',
      {
        tags: { deviceId: target.deviceId },
        meta: {
          profile: target.profile,
          pid: record.pid,
          attempts: record.attempts,
          refusedForMs: this.deps.now() - record.firstMs,
          outDir: target.outDir,
        },
      },
    )
  }

  private logReaped(writer: ReapedWriter): void {
    if (this.refusals.has(writer.target.outDir)) this.forgetRefusal(writer.target)
    this.deps.logger.warn(
      'recorder: reaped a predecessor writer on this staging directory — one writer per directory',
      {
        tags: { deviceId: writer.target.deviceId },
        meta: {
          profile: writer.target.profile,
          pid: writer.pid,
          ppid: writer.ppid,
          ageSec: ageSec(writer.ageMs),
          signal: writer.signal,
          waitedMs: writer.waitedMs,
          outDir: writer.target.outDir,
        },
      },
    )
  }
}
