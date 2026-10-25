/**
 * Supervises one passthrough ffmpeg process for a single (camera, profile).
 *
 * Copied from the old recorder (`addon-pipeline/src/recorder/segment-writer.ts`)
 * verbatim — bounded restarts + stderr-tail diagnostics. The recorder
 * controller owns the lifecycle (start on band-active, stop on band-inactive /
 * shutdown) and the watcher that consumes the segments this writer emits.
 */
import type { IScopedLogger } from '@camstack/types'
import { NO_COST_CLAIM, type ChildCostClaimHandle } from '@camstack/types/node'
import { buildPassthroughArgs, type PassthroughArgs } from './ffmpeg-args.js'
import { readDialRefusal, type DialRefusal } from './dial-refusal.js'
import { readSpawnFailure } from './spawn-failure.js'

interface ProcLike {
  readonly kill: (signal?: NodeJS.Signals) => void
  readonly on: (ev: string, cb: (...a: unknown[]) => void) => void
  /** Default child_process.spawn pipes stderr; we read it for diagnosability. */
  readonly stderr?: { readonly on: (ev: string, cb: (...a: unknown[]) => void) => void } | null
  /** Live exit state (ChildProcess) — read to gate the escalated SIGKILL. */
  readonly exitCode?: number | null
  readonly signalCode?: NodeJS.Signals | null
  /**
   * The child's pid, when the spawner has one.
   *
   * This interface used to omit it deliberately, and that omission was cited
   * as the reason recording cost could not be read per camera: the controller
   * keys its map by deviceId, the OS keys its table by pid, and nothing joined
   * them. It is here now for the opposite reason — so this writer can CLAIM
   * its own child (see {@link SegmentWriterDeps.claimCost}) rather than leave
   * an observer to guess. `undefined` on a failed spawn and on the fakes the
   * specs pass, and a claim with no pid is inert.
   */
  readonly pid?: number | undefined
}

/**
 * The logger surface a writer needs. Narrowed on purpose: the controller hands
 * a device-scoped child, and a test hands four spies — nothing here re-scopes,
 * so demanding the full `IScopedLogger` only forced every spec to launder a
 * plain object through a cast.
 */
export type SegmentWriterLogger = Pick<IScopedLogger, 'info' | 'warn' | 'error'>

export interface SegmentWriterDeps {
  readonly spawn: (cmd: string, args: readonly string[]) => ProcLike
  readonly logger: SegmentWriterLogger
  /**
   * The camera every line this writer emits is about.
   *
   * Required, and stamped as `tags: { deviceId }` on every line here rather
   * than left to the caller's `logger.withTags`: "why is 102 worse than 101"
   * is the only way a restart storm or a media gap is ever asked, and a line
   * that carries the camera only inside `outDir` cannot be grouped by it. The
   * controller does bind a device-scoped child logger, but that is a
   * convention a future caller can forget — this is not.
   */
  readonly deviceId: number
  /**
   * Claim this writer's ffmpeg as THIS addon's cost, for this camera.
   *
   * Called with the pid on every spawn; the returned handle is released the
   * moment that generation terminates — same function, both edges, so a
   * restart cannot leave a claim behind. The writer does not know what a
   * contribution is and does not import a registry: the caller closes over the
   * device and the profile, because the caller is the only one that knows the
   * profile.
   *
   * Optional. Without it the ffmpeg is simply unclaimed, and the node's
   * process snapshot still counts it — in the unattributed bucket, which is
   * the honest place for a process nobody reported.
   */
  readonly claimCost?: (pid: number | undefined) => ChildCostClaimHandle
  /**
   * The node's PINNED ffmpeg (D540), resolved by the controller before the
   * writer exists. Required, with no default: this was `ffmpegPath?` with a
   * `'ffmpeg'` fallback and the controller never passed one, so every segment
   * this recorder wrote came from the HOST's binary.
   */
  readonly ffmpegPath: string
  /**
   * Liveness signal: invoked ONCE when the writer exhausts its bounded inner
   * restarts (`MAX_RESTARTS` consecutive rapid failures) and stops respawning
   * ffmpeg. Without it a dead writer is invisible to the controller, which keeps
   * believing the device is "converged" forever — the source goes idle (its only
   * RTSP restream consumer dropped) and recording silently stops until something
   * else re-dials. The controller wires this to tear down + re-queue the device
   * so the periodic tick re-attaches a fresh writer (bounded OUTER retry, not a
   * tight respawn loop). Fired only on give-up, never on an operator `stop()`.
   */
  readonly onGaveUp?: () => void
  /**
   * A TRANSIENT spawn failure (EAGAIN / EMFILE / ENOMEM) — the host could not
   * fork right now. Invoked once per occurrence, before the restart is
   * scheduled, so the caller can REDUCE CONCURRENCY instead of insisting: the
   * failure is a property of the node, not of this camera, and every other
   * writer dialling at the same moment is about to hit it too.
   * Never invoked for a PERMANENT failure (see `spawn-failure.ts`) — a
   * missing binary is not resource pressure and backing off cannot fix it.
   */
  readonly onResourcePressure?: () => void
}

/** ffmpeg exited on its own — the ordinary failure this writer was built for. */
interface WriterExited {
  readonly reason: 'exit'
  readonly exitCode: number | null
  /**
   * The signal that killed ffmpeg, when one did. Node reports EITHER a code or
   * a signal, never both, so `exitCode: null` alone says nothing — without this
   * field a SIGKILL from the OOM killer and a clean `exit(0)` produce the same
   * two nulls.
   *
   * A bare `string` and not `NodeJS.Signals`: this value is only ever printed,
   * and narrowing it to the literal union would need a cast — which this repo
   * does not allow — or a hand-kept signal table that adds nothing.
   */
  readonly signal: string | null
}

/**
 * ffmpeg could never be started: `child_process` emitted `'error'`.
 *
 * THIS IS THE PATH THAT COST THREE HOURS. Node re-throws an `'error'` with no
 * listener as an uncaught exception, so a host that momentarily could not fork
 * (EAGAIN, while three unplugged cameras all re-dialled) killed the whole
 * `recorder` runner — five times inside 60 s, which tripped the D6 crash
 * circuit-breaker and left the fleet with no recording until a manual redeploy.
 */
interface WriterSpawnFailed {
  readonly reason: 'spawn-error'
  readonly errorCode: string | undefined
  readonly message: string
  /** Retrying cannot help — see `spawn-failure.ts` for the EAGAIN/ENOENT split. */
  readonly permanent: boolean
}

/** Why one ffmpeg generation ended. Both funnel into ONE restart policy. */
type WriterTermination = WriterExited | WriterSpawnFailed

/** Max CONSECUTIVE rapid restarts before giving up (reset by a stable run). */
const MAX_RESTARTS = 10
/** How many trailing ffmpeg stderr lines to keep for the give-up diagnostic. */
const STDERR_TAIL_LINES = 12
/** Restart backoff: base delay, doubled per consecutive attempt, capped. */
const RESTART_BASE_MS = 500
const RESTART_MAX_MS = 10_000
/** A process that ran at least this long is "stable" → reset the restart count,
 *  so sporadic blips over a long lifetime never accumulate into a give-up. */
const STABLE_RUN_MS = 30_000
/**
 * The window the SECOND budget counts over — and it counts EVERY restart,
 * whatever that run lasted.
 *
 * `STABLE_RUN_MS` above is a reset, and a reset is a blind spot: measured on
 * 2026-08-27, `SegmentWriter restarting` fired **1 814 times in 12 h** and
 * almost every `ranMs` was over 30 s (122 620 / 165 255 / 345 420 / 394 522 ms
 * are four consecutive real samples), so `attempt` never left 1, `onGaveUp`
 * never fired, and `recoverWriterGaveUp` never ran. The storm could have lasted
 * forever without a single line saying anything was wrong.
 *
 * A window cannot be zeroed by a long run, which is the whole point. Modelled
 * on `CrashSupervisor` (kernel, D6): timestamps age out of `windowMs`, and the
 * count inside it is the budget.
 */
const RESTART_WINDOW_MS = 60 * 60_000
/**
 * Restarts inside {@link RESTART_WINDOW_MS} before the writer stops respawning
 * and escalates to the controller.
 *
 * 15/hour, from the measured distribution. Per writer over the same 12 h:
 * 1441/high 549 (**45.8/h**), 101/high 241 (20.1/h), 618/high 217 (18.1/h),
 * 592/high 211 (17.6/h), 104/high 195 (16.3/h) — every one of them a storm and
 * every one of them silent — against `low` profiles at 4–15 per 12 h (≤1.3/h),
 * which is what a healthy writer looks like. 15 separates them with room for a
 * camera that blips hourly and is otherwise fine.
 *
 * It never shadows {@link MAX_RESTARTS}: 10 CONSECUTIVE rapid failures happen
 * inside ~90 s, so the rapid breaker still trips first on a hard failure. This
 * one exists for the slow storm the rapid breaker structurally cannot see.
 */
const MAX_RESTARTS_IN_WINDOW = 15
/** Grace between the SIGTERM in stop() and the escalated SIGKILL. */
const KILL_GRACE_MS = 500

/** Supervises one passthrough ffmpeg for a single (camera, profile). */
export class SegmentWriter {
  private proc: ProcLike | null = null
  private stopped = false
  private restarts = 0
  /**
   * Epoch-ms of every termination still inside {@link RESTART_WINDOW_MS}.
   * Replaced, never mutated in place, so a reader can never observe a
   * half-pruned window.
   */
  private restartWindow: readonly number[] = []
  /**
   * Consecutive generations the source refused at the handshake (D685). Reset
   * by any generation that was not refused. Only read for the log line — the
   * rapid breaker is what bounds a source that never comes back.
   */
  private refusedInARow = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startedAt = 0
  private exitWait: Promise<void> | null = null
  private resolveExit: (() => void) | null = null
  /**
   * The cost claim for the CURRENT ffmpeg generation. Taken in `start()` and
   * released in `onTermination()` — the two edges of one process, so a restart
   * storm cannot accumulate claims for children that are already gone.
   */
  private costClaim: ChildCostClaimHandle = NO_COST_CLAIM
  /**
   * The pid of a generation `stop()` has signalled but whose `exit` has not
   * fired. `proc` is dropped at the signal; this keeps the pid readable until
   * the child is really gone, so the staging guard (D667) still knows it is
   * this runner's writer and not a predecessor's.
   */
  private exitingPid: number | undefined = undefined

  constructor(
    private readonly cfg: PassthroughArgs,
    private readonly deps: SegmentWriterDeps,
  ) {}

  /**
   * The pid of the ffmpeg this writer is supervising right now, or undefined
   * between generations. Read by the staging-directory guard (D667) so a
   * writer the controller is TRACKING is never mistaken for a predecessor's.
   */
  get pid(): number | undefined {
    return this.proc?.pid ?? this.exitingPid
  }

  start(): void {
    if (this.stopped || this.proc) return
    const args = buildPassthroughArgs(this.cfg)
    const proc = this.deps.spawn(this.deps.ffmpegPath, args)
    this.proc = proc
    this.exitWait = new Promise<void>((resolve) => {
      this.resolveExit = resolve
    })
    this.startedAt = Date.now()
    // Claim this generation as this addon's cost for this camera. The pid is
    // read HERE, at the only point that knows both it and the device.
    this.costClaim = this.deps.claimCost?.(proc.pid) ?? NO_COST_CLAIM

    // Keep a small ring of ffmpeg's stderr so a fatal exit reports WHY
    // (e.g. "codec pcm_mulaw not supported in container") instead of a bare
    // exit code. stderr is per-spawn, so this resets on every restart.
    const stderrTail: string[] = []
    proc.stderr?.on('data', (chunk: unknown) => {
      const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        stderrTail.push(trimmed)
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
      }
    })

    // ONE termination per ffmpeg generation. Node may emit BOTH `'error'` and
    // `'exit'` for the same child ("the 'exit' event may or may not fire after
    // an error has occurred"), and a second pass through the policy would
    // schedule a second restart — two writers, double-pull, double-write.
    let settled = false
    const terminate = (termination: WriterTermination): void => {
      if (settled) return
      settled = true
      this.onTermination(termination, stderrTail)
    }

    // Node hands `(code, signal)` and sets exactly one of them. Both are kept:
    // a `null` exit code beside `SIGKILL` is the OOM killer, beside `SIGTERM`
    // it is a shutdown, and beside `null` it is neither — three different
    // answers that a bare code collapses into one.
    proc.on('exit', (code, signal) => {
      terminate({
        reason: 'exit',
        exitCode: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
      })
    })

    // The listener whose ABSENCE was the outage. It funnels into the SAME
    // restart-with-backoff policy `exit` uses — there is no second policy here.
    proc.on('error', (raw) => {
      const failure = readSpawnFailure(raw)
      terminate({
        reason: 'spawn-error',
        errorCode: failure.code,
        message: failure.message,
        permanent: failure.permanent,
      })
    })
  }

  /**
   * The ONE restart policy, reached from both `exit` and `error`.
   *
   * Every line below carries `tags: { deviceId }` from `deps.deviceId` — "why
   * is 102 worse than 101" is always asked per camera, and a writer that stops
   * recording one camera must be greppable by that camera.
   */
  private onTermination(termination: WriterTermination, stderrTail: readonly string[]): void {
    // Release BEFORE anything that can throw or return early: a claim that
    // outlives its process is the one failure this reporting must not have.
    this.costClaim.release()
    this.costClaim = NO_COST_CLAIM
    this.resolveExit?.()
    this.resolveExit = null
    this.proc = null
    this.exitingPid = undefined
    if (this.stopped) return

    const now = Date.now()
    // A long, healthy run resets the consecutive-restart counter — only RAPID
    // back-to-back failures (e.g. a stream-source outage) count toward giving
    // up, so a brief blip never permanently stops a camera's recording.
    const ranMs = now - this.startedAt

    // A dial the source REFUSED at the handshake never ran (D685): the restream
    // path was unpublished while a provider runner restarted, and ffmpeg was
    // answered `404` before a single packet. It is a re-dial, not a stream
    // that ended — so it stays OUT of the storm window below, which exists for
    // streams that run and keep ending. It still counts toward the rapid
    // breaker (`restarts`), which is what bounds a source that never returns —
    // and so a refusal never RESETS that breaker, however long the source took
    // to refuse: a generation that never ran is not a stable run.
    const refusal = termination.reason === 'exit' ? readDialRefusal(stderrTail) : null
    this.refusedInARow = refusal === null ? 0 : this.refusedInARow + 1
    if (ranMs >= STABLE_RUN_MS && refusal === null) this.restarts = 0

    // The SECOND budget, and the one the reset above cannot touch: every
    // termination of a generation that RAN lands in the window whatever
    // `ranMs` was. See {@link RESTART_WINDOW_MS} for the 1 814-restarts-in-12 h
    // that this counts and `attempt` does not.
    const liveWindow = this.restartWindow.filter((at) => at > now - RESTART_WINDOW_MS)
    this.restartWindow = refusal === null ? [...liveWindow, now] : liveWindow
    const restartsInWindow = this.restartWindow.length

    if (termination.reason === 'exit' && refusal === null) {
      // ffmpeg died on its own — and until 2026-08-27 this branch, the ONLY one
      // that was actually firing, said NOTHING. `exitCode` and the stderr tail
      // were captured on every spawn and printed only on give-up, so 1 814
      // restarts in 12 h produced not one line naming a cause. A branch that
      // drops work says why it dropped it.
      this.deps.logger.warn('SegmentWriter ffmpeg exited', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          outDir: this.cfg.outDir,
          exitCode: termination.exitCode,
          signal: termination.signal,
          ranMs,
          restartsInWindow,
          windowMs: RESTART_WINDOW_MS,
          // The answer, when there is one: ffmpeg says "Connection reset by
          // peer" / "codec not supported in container" / "End of file" here.
          stderrTail: stderrTail.join(' | '),
        },
      })
    }

    if (termination.reason === 'spawn-error') {
      // A branch that drops work says so: no ffmpeg means no segment for this
      // camera, for at least one backoff. Silence here read as "never
      // happened" for three hours.
      this.deps.logger.warn('SegmentWriter ffmpeg spawn failed', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          outDir: this.cfg.outDir,
          errorCode: termination.errorCode,
          error: termination.message,
          permanent: termination.permanent,
        },
      })
      if (termination.permanent) {
        this.deps.logger.error('SegmentWriter giving up: ffmpeg cannot be executed on this node', {
          tags: { deviceId: this.deps.deviceId },
          meta: {
            outDir: this.cfg.outDir,
            errorCode: termination.errorCode,
            error: termination.message,
          },
        })
        this.stopped = true
        this.deps.onGaveUp?.()
        return
      }
      // Transient: the host could not fork. Tell the caller BEFORE scheduling
      // the retry so the fleet-wide attach concurrency shrinks on this pass
      // rather than the next one.
      this.deps.onResourcePressure?.()
    }

    if (this.restarts >= MAX_RESTARTS) {
      this.deps.logger.warn('SegmentWriter giving up after max restarts', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          outDir: this.cfg.outDir,
          reason: termination.reason,
          code: termination.reason === 'exit' ? termination.exitCode : termination.errorCode,
          stderrTail: stderrTail.join(' | '),
        },
      })
      // Surface give-up so the controller can detach + re-queue this device
      // (bounded outer retry on the periodic tick) rather than treating it as
      // permanently recording. Mark stopped so a late `stop()` is a no-op and
      // no further inner restart can fire.
      this.stopped = true
      this.deps.onGaveUp?.()
      return
    }

    // The storm. Checked AFTER the rapid breaker so a hard failure still
    // reports as one, and it reaches the SAME `onGaveUp` — a writer whose
    // inner respawn has demonstrably not fixed anything in an hour needs the
    // outer path, which re-dials the broker for a fresh stream session instead
    // of re-running ffmpeg against the url that keeps ending. Bounded by
    // construction: the writer stops here, so the next escalation costs
    // another full budget on the writer the controller attaches next.
    if (restartsInWindow >= MAX_RESTARTS_IN_WINDOW) {
      this.deps.logger.warn('SegmentWriter giving up: restart storm', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          outDir: this.cfg.outDir,
          restartsInWindow,
          windowMs: RESTART_WINDOW_MS,
          budget: MAX_RESTARTS_IN_WINDOW,
          // The number that made this invisible: a storm of long runs keeps
          // `attempt` at 1 forever, which is why the rapid breaker above never
          // fired once across 1 814 restarts.
          attempt: this.restarts,
          ranMs,
          reason: termination.reason,
          code: termination.reason === 'exit' ? termination.exitCode : termination.errorCode,
          stderrTail: stderrTail.join(' | '),
        },
      })
      this.stopped = true
      this.deps.onGaveUp?.()
      return
    }

    this.restarts++
    // Exponential backoff so a failing source doesn't get hammered with a
    // respawn storm (which previously produced many overlapping segments).
    const delayMs = Math.min(RESTART_BASE_MS * 2 ** (this.restarts - 1), RESTART_MAX_MS)
    if (refusal !== null) {
      this.logDeferredRedial(refusal, delayMs, ranMs, restartsInWindow)
    } else {
      this.logRestarting(termination, delayMs, ranMs, restartsInWindow)
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delayMs)
  }

  /**
   * A refused dial, named — every one of them, per camera. The FIRST of a run
   * is a WARN (the source just went away under a live writer); the rest are
   * the same outage continuing and go out at INFO with the running count.
   */
  private logDeferredRedial(
    refusal: DialRefusal,
    delayMs: number,
    ranMs: number,
    restartsInWindow: number,
  ): void {
    const payload = {
      tags: { deviceId: this.deps.deviceId },
      meta: {
        outDir: this.cfg.outDir,
        method: refusal.method,
        status: refusal.status,
        refusedInARow: this.refusedInARow,
        attempt: this.restarts,
        delayMs,
        ranMs,
        // Unchanged by a refusal — printed so the line proves it.
        restartsInWindow,
      },
    }
    if (this.refusedInARow === 1) {
      this.deps.logger.warn(
        'SegmentWriter dial refused — source not published, re-dialling',
        payload,
      )
      return
    }
    this.deps.logger.info('SegmentWriter dial still refused — re-dial deferred', payload)
  }

  private logRestarting(
    termination: WriterTermination,
    delayMs: number,
    ranMs: number,
    restartsInWindow: number,
  ): void {
    this.deps.logger.info('SegmentWriter restarting', {
      tags: { deviceId: this.deps.deviceId },
      meta: {
        outDir: this.cfg.outDir,
        attempt: this.restarts,
        // `attempt` is the CONSECUTIVE-rapid count and it lies about a storm of
        // long runs — this is the number that does not.
        restartsInWindow,
        delayMs,
        ranMs,
        reason: termination.reason,
      },
    })
  }

  stop(): void {
    void this.stopAndWait()
  }

  /**
   * Stop ffmpeg and wait for its exit when the process exposes real child
   * liveness fields. Test fakes often omit them, in which case stop remains
   * deliberately synchronous. The recorder keeps its watcher alive until this
   * promise settles, so a final ENDLIST segment is indexed before migration.
   */
  async stopAndWait(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const proc = this.proc
    const exitWait = this.exitWait
    this.proc = null
    if (!proc) return
    // Still ours until its `exit` fires (cleared in `onTermination`). A spawn
    // fake with no liveness fields never exits, so it is not kept.
    if (proc.exitCode !== undefined || proc.signalCode !== undefined) this.exitingPid = proc.pid
    try {
      proc.kill('SIGTERM')
    } catch {
      // already dead
    }
    // Escalate to SIGKILL if SIGTERM didn't land. A passthrough ffmpeg blocked
    // in a TCP RTSP read can IGNORE SIGTERM and survive — the writer then leaks,
    // so a give-up → detach → re-attach recovery spawns a DUPLICATE writer for
    // the profile (double-pull + double-write). Gate on the process still
    // running (both exit codes null), NOT on a `killed` flag — Node sets that
    // true after ANY kill() so it would never fire (mirrors decoder-ffmpeg's
    // killFfmpeg fix). Harmless when spawn fakes omit the codes (gate stays false).
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // already dead
        }
      }
    }, KILL_GRACE_MS)
    timer.unref?.()
    if (proc.exitCode === undefined && proc.signalCode === undefined) return
    await exitWait
  }
}
