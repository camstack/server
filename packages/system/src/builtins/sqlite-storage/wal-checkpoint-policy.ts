/**
 * When the checkpoint worker folds the WAL — the judgement, pure.
 *
 * ## Why a worker checkpoints at all
 *
 * `hub/sqlite-settings` is one JS thread with a synchronous binding, and every
 * configuration read in the cluster queues behind whatever statement it is
 * inside. With `journal_mode = WAL` and the build default `synchronous =
 * NORMAL`, an ordinary commit is an append to the WAL with NO fsync. The
 * fsyncs — the only thing in a one-row write that can take seconds — happen
 * at the CHECKPOINT: the WAL is synced before the pages are copied, the
 * database file after. And SQLite runs the auto-checkpoint (1000 pages)
 * INSIDE the commit of whichever writer crosses the threshold.
 *
 * Measured on the hub, 2026-09-11 10:45–10:55 CEST, from outside the process
 * (`/proc/<pid>/syscall` at 10 Hz + the wal-index header at 1 Hz, D452): the
 * WAL refilled at ~54 frames/s, the auto-checkpoint fired every 12–25 s (42
 * in 9.5 min), and every D-state run on the settings thread that sat in a
 * syscall sat in `fsync` (74), each within ±2 s of a checkpoint event —
 * 12.6 s of the 569 s window, all of it inside writers' commits. In the two
 * saturated bursts earlier that morning (08:35–08:40, 09:30–09:39) the same
 * fsync took 1–10 s, once per checkpoint, and the profiler filed each as a
 * slow `set`. `synchronous` was never the lever: it was already NORMAL, and
 * `sqlite-pragmas.ts` had said so since 2026-08-08.
 *
 * So the checkpoint runs on a worker thread, over its own connection. The
 * settings thread's commits stay appends. What stays on the settings thread
 * is the WAL-header sync SQLite performs when a WAL is reused after a
 * completed checkpoint — one small fsync per cycle — and that residual is
 * named here so nobody reads "no fsync on the settings thread" into this.
 *
 * ## The rule this file reproduces
 *
 * The auto-checkpoint's own rule: fold when 1000 frames are pending. The
 * point of moving the checkpoint is to change WHO waits on the disk, not how
 * often the disk is asked to sync — a worker that folded every second would
 * multiply the fsync count on a drive the media plane already saturates.
 *
 * ## How the worker knows how much is pending — and how it must NOT learn it
 *
 * Until 2026-09-29 the worker read the wal-index header straight out of the
 * `-shm` file, once a second, with `openSync` / `readSync` / `closeSync`. That
 * `closeSync` was the SIGBUS of D468 (corrected by D679): on POSIX, closing
 * ANY descriptor of a file drops EVERY fcntl lock the process holds on that
 * file — including the shared lock on `-shm` byte 128 (the "DMS" lock) that
 * SQLite takes for the life of a connection and that tells every OTHER
 * process "a live connection is using this wal-index, do not rebuild it". With
 * the lock gone, the next process to open the database believed it was
 * first, truncated and re-initialised the `-shm` under the runner's mappings,
 * and the runner's next write past a 32 KiB wal-index region hit a page
 * beyond end-of-file.
 *
 * So the worker never touches a SQLite file except through its connection.
 * What it knows about the WAL it learns from the checkpoint it just ran:
 * `PRAGMA wal_checkpoint(PASSIVE)` answers `log` (frames in the WAL) and
 * `checkpointed` (frames now backfilled). Two consecutive answers give the
 * frames appended between them, hence a rate, hence WHEN the next 1000 frames
 * will have accumulated. The next checkpoint is scheduled for then —
 * {@link nextCheckpointPlan} — clamped between the worker's poll interval and
 * {@link WAL_CHECKPOINT_MAX_DELAY_MS}. A PASSIVE with nothing to fold performs
 * no fsync (the copy and both syncs sit behind `nBackfill < mxFrame` in
 * `wal.c`), so the clamp costs a quiet database nothing, and it bounds how
 * long a burst that follows a quiet spell goes unseen.
 */

/** The engine's own `wal_autocheckpoint` default, in frames. Reproduced, not changed. */
export const WAL_CHECKPOINT_THRESHOLD_FRAMES = 1000

/**
 * Longest the worker waits between two checkpoints, in ms, whatever the
 * measured rate says. It is the bound on how late a burst after a steady or
 * quiet spell is noticed, and it is sized against the engine's own fallback
 * (`SQLITE_WAL_AUTOCHECKPOINT_BOUND_PAGES` = 10 000 frames), which runs INSIDE
 * a settings-thread commit — the stall D452 moved off that thread. No burst
 * rate has been measured on the hub (D452's 54 frames/s is the steady rate),
 * so the design point is 1 000 frames/s, ~18× steady: 8 s of it is 8 000
 * frames, under the fallback, so the worker looks before the engine has to.
 * A pass that finds more than {@link WAL_CHECKPOINT_LARGE_PASS_FRAMES} is
 * reported so this number can be tuned from the field.
 *
 * The cost, stated against D452: at the steady 54 frames/s the threshold
 * would fold every ~18.5 s; this clamp folds every 8 s, ~2.3× the fsync pairs
 * (≈ 432 frames per fold instead of 1 000). They are paid on the WORKER, a
 * thread nobody waits on — the settings thread's commits stay appends. A pass
 * with nothing pending does no fsync at all.
 */
export const WAL_CHECKPOINT_MAX_DELAY_MS = 8_000

/**
 * A pass that folded more than this many appended frames is reported (WARN,
 * sampled: the first of each summary window, the rest counted). Half the
 * engine's fallback bound: a gap that let this much accumulate was within 2×
 * of handing the checkpoint back to the settings thread.
 */
export const WAL_CHECKPOINT_LARGE_PASS_FRAMES = 5_000

/** Shortest gap between two checkpoints, in ms — the worker's poll interval. */
export const WAL_CHECKPOINT_POLL_MS = 1_000

/**
 * A checkpoint that took this long is reported at WARN with its numbers.
 * Matched to `SQLITE_SLOW_CALL_MS`: it is the same "the disk held us" event
 * the profiler used to file as a slow `set`, now on the thread that paid it.
 */
export const WAL_CHECKPOINT_SLOW_MS = 1_000

/** What one `PRAGMA wal_checkpoint(PASSIVE)` answered, and when. */
export interface CheckpointObservation {
  /** ms epoch at which the checkpoint returned. */
  readonly at: number
  /** `log`: frames in the WAL when the checkpoint ran. */
  readonly walFrames: number
  /** `checkpointed`: frames backfilled into the database file. */
  readonly checkpointedFrames: number
}

/**
 * Frames appended to the WAL between two checkpoints.
 *
 * When the previous checkpoint backfilled EVERYTHING, the next writer restarts
 * the WAL from frame 1, so every frame now in it is new. When it did not (a
 * reader pinned a snapshot), the WAL kept growing and the difference is what
 * was added — unless it shrank, which only a restart can do.
 *
 * An IDLE WAL is the exception to "complete means restarted": the WAL restarts
 * only at the next write, so a fully checkpointed WAL nobody writes answers
 * the same `log == checkpointed` pass after pass. Identical answers after a
 * complete checkpoint are therefore 0 appended, not the whole WAL again —
 * otherwise an idle node would be scheduled at the poll interval forever and
 * every summary would count the same frames once per pass. (A restart that
 * appended exactly as many frames as the previous cycle is read as idle too;
 * it is scheduled at the max delay, which is the bounded case anyway.)
 *
 * The one remaining ambiguity — a complete checkpoint followed by writes the
 * writer could NOT restart the WAL for — counts old frames as new, which
 * over-estimates the rate and checkpoints EARLY: the safe direction. `-1`
 * (not a WAL database, or a busy pass) reads as 0.
 */
export function framesAppendedBetween(
  previous: CheckpointObservation,
  current: CheckpointObservation,
): number {
  const prevWal = Math.max(0, previous.walFrames)
  const prevDone = Math.max(0, previous.checkpointedFrames)
  const curWal = Math.max(0, current.walFrames)
  const curDone = Math.max(0, current.checkpointedFrames)
  if (prevDone >= prevWal) {
    if (curWal === prevWal && curDone === prevDone) return 0
    return curWal
  }
  return curWal >= prevWal ? curWal - prevWal : curWal
}

/**
 * What the worker "saw" before its first checkpoint: nothing, at the moment it
 * started. Against it, the first checkpoint counts every frame then in the WAL
 * as appended since the start — which over-estimates the rate when the WAL
 * held older frames, and so schedules the second checkpoint EARLY: the safe
 * direction, and the second one measures the real rate.
 */
export function workerStartObservation(at: number): CheckpointObservation {
  return { at, walFrames: 0, checkpointedFrames: 0 }
}

export type CheckpointReason = 'first' | 'scheduled'

export interface CheckpointPlan {
  /** Frames appended since the previous checkpoint (or the worker's start). */
  readonly appendedFrames: number
  /** How long until the next checkpoint, in ms. */
  readonly nextDelayMs: number
}

export interface CheckpointPlanInput {
  readonly previous: CheckpointObservation
  readonly current: CheckpointObservation
  readonly minDelayMs: number
  readonly maxDelayMs: number
}

/**
 * When to run the next checkpoint: the moment the measured rate says
 * {@link WAL_CHECKPOINT_THRESHOLD_FRAMES} more frames will be pending,
 * clamped to `[minDelayMs, maxDelayMs]`. Nothing appended since the last one
 * is `maxDelayMs`.
 */
export function nextCheckpointPlan(input: CheckpointPlanInput): CheckpointPlan {
  const { previous, current, minDelayMs, maxDelayMs } = input
  const appendedFrames = framesAppendedBetween(previous, current)
  const elapsedMs = Math.max(1, current.at - previous.at)
  if (appendedFrames === 0) return { appendedFrames, nextDelayMs: maxDelayMs }
  const framesPerMs = appendedFrames / elapsedMs
  const untilThresholdMs = WAL_CHECKPOINT_THRESHOLD_FRAMES / framesPerMs
  const nextDelayMs = Math.round(Math.min(maxDelayMs, Math.max(minDelayMs, untilThresholdMs)))
  return { appendedFrames, nextDelayMs }
}

/** What the worker tells the parent after one checkpoint. */
export interface CheckpointReport {
  readonly kind: 'checkpointed'
  readonly reason: CheckpointReason
  /** Frames appended since the previous checkpoint (or the worker's start). */
  readonly appendedFrames: number
  /** When the worker will checkpoint next, in ms. */
  readonly nextDelayMs: number
  /** `PRAGMA wal_checkpoint` row: frames in the WAL, frames now backfilled, busy flag. */
  readonly walFrames: number
  readonly checkpointedFrames: number
  readonly busy: boolean
  readonly ms: number
}

export interface WorkerReady {
  readonly kind: 'ready'
}

export interface WorkerFailure {
  readonly kind: 'failed'
  readonly error: string
}

export type WorkerMessage = CheckpointReport | WorkerReady | WorkerFailure

export interface WorkerStop {
  readonly kind: 'stop'
}

/** What the worker is started with. */
export interface WalCheckpointWorkerData {
  readonly dbPath: string
  /** Shortest gap between two checkpoints. */
  readonly pollMs: number
  /** Longest gap between two checkpoints. */
  readonly maxDelayMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Narrow a message off the worker port without a cast. */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isRecord(value)) return false
  switch (value['kind']) {
    case 'ready':
      return true
    case 'failed':
      return typeof value['error'] === 'string'
    case 'checkpointed':
      return (
        (value['reason'] === 'first' || value['reason'] === 'scheduled') &&
        typeof value['appendedFrames'] === 'number' &&
        typeof value['nextDelayMs'] === 'number' &&
        typeof value['walFrames'] === 'number' &&
        typeof value['checkpointedFrames'] === 'number' &&
        typeof value['busy'] === 'boolean' &&
        typeof value['ms'] === 'number'
      )
    default:
      return false
  }
}

export function isWorkerStop(value: unknown): value is WorkerStop {
  return isRecord(value) && value['kind'] === 'stop'
}
