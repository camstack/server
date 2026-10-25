/**
 * `FfmpegProcess` — the ONE spawn/lifecycle wrapper for a live-media ffmpeg.
 *
 * Extracted from `TranscodeEgress.spawnAttempt`, which was already the most
 * complete of the repo's hand-rolled lifecycles: first-data deadline, hardware
 * →software retry, SIGTERM-then-SIGKILL. This generalises it and adds the two
 * things every copy was missing — a `tags: { deviceId }` on every line, and a
 * bounded restart — so a consumer gets them by construction instead of by
 * remembering.
 *
 * ## What it owns
 *
 * - spawn, with the argv from the ONE builder (`./invocation.js`);
 * - a FIRST-DATA deadline: an ffmpeg that starts but never emits is dead, and
 *   nothing downstream can tell that apart from a slow camera;
 * - HARDWARE→SOFTWARE retry, announced at `warn`. A silent downgrade on this
 *   hub is a flow bug, not a capability limit — see `docs/design/decode-path.md`;
 * - exit classification (`ok` / `signalled-by-us` / `crashed` / `no-output`);
 * - bounded restart with backoff, and a terminal give-up (never an infinite
 *   loop — the same rule `CrashSupervisor` enforces for runners, D6);
 * - SIGTERM then SIGKILL after a grace, gated on the child not having already
 *   exited.
 *
 * ## What it does NOT own
 *
 * The output PLUMBING. A consumer attaches to `stdout` / `stderr` itself,
 * because what the bytes mean is the consumer's business: the broker deframes
 * Annex-B into a restreamer, the WebRTC leg regroups access units, HomeKit
 * writes nothing to stdout at all (its output is two RTP sockets). A wrapper
 * that also owned the bytes would need a mode per consumer, which is the same
 * mistake as one builder per consumer.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { IScopedLogger } from '../interfaces/logging.js'

/** Subset of {@link ChildProcess} every live-media ffmpeg site reads. */
export interface SpawnedFfmpegProcess {
  readonly pid?: number
  readonly killed?: boolean
  readonly exitCode?: number | null
  readonly signalCode?: NodeJS.Signals | null
  readonly stdin?: { on(event: string, listener: () => void): void; end(): void } | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (err: Error) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

/** Injectable ffmpeg spawn — the three-arg shape live-media sites use. */
export type FfmpegSpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => SpawnedFfmpegProcess

export function defaultFfmpegSpawn(
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): SpawnedFfmpegProcess {
  return spawn(command, args, options ?? {})
}

/** How a child ended. */
export type FfmpegExitClass =
  /** Exited 0. */
  | 'ok'
  /** We asked it to stop — an exit code here is expected, not a failure. */
  | 'stopped'
  /** Exited non-zero / on a signal we did not send. */
  | 'crashed'
  /** Ran, but never produced a byte before the first-data deadline. */
  | 'no-output'

export interface FfmpegExit {
  readonly classification: FfmpegExitClass
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** The last stderr lines — the only diagnosis available after the fact. */
  readonly stderrTail: readonly string[]
  /** Whether this child was decoding in hardware. */
  readonly decodeHwAccel: string | null
}

export interface FfmpegProcessOptions {
  /** `system-config` `ffmpeg.binaryPath`. */
  readonly binaryPath: string
  /**
   * Build the argv for one attempt. Called per spawn so a retry can lower
   * `decodeHwAccel` to `null` (software) without the caller re-deriving
   * anything else.
   */
  readonly buildArgs: (decodeHwAccel: string | null) => readonly string[]
  /** The resolved hardware backend for the FIRST attempt (`null` ⇒ software). */
  readonly decodeHwAccel: string | null
  readonly logger: IScopedLogger
  /**
   * The camera this ffmpeg serves. Stamped on EVERY line as `tags.deviceId`:
   * a miss rate or a media gap is always asked per camera, and a line without
   * it cannot answer "why is 102 worse than 101".
   */
  readonly deviceId: number
  /** Free-form label for the log (`'webrtc-transcode'`, `'hap-egress'`, …). */
  readonly role: string
  /** Extra queryable tags (sessionId, brokerId, camStreamId…). */
  readonly tags?: Readonly<Record<string, string | number>>
  readonly stdio?: SpawnOptions['stdio']
  /** Wire up stdout/stderr. Called once per spawned child. */
  readonly onChild: (child: ChildProcess) => void
  /**
   * Called when a child ends. `restart` tells the wrapper whether to respawn;
   * it is bounded by {@link maxRestarts} regardless of what this returns.
   */
  readonly onExit?: (exit: FfmpegExit) => void
  /**
   * Called ONCE, when the wrapper stops restarting and the child is gone for
   * good.
   *
   * `onExit` cannot answer this: it fires on every exit, including the ones
   * that are about to be respawned, so a caller using it to tear down would
   * tear down on the first hiccup. And the `start()` promise cannot answer it
   * either — its `reject` is spent the moment the child first goes live, so a
   * give-up AFTER that reached nobody at all. A camera-grid tile that died an
   * hour in was indistinguishable, to its owner, from one that never started.
   */
  readonly onGiveUp?: (error: Error) => void
  /** Wall-clock budget for the first output byte. `0` disables the deadline. */
  readonly firstDataTimeoutMs?: number
  /** `0` ⇒ never restart (a run-to-completion job). */
  readonly maxRestarts?: number
  readonly restartDelayMs?: number
  /** Consecutive-failure counter resets after a child has run this long. */
  readonly stableRunMs?: number
  readonly killGraceMs?: number
  /** Injected for tests. */
  readonly spawnFn?: typeof spawn
  readonly now?: () => number
  readonly setTimeoutFn?: typeof setTimeout
}

const DEFAULT_FIRST_DATA_TIMEOUT_MS = 8_000
const DEFAULT_RESTART_DELAY_MS = 1_000
const DEFAULT_STABLE_RUN_MS = 30_000
const DEFAULT_KILL_GRACE_MS = 500
const STDERR_TAIL_LINES = 12

export class FfmpegProcess {
  private child: ChildProcess | null = null
  private stopped = false
  private producedOutput = false
  private consecutiveFailures = 0
  private startedAtMs = 0
  private stderrTail: string[] = []
  private activeHwAccel: string | null
  private triedSoftwareFallback = false
  private firstDataTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: FfmpegProcessOptions) {
    this.activeHwAccel = opts.decodeHwAccel
  }

  /** Queryable tags on every line — `deviceId` is never optional. */
  private get logTags(): Readonly<Record<string, string | number>> {
    return { deviceId: this.opts.deviceId, ...this.opts.tags }
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** `true` while a child is running. */
  isRunning(): boolean {
    return this.child !== null && !this.stopped
  }

  /** The backend the CURRENT child decodes with (`null` ⇒ software). */
  activeDecodeHwAccel(): string | null {
    return this.activeHwAccel
  }

  /**
   * Spawn the first child. Resolves as soon as it produces output; rejects if
   * it dies or stays silent past the deadline AFTER the software retry has
   * also been exhausted. A caller that wants fire-and-forget can ignore the
   * promise — the restart loop runs regardless.
   */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.spawnAttempt(resolve, reject)
    })
  }

  private spawnAttempt(onLive: () => void, onDead: (err: Error) => void): void {
    if (this.stopped) return
    const args = [...this.opts.buildArgs(this.activeHwAccel)]
    const spawnFn = this.opts.spawnFn ?? spawn
    const setTimeoutImpl = this.opts.setTimeoutFn ?? setTimeout

    this.opts.logger.info(`ffmpeg ${this.opts.role}: spawning`, {
      tags: this.logTags,
      meta: {
        decodeHwAccel: this.activeHwAccel ?? 'software',
        attempt: this.consecutiveFailures + 1,
      },
    })

    let child: ChildProcess
    try {
      child = spawnFn(this.opts.binaryPath, args, {
        stdio: this.opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      // A spawn THROW is the loudest possible hardware failure: the child
      // never existed, so there is nothing to classify. Retry in software.
      this.handleFailure('crashed', null, null, err, onLive, onDead)
      return
    }

    this.child = child
    this.startedAtMs = this.now
    this.producedOutput = false
    this.stderrTail = []
    let settled = false

    const timeoutMs = this.opts.firstDataTimeoutMs ?? DEFAULT_FIRST_DATA_TIMEOUT_MS
    if (timeoutMs > 0) {
      this.firstDataTimer = setTimeoutImpl(() => {
        if (settled || this.producedOutput || this.stopped) return
        settled = true
        // An ffmpeg that starts and stays mute is dead in a way nothing
        // downstream can distinguish from a slow camera. Say so.
        this.opts.logger.warn(`ffmpeg ${this.opts.role}: no output within ${timeoutMs}ms`, {
          tags: this.logTags,
          meta: { decodeHwAccel: this.activeHwAccel ?? 'software' },
        })
        this.killChild()
        this.handleFailure('no-output', null, null, null, onLive, onDead)
      }, timeoutMs)
    }

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (line: string) => {
      const text = String(line).trim()
      if (text.length === 0) return
      this.stderrTail.push(text)
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
      this.opts.logger.debug(`ffmpeg ${this.opts.role}`, {
        tags: this.logTags,
        meta: { line: text },
      })
    })

    child.once('error', (err: Error) => {
      if (settled || this.stopped) return
      settled = true
      this.handleFailure('crashed', null, null, err, onLive, onDead)
    })

    child.once('exit', (code, signal) => {
      this.clearFirstDataTimer()
      if (this.child === child) this.child = null
      if (this.stopped) {
        this.report('stopped', code, signal)
        return
      }
      if (settled && this.producedOutput) {
        // It was live and then died — a genuine crash of a working pipeline.
        this.report('crashed', code, signal)
        this.scheduleRestart(onLive, onDead)
        return
      }
      if (settled) return
      settled = true
      this.handleFailure(
        this.producedOutput ? 'crashed' : 'no-output',
        code,
        signal,
        null,
        onLive,
        onDead,
      )
    })

    this.opts.onChild(child)

    // The consumer's stdout handler is its own; we only need to know that
    // SOMETHING came out — and we must NOT take it.
    //
    // `once('data')` would: a `data` listener switches the stream to flowing
    // mode, so the first chunk goes to whoever is listening at that instant and
    // is gone. The consumer attaches LATER by construction — it receives the
    // child when `startChild` resolves, and `startChild` resolves on live — so
    // the first chunk was always eaten here. Invisible for MPEG-TS, which any
    // reader can join mid-stream; fatal for FLV, whose signature, `onMetaData`
    // tag and AVC sequence header exist only at the top of the stream. The grid
    // answered `200 OK` and zero bytes for fifteen seconds because of this line
    // (hub, 2026-09-17).
    //
    // `readable` answers the same question and leaves the bytes in the buffer.
    // See `packages/types/src/__tests__/ffmpeg-first-chunk.spec.ts`, which pins
    // both behaviours side by side.
    child.stdout?.once('readable', () => {
      this.producedOutput = true
      this.clearFirstDataTimer()
      if (settled) return
      settled = true
      this.opts.logger.info(`ffmpeg ${this.opts.role}: live`, {
        tags: this.logTags,
        meta: { decodeHwAccel: this.activeHwAccel ?? 'software' },
      })
      onLive()
    })
  }

  /**
   * A child failed before going live. Try SOFTWARE once if it was decoding in
   * hardware — loudly — then fall through to the bounded restart.
   */
  private handleFailure(
    classification: FfmpegExitClass,
    code: number | null,
    signal: NodeJS.Signals | null,
    err: unknown,
    onLive: () => void,
    onDead: (error: Error) => void,
  ): void {
    this.report(classification, code, signal, err)

    if (this.activeHwAccel !== null && !this.triedSoftwareFallback && !this.stopped) {
      this.triedSoftwareFallback = true
      // NEVER silent. A software fallback on a hub with working vaapi means a
      // flow bug (bad args, undecodable input), and it will otherwise present
      // as "the CPU is busy" with nothing to correlate.
      this.opts.logger.warn(
        `ffmpeg ${this.opts.role}: hardware decode produced no output — retrying in SOFTWARE`,
        {
          tags: this.logTags,
          meta: {
            decodeHwAccel: this.activeHwAccel,
            classification,
            code,
            signal,
            stderrTail: this.stderrTail,
          },
        },
      )
      this.activeHwAccel = null
      this.spawnAttempt(onLive, onDead)
      return
    }

    this.consecutiveFailures += 1
    const maxRestarts = this.opts.maxRestarts ?? 0
    if (this.consecutiveFailures > maxRestarts || this.stopped) {
      const reason = `ffmpeg ${this.opts.role} gave up after ${this.consecutiveFailures} attempt(s) (${classification}, code=${code} signal=${signal})`
      this.opts.logger.error(reason, {
        tags: this.logTags,
        meta: { stderrTail: this.stderrTail },
      })
      const error = new Error(reason)
      // Both: `onDead` is the start() promise, which only matters if the child
      // never went live; `onGiveUp` is what an owner watching a long-running
      // child hears. Rejecting an already-settled promise is a no-op, so the
      // two cannot be collapsed.
      onDead(error)
      this.opts.onGiveUp?.(error)
      return
    }
    this.scheduleRestart(onLive, onDead)
  }

  private scheduleRestart(onLive: () => void, onDead: (err: Error) => void): void {
    if (this.stopped) return
    const maxRestarts = this.opts.maxRestarts ?? 0
    if (maxRestarts === 0) {
      // A run-to-completion child that went LIVE and then died lands here, and
      // used to return in silence: no counter, no error, no callback. The owner
      // learned about it only through `onExit`, which also fires for exits that
      // are about to be respawned — so an owner could not tell "gone for good"
      // from "back in a second" without duplicating this class's bookkeeping.
      this.opts.onGiveUp?.(new Error(`ffmpeg ${this.opts.role} ended and restarts are disabled`))
      return
    }
    // A child that ran a long time before dying is not a restart LOOP — reset
    // the counter so a nightly camera reboot never exhausts the budget.
    if (
      this.producedOutput &&
      this.now - this.startedAtMs >= (this.opts.stableRunMs ?? DEFAULT_STABLE_RUN_MS)
    ) {
      this.consecutiveFailures = 0
    }
    if (this.consecutiveFailures > maxRestarts) return
    const setTimeoutImpl = this.opts.setTimeoutFn ?? setTimeout
    const delay =
      (this.opts.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS) *
      Math.min(this.consecutiveFailures + 1, 8)
    setTimeoutImpl(() => {
      if (this.stopped) return
      this.spawnAttempt(onLive, onDead)
    }, delay)
  }

  private report(
    classification: FfmpegExitClass,
    code: number | null,
    signal: NodeJS.Signals | null,
    err?: unknown,
  ): void {
    const exit: FfmpegExit = {
      classification,
      code,
      signal,
      stderrTail: [...this.stderrTail],
      decodeHwAccel: this.activeHwAccel,
    }
    if (classification === 'crashed' || classification === 'no-output') {
      this.opts.logger.warn(`ffmpeg ${this.opts.role} exited: ${classification}`, {
        tags: this.logTags,
        meta: {
          code,
          signal,
          decodeHwAccel: this.activeHwAccel ?? 'software',
          error: err instanceof Error ? err.message : err === undefined ? undefined : String(err),
          stderrTail: exit.stderrTail,
        },
      })
    }
    this.opts.onExit?.(exit)
  }

  private clearFirstDataTimer(): void {
    if (this.firstDataTimer !== null) {
      clearTimeout(this.firstDataTimer)
      this.firstDataTimer = null
    }
  }

  /** Terminate for good. Idempotent; no restart follows. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearFirstDataTimer()
    this.killChild()
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (!child) return
    // Gate on the child not having ALREADY exited — `child.killed` is false
    // for a process that exited on its own, and signalling a reaped pid throws.
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill('SIGTERM')
    } catch {
      return
    }
    const setTimeoutImpl = this.opts.setTimeoutFn ?? setTimeout
    const grace = setTimeoutImpl(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
    if (typeof grace === 'object' && grace !== null && 'unref' in grace) {
      grace.unref()
    }
  }
}
