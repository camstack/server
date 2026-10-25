/**
 * SharedInferencePool — TypeScript wrapper for inference_pool.py.
 *
 * Multi-process orchestrator. Owns N `PoolWorker` instances, each
 * holding its own Python subprocess + MLModel copy, and round-robins
 * inference dispatches across them. Model management (load/unload/
 * replace) propagates to all workers so every subprocess holds the
 * same model set at the same indices.
 *
 * Wire format (per worker):
 *   Request:  [4B total_len][4B req_id][1B msg_type][payload]
 *   Response: [4B total_len][4B req_id][JSON payload]
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  EngineOutput,
  IInferenceEngine,
  InferenceInput,
  IScopedLogger,
  PoolModelConfig,
  RawFrameFormat,
} from '@camstack/types'
import { edgetpuDelegateDevice } from '@camstack/types'
import type { PoolDecodeSettings } from './pool-decode-settings.js'
import {
  chargesDeviceBudget,
  InferStallDetector,
  POOL_MODEL_LOAD_BOUNDS,
  POOL_MODEL_LOAD_REPLY_MARGIN_MS,
  type PoolDeathCause,
  type PoolPoisonReason,
  type PoolRuntime,
} from './pool-worker-health.js'

export {
  POOL_MODEL_LOAD_BOUNDS,
  type ModelLoadBounds,
  type PoolDeathCause,
  type PoolPoisonReason,
} from './pool-worker-health.js'

// ── Wire-protocol constants ────────────────────────────────────────────────

const MSG_COMMAND = 0x00
const MSG_INFER_JPEG = 0x01
const MSG_INFER_RAW = 0x02
const MSG_CACHE_FRAME = 0x04
const MSG_INFER_CACHED = 0x05
/**
 * Cross-camera batching opcode — N items packed into a single IPC
 * frame. Wire shape:
 *   [1B model_idx][1B count][N × (4B w | 4B h | 1B fmt | 4B size | raw bytes)]
 * Python pool dispatches each item via `dispatcher.run` (asyncio.gather)
 * and returns a JSON array of detections in the same order.
 */
const MSG_INFER_BATCH = 0x03

const PREFIX_LEN = 4 + 4 + 1 // total_len + req_id + msg_type

/**
 * Wire-protocol version this host implements, declared in the startup config
 * and NEGOTIATED per worker (D350): the effective version is
 * `min(ours, theirs)`, so a worker and a host at different versions — the
 * NORMAL state during a rolling deploy on this cluster, since framework code
 * ships in the `@camstack/server` closure and addons ship separately — always
 * agree on the layout without either side guessing.
 *
 *   v1 — the historical layout. No deadline on the wire; an abandoned request
 *        still executes in Python and its late reply is discarded
 *        (`Response for unknown request id`). On 2026-09-04 that dead work
 *        pinned the accelerator for 4h15m (16 146 timeouts, goodput ~0).
 *   v2 — every SHEDDABLE request payload is prefixed with the request's
 *        ABSOLUTE deadline (8B epoch-ms uint64 LE); the Python worker checks
 *        it immediately before predict and answers
 *        `{dropped: true, shedReason: 'deadline-expired'}` instead of running
 *        work nobody will read. Commands / model loads / cacheFrame keep the
 *        v1 layout at every version — a shed command desynchronizes model
 *        state.
 */
export const POOL_PROTOCOL_VERSION = 2

/** Bytes of the absolute-deadline prefix a v2 sheddable payload carries. */
const DEADLINE_PREFIX_LEN = 8

/**
 * Wire-level enum for the raw-frame fast path. Values are append-only:
 * the Python pool reads the byte directly off the IPC frame; reordering
 * existing entries breaks all in-flight workers.
 */
const RAW_FMT_CODE: Record<RawFrameFormat, number> = {
  rgb: 0x00,
  bgr: 0x01,
  gray: 0x02,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PendingResolve = (value: Record<string, unknown>) => void
type PendingReject = (reason: Error) => void

interface PendingRequest {
  readonly resolve: PendingResolve
  readonly reject: PendingReject
  /**
   * Watchdog timer for an inference request. A live worker that never replies
   * to a specific request (Python-side deadlock / silently-dropped frame)
   * would otherwise wedge the awaiting caller forever — `rejectAll` only fires
   * when the worker PROCESS exits/errors. The `ready` handshake carries its own
   * separate timeout and leaves this undefined.
   */
  readonly timer?: ReturnType<typeof setTimeout>
  /** What this request was, when it is a COMMAND — so a timeout or a
   *  poisoning can name the load it was waiting on (D653). */
  readonly command?: PoolCommandDescriptor
  /** A live (sheddable) inference request — its outcome feeds the stall detector. */
  readonly live?: boolean
}

/** A pending command, described for the lines that must name it. */
export interface PoolCommandDescriptor {
  readonly cmd: string
  /** The model slot the command addresses, when it addresses one. */
  readonly modelIndex: number | null
  /** The model's file stem (`camstack-yunet-2023mar`), when the command carries one. */
  readonly model: string | null
}

/**
 * A load the worker answered with a machine-readable failure class. The
 * provider tells a `compile-timeout` (counted against THAT MODEL on the
 * device) from an ordinary failure by `reason`, never by parsing text.
 */
export class PoolModelLoadError extends Error {
  readonly reason: string | null
  /** The model's file stem, as the worker named it. */
  readonly model: string | null

  constructor(message: string, reason: string | null, model: string | null) {
    super(message)
    this.name = 'PoolModelLoadError'
    this.reason = reason
    this.model = model
  }
}

/** A load that compiled past its soft bound and is still running (D653). */
interface AbandonedCompile {
  readonly command: PoolCommandDescriptor
  readonly since: number
  readonly hardTimer: ReturnType<typeof setTimeout>
}

/**
 * Request id the worker uses for UNSOLICITED events — a reply to no request
 * (`compile-finished-late`). Never allocated to a request.
 */
const WORKER_EVENT_REQ_ID = 0xffffffff

interface PoisonVerdict {
  readonly reason: PoolPoisonReason
  readonly command: PoolCommandDescriptor
  readonly detail: string
  readonly pid: number | null
}

/** Per-request dispatch options. */
interface DispatchOptions {
  /** The camera, purely for the failure line's tag (see InferenceInput.deviceId). */
  readonly deviceId?: number
  readonly command?: PoolCommandDescriptor
  /** Overrides the deadline {@link PoolWorker.deadlineFor} would pick. */
  readonly timeoutMs?: number
  /** This request IS the liveness probe: its own timeout must not start another. */
  readonly probe?: boolean
}

/**
 * Per-inference-request reply timeout (ms). Turns a wedged request (worker
 * alive but no reply) into a rejection so every caller settles — runtime frame
 * dispatch drops the frame; the benchmark full-tree run rejects the wedged
 * child (its enclosing try/catch keeps the root detections) instead of hanging
 * the UI on "loading" forever. Generous so legitimate slow inference (cold JIT,
 * large frame) never trips; override via env for constrained hardware.
 */
const POOL_INFER_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env['CAMSTACK_POOL_INFER_TIMEOUT_MS']) || 60_000,
)

/** Commands that compile a model — the only ones that get the load deadline. */
const MODEL_LOAD_COMMANDS: ReadonlySet<string> = new Set(['load', 'replace'])

/**
 * Deadline of the liveness probe (`mem_stats`) sent after a command times out.
 * The worker answers `mem_stats` on its event loop, never behind a compile
 * (D653), so a healthy worker replies in milliseconds even mid-compile; ten
 * seconds only has to outlast a GC pause or a burst of inference replies.
 */
const POOL_LIVENESS_PROBE_TIMEOUT_MS = 10_000

/**
 * How long a poisoned worker may keep its in-flight LIVE requests before it is
 * killed anyway. A poisoned worker takes no new work, and every live request
 * carries a {@link POOL_LIVE_INFER_TIMEOUT_MS} deadline, so the drain is over
 * by then; the second of slack keeps the backstop from racing the last reply.
 */
const POOL_POISON_DRAIN_SLACK_MS = 1_000

/**
 * Max inference requests outstanding to ONE worker before new ones are SHED.
 *
 * Without this the camera dies permanently the first time the worker gets
 * slow, and it did: device 101 produced nothing for 52 minutes on 2026-07-31.
 * The worker was neither dead nor deadlocked — it was replying at full rate,
 * about a minute behind, and every reply landed after {@link
 * POOL_INFER_TIMEOUT_MS} had already abandoned its request. The proof is in the
 * logs: a steady drip of `Response for unknown request id`, request ids
 * climbing ~13/s, for as long as the outage lasted.
 *
 * That state is self-sustaining and cannot drain, because frames keep arriving
 * while every one of them is written straight to the pipe. `dispatch` had NO
 * bound: a transient slowdown (inference went 40ms → 2500ms across several
 * cameras at 16:19 that day) buys a backlog that is never paid off, and once
 * the backlog exceeds the deadline the loss is total.
 *
 * The queue is therefore capped in TIME, not just in count: at the normal ~40ms
 * per inference this is ~0.3s of work, and even at a 20× slowdown it stays well
 * inside the 60s deadline — so a worker that falls behind sheds, catches up,
 * and recovers on its own. Python already sheds under its own per-model bound
 * and answers `{dropped: true}`; this is the same contract applied one layer
 * earlier, where the unbounded queue actually is.
 */
const POOL_MAX_IN_FLIGHT = Math.max(1, Number(process.env['CAMSTACK_POOL_MAX_IN_FLIGHT']) || 8)

/**
 * Reply deadline for a LIVE inference request (ms), as opposed to the generous
 * {@link POOL_INFER_TIMEOUT_MS} that model loads and commands keep.
 *
 * 60 seconds was never a deadline for live detection — it is three orders of
 * magnitude past the point where the answer is worth having. Frames arrive at
 * ~13/s; a detection that lands 60s late describes a scene that no longer
 * exists, and the only thing the wait accomplished was holding a queue slot
 * while the backlog grew. Operator directive 2026-07-31: "a few seconds are
 * already too many for this scenario".
 *
 * Three seconds is deliberately still loose — normal inference on this fleet is
 * 35-47ms, so this trips only at a ~70× slowdown — but it bounds the damage at
 * seconds instead of a minute, and combined with {@link POOL_MAX_IN_FLIGHT} it
 * makes the backlog mathematically unable to outrun the deadline: the queue can
 * never hold more than `cap × deadline` of work.
 *
 * Commands and model loads keep the long timeout on purpose: a cold model load
 * legitimately takes tens of seconds, and shedding or timing one out
 * desynchronizes the worker's model slots.
 */
const POOL_LIVE_INFER_TIMEOUT_MS = Math.max(
  250,
  Number(process.env['CAMSTACK_POOL_LIVE_INFER_TIMEOUT_MS']) || 3_000,
)

/** Opcodes the in-flight cap may shed. Commands and frame-cache writes are
 *  NEVER shed: a dropped command silently desynchronizes model state, and a
 *  dropped `cacheFrame` strands the `inferCached` that follows it. */
const SHEDDABLE_MSG_TYPES: ReadonlySet<number> = new Set([
  MSG_INFER_JPEG,
  MSG_INFER_RAW,
  MSG_INFER_BATCH,
  MSG_INFER_CACHED,
])

interface CommandResponse {
  readonly cmd: string
  readonly status: string
  readonly index?: number
  readonly loadMs?: number
  readonly error?: string
  /** Machine-readable failure class (`compile-timeout`, `worker-poisoned`). */
  readonly reason?: string
  /** The model's file stem, when the worker named it. */
  readonly modelId?: string
  readonly models?: readonly {
    index: number
    path: string | null
    loaded: boolean
    postprocessor: string | null
  }[]
}

/** One worker's `mem_stats` reply (or the reason it is missing). */
export interface PoolWorkerMemStats {
  readonly worker: string
  readonly pid: number | null
  readonly stats: Record<string, unknown> | null
  readonly error: string | null
}

export interface ModelSlotStatus {
  readonly index: number
  readonly path: string | null
  readonly loaded: boolean
  readonly postprocessor: string | null
}

export type PoolBatchMode = 'none' | 'list' | 'window'

export interface PoolTuning {
  readonly batchMode: PoolBatchMode
  readonly windowMs: number
  readonly maxBatchSize: number
  readonly numStreams: number
  readonly intraOpThreads: number
}

export interface SharedInferencePoolOptions {
  /** Worker concurrency — only meaningful for onnxruntime (thread pool size). */
  readonly concurrency?: number
  /** Per-runtime batch dispatch tuning forwarded to the Python pool startup. */
  readonly tuning?: PoolTuning
  /**
   * Number of independent Python subprocess workers. Each worker
   * owns its own MLModel copy and an independent ANE/GPU/CPU
   * dispatch context. Inference round-robins across workers; model
   * management commands propagate to all. Default 1 (legacy
   * single-process behaviour).
   */
  readonly numWorkers?: number
  /**
   * Pool-level device selector, forwarded to the Python pool startup. Currently
   * only meaningful for `edgetpu`: the libedgetpu delegate is created ONCE at
   * pool init (a Coral is a single hardware context), so the specific unit
   * (`usb`, `usb:1`, …) must be known BEFORE the first model load — it can't
   * ride the per-model config. Omitted ⇒ the runtime's own default device.
   */
  readonly device?: string
  /**
   * A compile that outlived its soft bound came back (D653). The owner uses it
   * to lift its negative cache: the model is loadable again, and warm.
   */
  readonly onCompileFinishedLate?: (event: PoolCompileFinishedLate) => void
}

// ---------------------------------------------------------------------------
// Pool handle — implements IInferenceEngine for a single model slot
// ---------------------------------------------------------------------------

class PoolHandle implements IInferenceEngine {
  readonly runtime = 'onnx' as const // interface-only; the pool's own runtime is authoritative
  readonly device = 'cpu' as const

  constructor(
    private readonly pool: SharedInferencePool,
    private readonly modelIndex: number,
  ) {}

  async infer(input: InferenceInput): Promise<EngineOutput> {
    const start = performance.now()
    // `input.deviceId` is carried down purely so a pool-side failure line can
    // name the camera (see InferenceInput.deviceId) — it selects nothing.
    const result =
      input.kind === 'raw'
        ? await this.pool.inferRaw(
            this.modelIndex,
            input.data,
            input.width,
            input.height,
            input.format,
            input.deviceId,
          )
        : await this.pool.infer(this.modelIndex, input.data, input.deviceId)
    const elapsed = performance.now() - start
    return poolResultToEngineOutput(result, elapsed)
  }

  /**
   * Inference on a frame previously cached in the Python pool via
   * `pool.cacheFrame()`. Sends only 5 bytes through the pipe instead
   * of 1.2MB raw data — eliminates the pipe transfer bottleneck.
   */
  async inferFromCache(frameId: number): Promise<EngineOutput> {
    const start = performance.now()
    const result = await this.pool.inferCached(this.modelIndex, frameId)
    const elapsed = performance.now() - start
    return poolResultToEngineOutput(result, elapsed)
  }

  async dispose(): Promise<void> {
    // Handles don't own the pool — disposal is a no-op.
  }
}

/**
 * Map a raw pool response record to an {@link EngineOutput}.
 *
 * An overload shed (`{dropped: true}` — from the Python pool's per-model bound
 * OR the TS worker in-flight cap, which deliberately mirrors it) becomes a
 * first-class `EngineOutput.dropped` with NO `structured` payload. Before this
 * mapping the shed record rode through as `structured`, failed the StepOutput
 * kind guard in the postprocess funnel, and every deliberate shed was logged
 * as `runInference failed … unexpected kind: undefined` at error level on
 * every node (~4/s cluster-wide, 2026-08-01). A shed is flow control, not a
 * fault — it must never reach a postprocessor. Exported for tests.
 */
export function poolResultToEngineOutput(
  result: Record<string, unknown>,
  inferenceMs: number,
): EngineOutput {
  if (result['dropped'] === true) {
    const shedReason = result['shedReason']
    return {
      dropped: true,
      ...(typeof shedReason === 'string' ? { shedReason } : {}),
      inferenceMs,
    }
  }
  return { structured: result, inferenceMs }
}

// ---------------------------------------------------------------------------
// Forceful child teardown
// ---------------------------------------------------------------------------

/**
 * How long to wait for a worker to exit on SIGTERM before escalating to
 * SIGKILL. A worker idle between frames exits well under this; only a worker
 * stuck in a native inference call (openvino/onnx C++) needs the escalation.
 */
const POOL_WORKER_TERM_GRACE_MS = 2000

/**
 * Sampling stride for the "Python pool shed frame under overload" debug
 * line — see `trackDroppedResponse`. At the observed chronic-overload rate
 * (~13 shed/s, 2026-08-01) a stride of 500 yields roughly one line every
 * 40 s while `droppedTotal` in the line keeps the exact count.
 */
const SHED_LOG_SAMPLE_EVERY = 500

/**
 * Terminate a spawned child GRACEFULLY THEN FORCEFULLY: end stdin, send
 * SIGTERM, and if the process hasn't exited within `graceMs`, send SIGKILL.
 * Resolves once the process has exited (or was already dead).
 *
 * The old teardown sent SIGTERM and dropped the reference immediately — a
 * worker busy in a native inference loop ignores SIGTERM and ORPHANS at full
 * CPU (observed after an engine re-spin). SIGKILL cannot be ignored, so the
 * escalation guarantees the process dies. Exported for tests.
 */
export async function terminateChild(proc: ChildProcess, graceMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    proc.stdin?.end()
  } catch {
    /* pipe already closed */
  }
  await new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    proc.once('exit', done)
    try {
      proc.kill('SIGTERM')
    } catch {
      // Already gone between the guard and here.
      done()
      return
    }
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* raced with a natural exit */
      }
      // The 'exit' listener resolves once the kernel reaps it; resolve here too
      // as a backstop so a never-firing exit can't wedge the re-spin.
      done()
    }, graceMs)
  })
}

/**
 * How long a POISONED worker is given to write its stack after SIGUSR1,
 * before SIGTERM. `faulthandler` writes from a C signal handler, so a dump
 * takes milliseconds even while a native call holds the GIL; the bound is
 * there for the worker that cannot answer at all. Never more than ~2 s: the
 * recycle it delays is the one that hands the device back to the budget.
 */
export const POOL_STACK_DUMP_WAIT_MS = 1500

/** What a stack-dump request did. */
export type StackDumpOutcome =
  /** SIGUSR1 sent; the wait elapsed (or the worker exited). */
  | 'signalled'
  /** No SIGUSR1 on this platform (Windows). */
  | 'unsupported'
  /** The worker was already gone. */
  | 'already-exited'
  /** `kill` threw (it raced with an exit). */
  | 'signal-failed'

/** The slice of a child process a stack-dump request touches. */
export interface StackDumpTarget {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  kill(signal: NodeJS.Signals): boolean
  once(event: 'exit', listener: () => void): unknown
  removeListener(event: 'exit', listener: () => void): unknown
}

/**
 * Ask a hung worker for every thread's Python stack (SIGUSR1, registered by
 * the pool with `faulthandler` → its stderr, which the host logs under the
 * worker label), then wait up to `waitMs` — or until it exits — so the dump
 * is written before the caller terminates it. Exported for tests.
 */
export async function requestStackDump(
  proc: StackDumpTarget,
  waitMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<StackDumpOutcome> {
  if (platform === 'win32') return 'unsupported'
  if (proc.exitCode !== null || proc.signalCode !== null) return 'already-exited'
  try {
    proc.kill('SIGUSR1')
  } catch {
    return 'signal-failed'
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      proc.removeListener('exit', done)
      resolve()
    }
    const timer = setTimeout(done, waitMs)
    proc.once('exit', done)
  })
  return 'signalled'
}

// ---------------------------------------------------------------------------
// PoolWorker — single Python subprocess (private to this module)
// ---------------------------------------------------------------------------

/** The worker's `compile-finished-late` event, as the pool's owner sees it. */
export interface PoolCompileFinishedLate {
  /** The model's file stem, when the worker named it. */
  readonly model: string | null
  readonly ok: boolean
  /** Why the late compile failed, when it did. */
  readonly error?: string
}

interface PoolWorkerOptions {
  readonly pythonPath: string
  readonly scriptPath: string
  readonly poolRuntime: PoolRuntime
  readonly concurrency: number
  readonly tuning: PoolTuning | null
  readonly logger: IScopedLogger
  readonly workerLabel: string
  readonly device?: string
  readonly onCompileFinishedLate?: (event: PoolCompileFinishedLate) => void
}

class PoolWorker {
  private process: ChildProcess | null = null
  private receiveBuffer: Buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  /** True while the in-flight cap is shedding — so the warning fires on the
   *  EDGE rather than once per dropped frame. */
  private shedding = false
  /** Inference requests shed by the in-flight cap, for this worker's lifetime.
   *  Surfaced so "the camera is quiet" and "the camera is saturated" can be
   *  told apart without reading the logs. */
  private shedCount = 0
  /** Requests that hit their client-side deadline (`inference request timed out`). */
  private timedOutCount = 0

  /**
   * Live requests whose deadline fired IN FLIGHT and were answered dropped by
   * the local watchdog (the worker never replied in time). With a v2 worker
   * this is the rare backstop — the worker sheds expired work itself and
   * replies fast; against a v1 worker it is the only shed there is.
   */
  private deadlineShedCount = 0
  /**
   * Negotiated wire version for THIS worker: `min(POOL_PROTOCOL_VERSION,
   * what the ready handshake reported)`. A worker that reports nothing is a
   * v1 worker and keeps receiving the byte-identical old layout — the deploy
   * skew case that must always work (D350).
   */
  private wireVersion = 1
  private nextRequestId = 1
  private ready = false
  /** Set once this worker is declared unusable while ALIVE (D653). Never cleared:
   *  a poisoned worker is recycled, not revived. */
  private poisonVerdict: PoisonVerdict | null = null
  /** The kill of a poisoned worker has been started. */
  private recycling = false
  /** Kills a poisoned worker whose drain did not finish in time. */
  private recycleBackstop: ReturnType<typeof setTimeout> | null = null
  /** A liveness probe is in flight — one at a time, never a probe storm. */
  private probeInFlight = false
  /** The child has exited (any cause). */
  private exited = false
  /** A compile past its soft bound, still running in the worker (D653). */
  private abandonedCompile: AbandonedCompile | null = null
  /** Says when live inference has produced nothing for too long (D653). */
  private readonly inferStall = new InferStallDetector(Date.now())
  /**
   * A load's HOST deadline expired with no reply since the last reply of any
   * kind (D653 round 3): the loop missed its own soft bound, so the GIL grace
   * is over for this worker until something — anything — comes back.
   */
  private loadDeadlineMissed = false
  private readonly log: IScopedLogger
  private readonly opts: PoolWorkerOptions

  constructor(opts: PoolWorkerOptions) {
    this.opts = opts
    this.log = opts.logger
  }

  getPid(): number | null {
    return this.process?.pid ?? null
  }

  /** Requests written and not yet answered. This is the BACKLOG — the number
   *  nothing measured while a camera sat at zero frames for 52 minutes. */
  getInFlight(): number {
    return this.pending.size
  }

  /** Inference shed by the in-flight cap over this worker's lifetime. */
  getShedCount(): number {
    return this.shedCount
  }

  getTimedOutCount(): number {
    return this.timedOutCount
  }

  isReady(): boolean {
    return this.ready
  }

  /** Why this worker was recycled, typed for the provider's budget, or `null`. */
  getDeathCause(): PoolDeathCause | null {
    const v = this.poisonVerdict
    const message = this.getPoisonDescription()
    if (v === null || message === null) return null
    return { reason: v.reason, chargesDeviceBudget: chargesDeviceBudget(v.reason), message }
  }

  /** Why this live worker was declared unusable, or `null` (D653). */
  getPoisonDescription(): string | null {
    const v = this.poisonVerdict
    if (v === null) return null
    const target = v.command.model !== null ? ` of ${v.command.model}` : ''
    return `${v.reason} on ${v.command.cmd}${target} (pid ${v.pid ?? 'unknown'})`
  }

  async initialize(
    initialModels: readonly PoolModelConfig[],
  ): Promise<{ startupMs: number; loadedCount: number; workers: number }> {
    this.process = spawn(this.opts.pythonPath, [this.opts.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('PoolWorker: failed to create process pipes')
    }

    this.process.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim()
        if (trimmed) this.log.warn(`[${this.opts.workerLabel}] ${trimmed}`)
      }
    })

    this.process.on('error', (err) => {
      this.log.error('Worker process error', {
        meta: { worker: this.opts.workerLabel, error: err.message },
      })
      this.rejectAll(err)
    })

    // A death by SIGNAL arrives as `code === null` — and the old guard
    // (`code !== 0 && code !== null`) treated exactly that case as nothing to
    // report. It is not nothing: it is how this worker actually dies. On
    // 2026-08-25 the openvino:gpu worker was SIGABRT'd by glibc
    // (`*** longjmp causes uninitialized stack frame ***`) 1.3s after `Pool
    // ready`, while compiling `yolov9m-320-int8` for the Intel GPU. Node saw
    // `code=null, signal=SIGABRT`, this branch logged NOTHING, `rejectAll` did
    // not run, and the in-flight model load hung until the 60s command
    // deadline reported "worker alive, no reply" — about a process that had
    // been dead for a minute. Every frame after that was answered
    // `PoolWorker[w0]: not initialized` for 31 hours: ~370k ERROR lines, and
    // the only line that could have named the cause was the one suppressed
    // here.
    //
    // A deliberate `dispose()` nulls `this.process` BEFORE terminating the
    // child, so the SIGTERM it sends is not reported as a fault.
    const spawnedProcess = this.process
    spawnedProcess.on('exit', (code, signal) => {
      this.ready = false
      this.exited = true
      if (this.recycleBackstop) clearTimeout(this.recycleBackstop)
      if (this.abandonedCompile) clearTimeout(this.abandonedCompile.hardTimer)
      if (this.process !== spawnedProcess) return // deliberate dispose — expected
      // A POISONED worker is killed by this host on purpose, and still reported
      // here: this line and `rejectAll` are the ordinary death path the
      // provider's restart budget already counts (D653). `poisonedBy` is what
      // separates "we killed it because it hung" from "it crashed".
      const poisonedBy = this.getPoisonDescription()
      this.log.error('Worker process exited', {
        meta: {
          worker: this.opts.workerLabel,
          pid: spawnedProcess.pid ?? null,
          runtime: this.opts.poolRuntime,
          device: this.opts.device ?? 'default',
          code,
          signal,
          inFlight: this.pending.size,
          ...(poisonedBy !== null ? { poisonedBy } : {}),
        },
      })
      this.rejectAll(
        new Error(
          `PoolWorker[${this.opts.workerLabel}]: worker process exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})` +
            (poisonedBy !== null ? ` — recycled, poisoned by ${poisonedBy}` : ''),
        ),
      )
    })

    this.process.stdout.on('data', (chunk: Buffer) => {
      // Measured, not assumed. The 2026-08-02 stall monitor proved the freeze
      // is a SYNCHRONOUS block (gcMs 0-1 inside a 2.5-4s stall, 34MB heap), and
      // this handler is the prime suspect: `Buffer.concat` per chunk is O(n²)
      // in the response size, so one large reply copies gigabytes across the
      // ~64KB chunks it arrives in. That is a hypothesis until these numbers
      // say so — a big `peakBufferKb` with a big `concatMs` confirms it; a
      // small one exonerates this path and moves the search elsewhere.
      const t0 = Date.now()
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])
      this.recvConcatMs += Date.now() - t0
      if (this.receiveBuffer.length > this.recvPeakBytes) {
        this.recvPeakBytes = this.receiveBuffer.length
      }
      this.drainResponses()
      this.reportRecvCostIfDue()
    })

    const config: Record<string, unknown> = {
      runtime: this.opts.poolRuntime,
      concurrency: this.opts.concurrency,
      // Declare what this host CAN speak; what it WILL speak to this worker is
      // decided by the ready reply below (min of both). An old worker ignores
      // the unknown key.
      protocolVersion: POOL_PROTOCOL_VERSION,
      // The worker's own bound on one model load (D653). Declared, not assumed,
      // so the reply deadline below can never be shorter than it.
      modelLoadTimeoutMs: POOL_MODEL_LOAD_BOUNDS[this.opts.poolRuntime].softMs,
      models: initialModels.map((m) => serializeModelConfig(m)),
    }
    if (this.opts.device) {
      // An edgetpu pool opens its delegate on the EXPLICIT unit (`usb:0`,
      // `pci:1`, …): a bare `usb`/`pci` lets libedgetpu take the first Edge TPU
      // of any bus, so two pools on a USB+PCIe node could open the same one.
      config['device'] =
        this.opts.poolRuntime === 'edgetpu'
          ? edgetpuDelegateDevice(this.opts.device)
          : this.opts.device
    }
    if (this.opts.tuning) {
      config['batch_mode'] = this.opts.tuning.batchMode
      config['window_ms'] = this.opts.tuning.windowMs
      config['max_batch_size'] = this.opts.tuning.maxBatchSize
      config['num_streams'] = this.opts.tuning.numStreams
      config['intra_op_threads'] = this.opts.tuning.intraOpThreads
    }
    const configBuf = Buffer.from(JSON.stringify(config), 'utf8')
    this.writeFrame(0, MSG_COMMAND, configBuf)

    return new Promise<{ startupMs: number; loadedCount: number; workers: number }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(0)
          reject(
            new Error(`PoolWorker[${this.opts.workerLabel}]: timeout waiting for ready (120s)`),
          )
        }, 120_000)

        this.pending.set(0, {
          resolve: (result) => {
            clearTimeout(timeout)
            if (result['status'] === 'ready') {
              this.ready = true
              // Spawn time is not silence (D653 round 2).
              this.inferStall.noteResult(Date.now())
              const loadedCount = result['models'] as number
              const startupMs = result['startupMs'] as number
              const workers = (result['workers'] as number | undefined) ?? 1
              // Version negotiation: a worker that reports no protocolVersion
              // is a v1 worker (pre-deadline layout). min() also caps a
              // FUTURE worker at what this host can actually speak.
              const reported = result['protocolVersion']
              this.wireVersion = Math.min(
                POOL_PROTOCOL_VERSION,
                typeof reported === 'number' && Number.isFinite(reported) ? reported : 1,
              )
              resolve({ startupMs, loadedCount, workers })
            } else {
              reject(new Error(`Unexpected pool status: ${JSON.stringify(result)}`))
            }
          },
          reject: (err) => {
            clearTimeout(timeout)
            reject(err)
          },
        })
      },
    )
  }

  async infer(
    modelByte: number,
    jpeg: Buffer,
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    this.ensureReady()
    const payload = Buffer.concat([Buffer.from([modelByte]), jpeg])
    return this.dispatch(MSG_INFER_JPEG, payload, { deviceId })
  }

  async inferRaw(
    modelByte: number,
    raw: Buffer,
    width: number,
    height: number,
    format: RawFrameFormat,
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    this.ensureReady()
    const fmtCode = RAW_FMT_CODE[format]
    const rawHeader = Buffer.allocUnsafe(10)
    rawHeader[0] = modelByte
    rawHeader.writeUInt32LE(width, 1)
    rawHeader.writeUInt32LE(height, 5)
    rawHeader[9] = fmtCode
    return this.dispatchMulti(
      MSG_INFER_RAW,
      rawHeader.length + raw.length,
      [rawHeader, raw],
      deviceId,
    )
  }

  async inferBatch(
    modelByte: number,
    items: readonly {
      readonly raw: Buffer
      readonly width: number
      readonly height: number
      readonly format: RawFrameFormat
    }[],
    frameId = 0,
  ): Promise<readonly Record<string, unknown>[]> {
    this.ensureReady()
    if (items.length === 0) return []
    // Header: [1B modelByte][1B count][4B frameId]. A nonzero frameId tags
    // every item in the pool so `_preprocess` reuses the cached input tensor
    // (pure-inference benchmark); 0 = untagged (full preprocess, live default).
    const headerSize = 6 + items.length * 13
    const totalRawSize = items.reduce((sum, it) => sum + it.raw.length, 0)
    const payload = Buffer.allocUnsafe(headerSize + totalRawSize)
    payload[0] = modelByte
    payload[1] = items.length
    payload.writeUInt32LE(frameId >>> 0, 2)
    let offset = 6
    for (const item of items) {
      payload.writeUInt32LE(item.width, offset)
      payload.writeUInt32LE(item.height, offset + 4)
      payload[offset + 8] = RAW_FMT_CODE[item.format]
      payload.writeUInt32LE(item.raw.length, offset + 9)
      offset += 13
      item.raw.copy(payload, offset)
      offset += item.raw.length
    }
    const response = await this.dispatch(MSG_INFER_BATCH, payload)
    const results = response['results']
    if (!Array.isArray(results)) {
      throw new Error(`PoolWorker.inferBatch: malformed response: ${JSON.stringify(response)}`)
    }
    return results as readonly Record<string, unknown>[]
  }

  async cacheFrame(
    frameId: number,
    raw: Buffer,
    width: number,
    height: number,
    format: RawFrameFormat,
  ): Promise<void> {
    this.ensureReady()
    const fmtCode = RAW_FMT_CODE[format]
    const header = Buffer.allocUnsafe(13)
    header.writeUInt32LE(frameId, 0)
    header.writeUInt32LE(width, 4)
    header.writeUInt32LE(height, 8)
    header[12] = fmtCode
    const payloadLen = header.length + raw.length
    const result = await this.dispatchMulti(MSG_CACHE_FRAME, payloadLen, [header, raw])
    if (result['error']) throw new Error(String(result['error']))
  }

  async inferCached(
    modelByte: number,
    frameId: number,
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    this.ensureReady()
    const payload = Buffer.allocUnsafe(5)
    payload[0] = modelByte
    payload.writeUInt32LE(frameId, 1)
    return this.dispatch(MSG_INFER_CACHED, payload, { deviceId })
  }

  async sendCommand(cmd: Record<string, unknown>): Promise<CommandResponse> {
    this.ensureReady()
    const command = describeCommand(cmd)
    const payload = Buffer.from(JSON.stringify(cmd), 'utf8')
    const sentAt = Date.now()
    if (MODEL_LOAD_COMMANDS.has(command.cmd)) this.warnIfLoadQueued(command)
    const raw = await this.dispatch(MSG_COMMAND, payload, { command })
    // Load time is not silence either (D653 round 2): a live request that
    // waited behind a long load must not count the load as a stall. Reset
    // whatever the load's outcome — its reply proves the loop answers.
    if (MODEL_LOAD_COMMANDS.has(command.cmd)) this.inferStall.noteResult(Date.now())
    this.inspectCommandReply(raw, command, sentAt)
    return raw as unknown as CommandResponse // TECH-DEBT: worker JSON envelope validated in inspectCommandReply
  }

  /** Command whose reply shape is NOT the load/unload/replace/status envelope
   *  (e.g. `mem_stats`) — returns the raw JSON record, so no cast is needed
   *  at the call site. */
  async sendRawCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.ensureReady()
    const payload = Buffer.from(JSON.stringify(cmd), 'utf8')
    return this.dispatch(MSG_COMMAND, payload, { command: describeCommand(cmd) })
  }

  async dispose(): Promise<void> {
    const proc = this.process
    if (!proc) return
    this.process = null
    this.ready = false
    if (this.recycleBackstop) clearTimeout(this.recycleBackstop)
    if (this.abandonedCompile) clearTimeout(this.abandonedCompile.hardTimer)
    // Graceful-then-forceful: a worker busy in native inference ignores SIGTERM
    // and would orphan at full CPU on an engine re-spin. Escalate to SIGKILL.
    await terminateChild(proc, POOL_WORKER_TERM_GRACE_MS)
    // Nulling `this.process` above deliberately silences the `exit` handler (a
    // dispose is not a fault) — but that ALSO silences its `rejectAll`, so
    // before this line every request in flight when a pool was condemned sat
    // until its own per-request deadline (60 s for a command) and was then
    // reported against a process that no longer existed. A frame this pool
    // will never answer is rejected NOW, naming the reason.
    this.rejectAll(
      new Error(
        `PoolWorker[${this.opts.workerLabel}]: pool disposed while the request was in flight`,
      ),
    )
  }

  // ── Private — wire-level ──────────────────────────────────────────

  /**
   * Shed an inference request when the worker already has {@link
   * POOL_MAX_IN_FLIGHT} outstanding — the backlog is what turns a slow worker
   * into a dead camera. Returns the shed response, or `null` to proceed.
   *
   * A shed is LOUD the first time and then rate-limited: at frame rate this
   * fires ~13×/s, so logging every one would bury the signal it is meant to
   * raise — but logging none is how a camera went dark for 52 minutes looking
   * like a quiet afternoon.
   */
  private shedIfSaturated(msgType: number, deviceId?: number): Record<string, unknown> | null {
    if (!SHEDDABLE_MSG_TYPES.has(msgType)) return null
    if (this.pending.size < POOL_MAX_IN_FLIGHT) {
      this.shedding = false
      return null
    }
    if (!this.shedding) {
      this.shedding = true
      this.log.warn('worker saturated — shedding inference until it catches up', {
        // The camera whose frame hit the cap. The pool is shared, so without it
        // the line describes the pool and names no victim.
        ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
        meta: {
          worker: this.opts.workerLabel,
          pid: this.getPid(),
          runtime: this.opts.poolRuntime,
          device: this.opts.device ?? 'default',
          inFlight: this.pending.size,
          cap: POOL_MAX_IN_FLIGHT,
          deadlineMs: POOL_LIVE_INFER_TIMEOUT_MS,
        },
      })
    }
    this.shedCount++
    return { dropped: true, shedReason: 'worker-in-flight-cap' }
  }

  /** Live inference gets seconds; commands and model loads keep the long
   *  timeout — see {@link POOL_LIVE_INFER_TIMEOUT_MS}. */
  private deadlineFor(msgType: number, opts: DispatchOptions = {}): number {
    if (opts.timeoutMs !== undefined) return opts.timeoutMs
    if (SHEDDABLE_MSG_TYPES.has(msgType)) return POOL_LIVE_INFER_TIMEOUT_MS
    // A load gets the worker's own compile bound plus a margin (D653): the
    // worker then answers `compile-timeout` NAMING the model before this fires.
    if (opts.command !== undefined && MODEL_LOAD_COMMANDS.has(opts.command.cmd)) {
      return POOL_MODEL_LOAD_BOUNDS[this.opts.poolRuntime].softMs + POOL_MODEL_LOAD_REPLY_MARGIN_MS
    }
    return POOL_INFER_TIMEOUT_MS
  }

  /**
   * The request's ABSOLUTE deadline for the wire (D350), or `null` when this
   * request must not carry one: commands / model loads / cacheFrame at any
   * version, and EVERYTHING against a v1 worker — the old layout has no room
   * for the prefix, and a worker at a different version is the normal state
   * during a rolling deploy. The stamp is the same instant the local watchdog
   * arms, so "the TS side has abandoned this" and "the worker refuses to run
   * it" are one moment, not two clocks drifting apart.
   */
  private deadlineStamp(msgType: number): Buffer | null {
    if (this.wireVersion < 2 || !SHEDDABLE_MSG_TYPES.has(msgType)) return null
    const stamp = Buffer.allocUnsafe(DEADLINE_PREFIX_LEN)
    stamp.writeBigUInt64LE(BigInt(Date.now() + this.deadlineFor(msgType)), 0)
    return stamp
  }

  private dispatch(
    msgType: number,
    payload: Buffer,
    opts: DispatchOptions = {},
  ): Promise<Record<string, unknown>> {
    const shed = this.shedIfSaturated(msgType, opts.deviceId)
    if (shed) return Promise.resolve(shed)
    const reqId = this.allocRequestId()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = this.armRequestTimeout(reqId, msgType, resolve, reject, opts)
      this.pending.set(reqId, {
        resolve,
        reject,
        timer,
        ...(opts.command !== undefined ? { command: opts.command } : {}),
        ...(SHEDDABLE_MSG_TYPES.has(msgType) ? { live: true } : {}),
      })
      try {
        const stamp = this.deadlineStamp(msgType)
        this.writeFrame(reqId, msgType, stamp ? Buffer.concat([stamp, payload]) : payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Arm a watchdog for a still-pending request. `unref` so it never keeps the
   * event loop alive. The normal response + `rejectAll` paths clear it via
   * `PendingRequest.timer`.
   *
   * The two request classes settle DIFFERENTLY on expiry (D350):
   *
   * - A SHEDDABLE (live inference) request RESOLVES as a shed —
   *   `{dropped: true, shedReason: 'deadline-expired'}` — because at this
   *   point the answer is worthless whether or not it eventually arrives, and
   *   a shed is flow control the executor already handles. It fires only when
   *   the worker never replied at all: a v2 worker sheds expired work itself
   *   (fast reply, this timer is cleared), so this is the wedged-worker
   *   backstop and the v1-worker compatibility path. The 2026-09-04 storm
   *   logged this state 16 146 times at ERROR; the shed is logged sampled at
   *   WARN and counted (`getDeadlineExpiredShedCount`) instead.
   * - Anything else (commands, model loads) still REJECTS with the error the
   *   dashboards grep for — a lost command is a fault, not flow control.
   */
  private armRequestTimeout(
    reqId: number,
    msgType: number,
    resolve: PendingResolve,
    reject: PendingReject,
    opts: DispatchOptions = {},
  ): ReturnType<typeof setTimeout> {
    const { deviceId, command } = opts
    const timeoutMs = this.deadlineFor(msgType, opts)
    const timer = setTimeout(() => {
      if (this.pending.delete(reqId)) {
        if (SHEDDABLE_MSG_TYPES.has(msgType)) {
          this.deadlineShedCount++
          const total = this.deadlineShedCount
          if (total === 1 || total % SHED_LOG_SAMPLE_EVERY === 0) {
            // Same facts the old ERROR line carried (worker identity, pool
            // identity, backlog, the deadline that ACTUALLY fired, the
            // camera) — a drop that logs nothing is how the original
            // collapse ran for four hours.
            this.log.warn('live inference deadline expired in flight — answered dropped', {
              ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
              meta: {
                worker: this.opts.workerLabel,
                pid: this.getPid(),
                runtime: this.opts.poolRuntime,
                device: this.opts.device ?? 'default',
                inFlight: this.pending.size,
                reqId,
                timeoutMs,
                deadlineShedTotal: total,
                sampledEvery: SHED_LOG_SAMPLE_EVERY,
              },
            })
          }
          resolve({ dropped: true, shedReason: 'deadline-expired' })
          this.noteInferUnanswered()
          return
        }
        // COMMAND / MODEL-LOAD timeout — the only requests that still REJECT
        // here (D350). Everything a post-mortem needs, ON THE FAILURE LINE.
        //
        // `workerLabel` is the worker's INDEX IN ITS OWN POOL — every pool's
        // first worker is `w0`, so the label alone names nothing. Answering
        // "which worker, on which node, on which engine?" for the 2026-07-31
        // outage took three separate sources: the log prefix for the node, the
        // scope for the camera, and a pool-init line logged minutes later for
        // the runtime — and that last one only existed because a restart
        // re-emitted it. On a pool that had been up since boot the engine would
        // have been unknowable from the failure itself.
        //
        // `inFlight` is the one that changes the diagnosis: it separates one
        // stuck request from a worker drowning in backlog, which are different
        // faults with different remedies.
        //
        // `timeoutMs` is the deadline that ACTUALLY fired, not the constant —
        // until 2026-08-02 this line hard-coded `POOL_INFER_TIMEOUT_MS` while
        // the rejection text beside it said otherwise, and reconciling the two
        // numbers cost real time during the 08-01 collapse.
        //
        // `deviceId` stays in the spread for symmetry but a command belongs to
        // no camera, so this line carries no tag rather than a fabricated one.
        this.timedOutCount++
        this.log.error('inference request timed out', {
          ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          meta: {
            worker: this.opts.workerLabel,
            pid: this.getPid(),
            runtime: this.opts.poolRuntime,
            device: this.opts.device ?? 'default',
            inFlight: this.pending.size,
            reqId,
            timeoutMs,
            // WHICH command — a model load and a memory probe that time out
            // are different faults (D653).
            ...(command !== undefined
              ? { command: command.cmd, modelIndex: command.modelIndex, model: command.model }
              : {}),
          },
        })
        // The rejection message names `runtime:device` at the source so every
        // consumer that embeds it carries the pool identity. That lesson came
        // from the live-inference timeouts of the 2026-09-04 storm (46/1096
        // `runInference failed` lines named no accelerator, because the runner
        // only stamps `deviceKey` when the session ELECTED one); live requests
        // resolve as sheds now, but a model-load failure gets asked the exact
        // same "which accelerator?" question.
        const message = `PoolWorker[${this.opts.workerLabel}]: inference request ${reqId} timed out after ${timeoutMs}ms on ${this.opts.poolRuntime}:${this.opts.device ?? 'default'} (worker alive, no reply)`
        if (command !== undefined && MODEL_LOAD_COMMANDS.has(command.cmd)) {
          // A LOAD whose host deadline expired: the worker did not even answer
          // at its own soft bound. That is a compile timeout of THIS model
          // (D653 round 3) — counted against it by name, like one the worker
          // reported — and it ends the GIL grace for this worker.
          this.loadDeadlineMissed = true
          reject(
            new PoolModelLoadError(`compile-timeout: ${message}`, 'compile-timeout', command.model),
          )
        } else {
          reject(new Error(message))
        }
        // One command timing out is not yet a verdict — ask the worker whether
        // its loop still answers (D653). The probe's own timeout is judged by
        // the probe's caller, never by starting another probe.
        if (opts.probe !== true && command !== undefined) this.probeLiveness(command)
      }
    }, timeoutMs)
    timer.unref?.()
    return timer
  }

  private dispatchMulti(
    msgType: number,
    payloadLen: number,
    parts: readonly Buffer[],
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    const shed = this.shedIfSaturated(msgType, deviceId)
    if (shed) return Promise.resolve(shed)
    const reqId = this.allocRequestId()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = this.armRequestTimeout(reqId, msgType, resolve, reject, { deviceId })
      this.pending.set(reqId, {
        resolve,
        reject,
        timer,
        ...(SHEDDABLE_MSG_TYPES.has(msgType) ? { live: true } : {}),
      })
      try {
        if (!this.process?.stdin) throw new Error('PoolWorker: not initialized')
        const stamp = this.deadlineStamp(msgType)
        const wireLen = payloadLen + (stamp ? DEADLINE_PREFIX_LEN : 0)
        const prefix = Buffer.allocUnsafe(PREFIX_LEN)
        prefix.writeUInt32LE(4 + 1 + wireLen, 0)
        prefix.writeUInt32LE(reqId, 4)
        prefix[8] = msgType
        this.process.stdin.write(prefix)
        if (stamp) this.process.stdin.write(stamp)
        for (const part of parts) {
          this.process.stdin.write(part)
        }
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private allocRequestId(): number {
    // The top id is the worker's event channel and is never allocated.
    let id = this.nextRequestId
    this.nextRequestId = id >= WORKER_EVENT_REQ_ID - 1 ? 1 : id + 1
    while (this.pending.has(id)) {
      id = this.nextRequestId
      this.nextRequestId = id >= WORKER_EVENT_REQ_ID - 1 ? 1 : id + 1
    }
    return id
  }

  private writeFrame(reqId: number, msgType: number, payload: Buffer): void {
    if (!this.process?.stdin) {
      throw new Error('PoolWorker: not initialized')
    }
    const totalLen = 4 + 1 + payload.length
    const header = Buffer.allocUnsafe(PREFIX_LEN)
    header.writeUInt32LE(totalLen, 0)
    header.writeUInt32LE(reqId, 4)
    header[8] = msgType
    this.process.stdin.write(header)
    this.process.stdin.write(payload)
  }

  private ensureReady(): void {
    const poisonedBy = this.getPoisonDescription()
    if (poisonedBy !== null) {
      throw new Error(
        `PoolWorker[${this.opts.workerLabel}]: poisoned (${poisonedBy}) — recycling, not taking work`,
      )
    }
    if (!this.ready || !this.process?.stdin) {
      throw new Error(`PoolWorker[${this.opts.workerLabel}]: not initialized`)
    }
  }

  /** Time spent in `Buffer.concat` since the last report. */
  private recvConcatMs = 0
  /** Largest the receive buffer has grown since the last report. */
  private recvPeakBytes = 0
  /** When the last receive-cost report was emitted. */
  private recvReportedAt = 0

  /**
   * Emit the receive-path cost at most once every 10s, and only when it is
   * actually interesting — silence when the reader costs nothing is the whole
   * point, otherwise this becomes another line nobody reads.
   */
  private reportRecvCostIfDue(): void {
    const now = Date.now()
    if (this.recvReportedAt === 0) this.recvReportedAt = now
    if (now - this.recvReportedAt < 10_000) return
    const concatMs = this.recvConcatMs
    const peak = this.recvPeakBytes
    this.recvConcatMs = 0
    this.recvPeakBytes = 0
    this.recvReportedAt = now
    // 250ms of copying per 10s window is already 2.5% of the loop spent moving
    // bytes that never needed to move.
    if (concatMs < 250) return
    this.log.warn('pool receive path is copying', {
      meta: {
        worker: this.opts.workerLabel,
        runtime: this.opts.poolRuntime,
        device: this.opts.device ?? 'default',
        concatMs,
        peakBufferKb: Math.round(peak / 1024),
        windowMs: 10_000,
      },
    })
  }

  private drainResponses(): void {
    while (this.receiveBuffer.length >= 8) {
      const totalLen = this.receiveBuffer.readUInt32LE(0)
      if (this.receiveBuffer.length < 4 + totalLen) break
      const reqId = this.receiveBuffer.readUInt32LE(4)
      const jsonBytes = this.receiveBuffer.subarray(8, 4 + totalLen)
      this.receiveBuffer = this.receiveBuffer.subarray(4 + totalLen)

      if (reqId === WORKER_EVENT_REQ_ID) {
        this.handleWorkerEvent(jsonBytes)
        continue
      }
      const entry = this.pending.get(reqId)
      if (!entry) {
        this.log.warn('Response for unknown request id', {
          meta: { worker: this.opts.workerLabel, reqId },
        })
        // A LATE result is still proof the executor runs (D653).
        this.noteLateReply(jsonBytes)
        continue
      }
      this.pending.delete(reqId)
      if (entry.timer) clearTimeout(entry.timer)

      try {
        const parsed = JSON.parse(jsonBytes.toString('utf8')) as Record<string, unknown>
        if (entry.live === true) {
          if (parsed['dropped'] === true) this.noteInferUnanswered()
          else this.inferStall.noteResult(Date.now())
        }
        entry.resolve(parsed)
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    this.noteAnyReply()
    // A poisoned worker is killed the moment it holds nothing more (D653).
    if (this.poisonVerdict !== null && this.pending.size === 0) this.recycle()
  }

  /**
   * Something came back from the worker: its loop was alive just now, so the
   * missed-deadline verdict is lifted.
   */
  private noteAnyReply(): void {
    this.loadDeadlineMissed = false
  }

  /**
   * The invariant the load deadline depends on (D653 § 2): loads into one
   * pool are serialised, so at most ONE load is outstanding per worker. The
   * worker runs model commands in order and starts a load's soft bound only
   * when it begins, while the host's deadline for it runs from the SEND. A
   * load queued behind another could therefore see its host deadline fire
   * before the worker's named answer. Nothing in the provider issues that; if
   * anything ever does, this says so.
   */
  private warnIfLoadQueued(next: PoolCommandDescriptor): void {
    const ahead = [...this.pending.values()]
      .map((p) => p.command)
      .filter((c): c is PoolCommandDescriptor => c !== undefined && MODEL_LOAD_COMMANDS.has(c.cmd))
    if (ahead.length === 0) return
    this.log.warn(
      'model load queued behind another on one worker — its deadline may fire before the worker answers',
      {
        meta: {
          worker: this.opts.workerLabel,
          pid: this.getPid(),
          runtime: this.opts.poolRuntime,
          device: this.opts.device ?? 'default',
          model: next.model,
          queuedBehind: ahead.map((c) => c.model),
        },
      },
    )
  }

  private hasPendingLoad(): boolean {
    for (const p of this.pending.values()) {
      if (p.command !== undefined && MODEL_LOAD_COMMANDS.has(p.command.cmd)) return true
    }
    return false
  }

  // ── Private — poisoning (D653) ────────────────────────────────────

  /**
   * A load reply that says a compile outlived its SOFT bound (`compile-timeout`)
   * or that an earlier one still has (`worker-poisoned`). The worker is not
   * recycled for it (fix round 1): the compile keeps running so a slow but
   * finite one writes its cache, the loaded models keep serving, and the worker
   * starts no new load. Only a compile still running at the HARD bound costs
   * the process.
   */
  private inspectCommandReply(
    raw: Record<string, unknown>,
    command: PoolCommandDescriptor,
    sentAt: number,
  ): void {
    const reason = raw['reason']
    if (reason !== 'compile-timeout' && reason !== 'worker-poisoned') return
    if (this.abandonedCompile !== null || this.poisonVerdict !== null || this.exited) return
    const model = raw['modelId']
    const abandoned = { ...command, model: typeof model === 'string' ? model : command.model }
    const bounds = POOL_MODEL_LOAD_BOUNDS[this.opts.poolRuntime]
    // The hard bound is counted from the ORIGINAL compile's start. The worker
    // reports how long it has been running (`compileElapsedMs`) — for a
    // `worker-poisoned` refusal that is the EARLIER load, not this one. A
    // worker that does not report it: the time since THIS load was sent, for
    // both replies (round 3 — a fixed soft bound fired the hard bound late by
    // however long the refusal took to arrive).
    const reported = raw['compileElapsedMs']
    const elapsedMs =
      typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
        ? reported
        : Date.now() - sentAt
    const hardTimer = setTimeout(
      () =>
        this.poison(
          'compile-hung',
          abandoned,
          `the compile of ${abandoned.model ?? 'unknown'} was still running at its hard bound (${bounds.hardMs}ms)`,
        ),
      Math.max(0, bounds.hardMs - elapsedMs),
    )
    hardTimer.unref?.()
    this.abandonedCompile = { command: abandoned, since: Date.now(), hardTimer }
    this.log.warn('model compile past its soft bound — left running so its cache can be written', {
      meta: {
        worker: this.opts.workerLabel,
        pid: this.getPid(),
        runtime: this.opts.poolRuntime,
        device: this.opts.device ?? 'default',
        model: abandoned.model,
        modelIndex: abandoned.modelIndex,
        softMs: bounds.softMs,
        hardMs: bounds.hardMs,
        loads: 'refused until it returns',
      },
    })
  }

  /** An unsolicited worker event (`compile-finished-late`). */
  private handleWorkerEvent(jsonBytes: Buffer): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(jsonBytes.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }
    if (event['event'] !== 'compile-finished-late') return
    const abandoned = this.abandonedCompile
    if (abandoned !== null) clearTimeout(abandoned.hardTimer)
    this.abandonedCompile = null
    this.inferStall.noteResult(Date.now())
    const ok = event['ok'] === true
    const meta = {
      worker: this.opts.workerLabel,
      pid: this.getPid(),
      runtime: this.opts.poolRuntime,
      device: this.opts.device ?? 'default',
      model: typeof event['modelId'] === 'string' ? event['modelId'] : null,
      elapsedMs: typeof event['elapsedMs'] === 'number' ? event['elapsedMs'] : null,
      ...(typeof event['error'] === 'string' ? { error: event['error'] } : {}),
    }
    if (ok) {
      this.log.info(
        'slow model compile finished after its soft bound — cache written, loads re-enabled',
        { meta },
      )
    } else {
      this.log.warn('slow model compile failed after its soft bound — loads re-enabled', { meta })
    }
    this.opts.onCompileFinishedLate?.({
      model: meta.model,
      ok,
      ...(typeof event['error'] === 'string' ? { error: event['error'] } : {}),
    })
  }

  /**
   * The GIL grace (D653 round 2): may a silent loop be a compile holding the
   * GIL rather than a wedge? Only while a load is SENT AND UNANSWERED, and only
   * on a runtime whose compile may hold the GIL (`POOL_MODEL_LOAD_BOUNDS`).
   *
   * NOT while a compile runs past its soft bound: the worker REPLIED
   * `compile-timeout`, so its loop is proven alive, and an inference hang
   * behind that compile — the 2026-09-26 incident exactly — must be seen on
   * the normal rule, not ~600-900 s later at the hard bound.
   */
  private gilGraceActive(): boolean {
    const bounds = POOL_MODEL_LOAD_BOUNDS[this.opts.poolRuntime]
    if (!bounds.gilMayBeHeldDuringCompile) return false
    // Round 3: the grace cannot be chained. A missed load deadline ends it
    // until a reply arrives — so the next load the provider issues cannot
    // swallow the probe failure of the one that just missed. That rule IS the
    // bound: every load's host deadline is soft + 30 s from its send, so a
    // frozen worker's first unanswered load misses first, and the probe after
    // it poisons (340 s on CoreML). No separate cap: one could never bind
    // before this rule (D653 § 6).
    if (this.loadDeadlineMissed) return false
    return this.hasPendingLoad()
  }

  /**
   * The reason a silent worker is recycled with: a freeze that began with a
   * load missing its deadline is that compile's doing (`compile-hung`, charged
   * to the model, not the device); anything else is the device's.
   */
  private silenceReason(fallback: 'unresponsive' | 'infer-unresponsive'): PoolPoisonReason {
    return this.loadDeadlineMissed ? 'compile-hung' : fallback
  }

  /** A live request ended with no result: judge the executor (D653, item 4). */
  private noteInferUnanswered(): void {
    const stall = this.inferStall.noteUnanswered(Date.now())
    if (stall === null || this.gilGraceActive()) return
    this.poison(
      this.silenceReason('infer-unresponsive'),
      { cmd: 'infer', modelIndex: null, model: null },
      `${stall.unanswered} live requests in a row ended without a result, none for ${stall.silentMs}ms`,
    )
  }

  /** A reply whose request was already abandoned: a real result still proves the executor runs. */
  private noteLateReply(jsonBytes: Buffer): void {
    try {
      const parsed = JSON.parse(jsonBytes.toString('utf8')) as Record<string, unknown>
      if (parsed['dropped'] !== true && parsed['cmd'] === undefined) {
        this.inferStall.noteResult(Date.now())
      }
    } catch {
      /* unparseable late reply: proves nothing */
    }
  }

  /**
   * Ask a worker whose command just timed out whether its loop still answers.
   * `mem_stats` is served on the loop, never behind a compile, so a worker
   * that cannot answer it inside {@link POOL_LIVENESS_PROBE_TIMEOUT_MS} is not
   * slow — it is wedged. That is the 2026-09-26 shape exactly: 123 of 123
   * `mem_stats` lost while the process looked alive.
   */
  private probeLiveness(timedOut: PoolCommandDescriptor): void {
    if (this.probeInFlight || this.poisonVerdict !== null || this.exited) return
    this.probeInFlight = true
    const probe: PoolCommandDescriptor = { cmd: 'mem_stats', modelIndex: null, model: null }
    this.dispatch(MSG_COMMAND, Buffer.from(JSON.stringify({ cmd: 'mem_stats' }), 'utf8'), {
      command: probe,
      timeoutMs: POOL_LIVENESS_PROBE_TIMEOUT_MS,
      probe: true,
    })
      .then(
        () => {
          this.log.warn(
            'pool command timed out but the worker answers its liveness probe — slow, not wedged',
            {
              meta: {
                worker: this.opts.workerLabel,
                pid: this.getPid(),
                runtime: this.opts.poolRuntime,
                device: this.opts.device ?? 'default',
                command: timedOut.cmd,
                modelIndex: timedOut.modelIndex,
                model: timedOut.model,
              },
            },
          )
        },
        (err: unknown) => {
          // Grace while a load is outstanding (CoreML decision, D653): a
          // runtime that holds the GIL through its compile freezes the loop,
          // and the probe cannot tell that from a wedge. The load's own
          // deadline, and the hard bound behind it, still end it.
          if (this.gilGraceActive()) {
            this.log.warn(
              'liveness probe unanswered while a model load is outstanding — not poisoning yet',
              {
                meta: {
                  worker: this.opts.workerLabel,
                  pid: this.getPid(),
                  runtime: this.opts.poolRuntime,
                  device: this.opts.device ?? 'default',
                  command: timedOut.cmd,
                  model: timedOut.model,
                },
              },
            )
            return
          }
          this.poison(
            this.silenceReason('unresponsive'),
            timedOut,
            `${timedOut.cmd} timed out, then the liveness probe failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        },
      )
      .finally(() => {
        this.probeInFlight = false
      })
  }

  /**
   * Declare this LIVE worker unusable, say so once at ERROR, stop taking work,
   * and recycle it once it has drained.
   *
   * `ready = false` is what hands the pool back to the provider: its next
   * dispatch finds the factory not ready and condemns it under the per-device
   * restart budget (3 deaths in 10 min, then a terminal `failed` the balancer
   * excludes) — the same path a crashed worker takes, except that a
   * `compile-hung` death is not charged to the device (see PoolPoisonReason).
   * An unresponsive worker is killed at once (it will answer nothing it
   * holds); a compile-hung one keeps serving its loaded models until its
   * in-flight requests are answered, bounded by the live deadline.
   */
  private poison(reason: PoolPoisonReason, command: PoolCommandDescriptor, detail: string): void {
    if (this.poisonVerdict !== null || this.exited || this.process === null) return
    this.poisonVerdict = { reason, command, detail, pid: this.getPid() }
    this.ready = false
    const inFlightCommands = [...this.pending.values()]
      .map((p) => p.command)
      .filter((c): c is PoolCommandDescriptor => c !== undefined)
      .map((c) => (c.model !== null ? `${c.cmd}:${c.model}` : c.cmd))
    this.log.error('pool worker POISONED — recycling it', {
      meta: {
        worker: this.opts.workerLabel,
        pid: this.getPid(),
        runtime: this.opts.poolRuntime,
        device: this.opts.device ?? 'default',
        reason,
        command: command.cmd,
        modelIndex: command.modelIndex,
        model: command.model,
        detail,
        inFlight: this.pending.size,
        inFlightCommands,
      },
    })
    if (reason !== 'compile-hung' || this.pending.size === 0) {
      this.recycle()
      return
    }
    this.recycleBackstop = setTimeout(
      () => this.recycle(),
      POOL_LIVE_INFER_TIMEOUT_MS + POOL_POISON_DRAIN_SLACK_MS,
    )
    this.recycleBackstop.unref?.()
  }

  /**
   * Kill a poisoned worker WITHOUT nulling `this.process`, so its `exit` is
   * reported and rejects whatever it still held — a deliberate dispose would
   * silence both, and this is not one.
   */
  private recycle(): void {
    if (this.recycling || this.exited || this.process === null) return
    this.recycling = true
    if (this.recycleBackstop) clearTimeout(this.recycleBackstop)
    const proc = this.process
    void this.dumpStackOfPoisoned(proc).then(() => terminateChild(proc, POOL_WORKER_TERM_GRACE_MS))
  }

  /**
   * Before a POISONED worker is killed, ask it where it hung (SIGUSR1 →
   * `faulthandler`, bounded by {@link POOL_STACK_DUMP_WAIT_MS}) and say where
   * the answer went: the worker's stderr, which this host logs line by line as
   * `[<worker label>] …` warnings just before the exit line. A hang that is
   * killed without this leaves "it hung" as the whole record.
   */
  private async dumpStackOfPoisoned(proc: ChildProcess): Promise<void> {
    if (this.poisonVerdict === null) return
    const outcome = await requestStackDump(proc, POOL_STACK_DUMP_WAIT_MS)
    this.log.warn('poisoned pool worker asked for its stack before SIGTERM', {
      meta: {
        worker: this.opts.workerLabel,
        pid: proc.pid ?? null,
        runtime: this.opts.poolRuntime,
        device: this.opts.device ?? 'default',
        reason: this.poisonVerdict.reason,
        outcome,
        signal: 'SIGUSR1',
        waitedMs: outcome === 'signalled' ? POOL_STACK_DUMP_WAIT_MS : 0,
        dumpWrittenTo:
          outcome === 'signalled'
            ? `worker stderr — this log, lines prefixed [${this.opts.workerLabel}]`
            : 'none',
      },
    })
  }

  private rejectAll(err: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
  }
}

// ---------------------------------------------------------------------------
// SharedInferencePool — multi-process orchestrator
// ---------------------------------------------------------------------------

export class SharedInferencePool {
  private readonly workers: PoolWorker[] = []
  private nextDispatchIdx = 0
  private nextFreeIndex = 0
  private nextFrameId = 1
  /**
   * Cumulative count of dropped (shed) responses on the single-frame and
   * batch inference paths: the Python per-model bound, the Python
   * deadline-expired shed, and the TS in-flight watchdog's own
   * deadline-expired resolution all land here. Without this a shed response
   * is indistinguishable from a genuine "no detections" result.
   */
  private droppedResponseCount = 0
  /**
   * The `shedReason: 'deadline-expired'` subset of {@link
   * droppedResponseCount} — work that was ALREADY DEAD when it would have
   * run (D350). This is the number that was zero-by-construction while the
   * 2026-09-04 storm burned the accelerator on abandoned requests for 4h15m;
   * a rising value here under load is the pool refusing dead work, which is
   * the fix working, not a fault.
   */
  private deadlineExpiredShedCount = 0
  private readonly log: IScopedLogger
  private readonly concurrency: number
  private readonly tuning: PoolTuning | null
  private readonly numWorkers: number

  constructor(
    private readonly pythonPath: string,
    private readonly poolRuntime: PoolRuntime,
    logger: IScopedLogger,
    options: SharedInferencePoolOptions = {},
  ) {
    this.log = logger
    this.concurrency = Math.max(1, options.concurrency ?? 1)
    this.tuning = options.tuning ?? null
    this.numWorkers = Math.max(1, options.numWorkers ?? 1)
    this.device = options.device
    this.onCompileFinishedLate = options.onCompileFinishedLate
  }

  private readonly device: string | undefined
  private readonly onCompileFinishedLate: ((event: PoolCompileFinishedLate) => void) | undefined

  /** Pid of the first worker (for legacy callers). Use `getPids()` for all. */
  /** Summed backlog and shed count across the pool's workers. A rising
   *  `inFlight` with a rising `shed` is a worker falling behind; a rising
   *  `inFlight` with zero `shed` and no results is the state that used to be
   *  invisible. */
  getBacklog(): { readonly inFlight: number; readonly shed: number } {
    let inFlight = 0
    let shed = 0
    for (const w of this.workers) {
      inFlight += w.getInFlight()
      shed += w.getShedCount()
    }
    return { inFlight, shed }
  }

  getPid(): number | null {
    return this.workers[0]?.getPid() ?? null
  }

  getPids(): readonly (number | null)[] {
    return this.workers.map((w) => w.getPid())
  }

  /**
   * Start N pool workers in parallel. Each worker loads the same
   * initial model set so subsequent inference calls land on a worker
   * with the requested model already in its slot map.
   */
  async initialize(
    initialModels: readonly PoolModelConfig[] = [],
  ): Promise<{ startupMs: number; loadedCount: number; workers: number }> {
    const scriptPath = this.resolveScriptPath()

    for (let i = 0; i < this.numWorkers; i++) {
      this.workers.push(
        new PoolWorker({
          pythonPath: this.pythonPath,
          scriptPath,
          poolRuntime: this.poolRuntime,
          concurrency: this.concurrency,
          tuning: this.tuning,
          logger: this.log,
          workerLabel: `w${i}`,
          ...(this.device ? { device: this.device } : {}),
          ...(this.onCompileFinishedLate
            ? { onCompileFinishedLate: this.onCompileFinishedLate }
            : {}),
        }),
      )
    }

    const t0 = performance.now()
    const results = await Promise.all(this.workers.map((w) => w.initialize(initialModels)))
    const startupMs = Math.round(performance.now() - t0)

    this.nextFreeIndex = initialModels.length
    const loadedCount = results[0]?.loadedCount ?? 0
    const innerWorkers = results.reduce((s, r) => s + r.workers, 0)
    // `device` is on this line (and on `Pool process(es) terminated` and the
    // overload-shed line) because `runtime` alone does not identify a pool: a
    // node runs one openvino pool per accelerator, and without the device the
    // NPU's pool and the iGPU's pool are the same log line twice.
    this.log.info('Pool ready', {
      meta: {
        loadedCount,
        startupMs,
        runtime: this.poolRuntime,
        device: this.device ?? 'default',
        workers: this.numWorkers,
        pythonWorkers: innerWorkers,
        pids: this.getPids(),
      },
    })
    return { startupMs, loadedCount, workers: this.numWorkers }
  }

  // -------------------------------------------------------------------------
  // Inference (hot path) — round-robin across workers
  // -------------------------------------------------------------------------

  async infer(
    modelIndex: number,
    jpeg: Buffer,
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    const w = this.pickWorker()
    return this.trackDroppedResponse(
      await w.infer(this.encodeModelByte(modelIndex), jpeg, deviceId),
      modelIndex,
    )
  }

  async inferRaw(
    modelIndex: number,
    raw: Buffer,
    width: number,
    height: number,
    format: RawFrameFormat,
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    const w = this.pickWorker()
    return this.trackDroppedResponse(
      await w.inferRaw(this.encodeModelByte(modelIndex), raw, width, height, format, deviceId),
      modelIndex,
    )
  }

  async inferBatch(
    modelIndex: number,
    items: readonly {
      readonly raw: Buffer
      readonly width: number
      readonly height: number
      readonly format: RawFrameFormat
    }[],
    frameId = 0,
  ): Promise<readonly Record<string, unknown>[]> {
    if (items.length > 255) {
      throw new Error(`SharedInferencePool.inferBatch: max 255 items per call, got ${items.length}`)
    }
    const w = this.pickWorker()
    const results = await w.inferBatch(this.encodeModelByte(modelIndex), items, frameId)
    // The batch path bypasses `trackDroppedResponse` (its response is an
    // array, not a record) — count its shed items here so a deadline-expired
    // batch is as countable as a single frame. A branch that discards work
    // silently is how the 2026-09-04 collapse ran unlogged for four hours.
    for (const item of results) {
      if (item['dropped'] === true) {
        this.droppedResponseCount++
        if (item['shedReason'] === 'deadline-expired') this.deadlineExpiredShedCount++
      }
    }
    return results
  }

  async inferCached(
    modelIndex: number,
    frameId: number,
    deviceId?: number,
  ): Promise<Record<string, unknown>> {
    // Cached frames are propagated to ALL workers at cache time, so any
    // worker can serve the inferCached call.
    const w = this.pickWorker()
    return this.trackDroppedResponse(
      await w.inferCached(this.encodeModelByte(modelIndex), frameId, deviceId),
      modelIndex,
    )
  }

  /**
   * Total `"dropped": true` responses seen from the Python pool — frames
   * shed by the per-model in-flight bound under overload. Diagnostic
   * counter (monotonic for the pool's lifetime).
   */
  getDroppedResponseCount(): number {
    return this.droppedResponseCount
  }

  /**
   * The `deadline-expired` subset of {@link getDroppedResponseCount}:
   * requests refused (by the Python worker, or by the local in-flight
   * watchdog as its backstop) because their absolute deadline had already
   * passed — dead work NOT executed (D350). Monotonic for the pool's
   * lifetime; surfaced on the memory watchdog's `pool memory` line.
   */
  getDeadlineExpiredShedCount(): number {
    return this.deadlineExpiredShedCount
  }

  /**
   * Requests that timed out client-side, summed over the live workers. A
   * worker restart resets its share; the inference-timeout guard treats a
   * drop as "the new count is the delta". This is the metric 1.2.218's
   * regression was invisible on for 4 h 19 min (2026-09-04).
   */
  getTimedOutCount(): number {
    return this.workers.reduce((sum, w) => sum + w.getTimedOutCount(), 0)
  }

  getHandle(modelIndex: number): IInferenceEngine {
    return new PoolHandle(this, modelIndex)
  }

  // -------------------------------------------------------------------------
  // Bench frame cache — propagated to all workers
  // -------------------------------------------------------------------------

  async cacheFrame(
    raw: Buffer,
    width: number,
    height: number,
    format: RawFrameFormat,
  ): Promise<{ frameId: number; width: number; height: number }> {
    const frameId = this.nextFrameId++
    await Promise.all(this.workers.map((w) => w.cacheFrame(frameId, raw, width, height, format)))
    return { frameId, width, height }
  }

  async uncacheFrame(frameId: number): Promise<void> {
    await Promise.all(this.workers.map((w) => w.sendCommand({ cmd: 'uncache_frame', frameId })))
  }

  // -------------------------------------------------------------------------
  // Model management — propagated to ALL workers (synchronous waterfall)
  // -------------------------------------------------------------------------

  async loadModel(index: number, config: PoolModelConfig): Promise<{ loadMs: number }> {
    const responses = await Promise.all(
      this.workers.map((w) =>
        w.sendCommand({
          cmd: 'load',
          index,
          config: serializeModelConfig(config),
        }),
      ),
    )
    for (const resp of responses) {
      if (resp.status !== 'ok') {
        throw new PoolModelLoadError(
          `Failed to load model at index ${index}: ${describeCommandFailure(resp)}`,
          resp.reason ?? null,
          resp.modelId ?? null,
        )
      }
    }
    if (index >= this.nextFreeIndex) {
      this.nextFreeIndex = index + 1
    }
    const maxLoadMs = Math.max(...responses.map((r) => r.loadMs ?? 0))
    return { loadMs: maxLoadMs }
  }

  async unloadModel(index: number): Promise<void> {
    const responses = await Promise.all(
      this.workers.map((w) => w.sendCommand({ cmd: 'unload', index })),
    )
    for (const resp of responses) {
      if (resp.status !== 'ok') {
        throw new Error(`Failed to unload model at index ${index}: ${resp.error ?? 'unknown'}`)
      }
    }
  }

  /**
   * Retune a LOADED slot's decode-scoped settings without touching its
   * inference session — the narrow counterpart of `replaceModel`.
   *
   * `replace` is `unload` + `load`: it re-instantiates the session (~1.4s on
   * coreml, and an OpenVINO recompile) and stalls every live camera routed to
   * this pool. An operator moving the NMS slider must not cost that, and must
   * not touch any other slot: the Python side applies the patch to `index`
   * only, and refuses any key outside its reconfigurable allow-list rather
   * than accepting a `path` change that would silently not reload.
   */
  async reconfigureModel(index: number, settings: PoolDecodeSettings): Promise<void> {
    const responses = await Promise.all(
      this.workers.map((w) =>
        w.sendCommand({
          cmd: 'reconfigure',
          index,
          config: { nmsIouThreshold: settings.nmsIouThreshold },
        }),
      ),
    )
    for (const resp of responses) {
      if (resp.status !== 'ok') {
        throw new Error(`Failed to reconfigure model at index ${index}: ${resp.error ?? 'unknown'}`)
      }
    }
  }

  async replaceModel(index: number, config: PoolModelConfig): Promise<{ loadMs: number }> {
    const responses = await Promise.all(
      this.workers.map((w) =>
        w.sendCommand({
          cmd: 'replace',
          index,
          config: serializeModelConfig(config),
        }),
      ),
    )
    for (const resp of responses) {
      if (resp.status !== 'ok') {
        throw new PoolModelLoadError(
          `Failed to replace model at index ${index}: ${describeCommandFailure(resp)}`,
          resp.reason ?? null,
          resp.modelId ?? null,
        )
      }
    }
    const maxLoadMs = Math.max(...responses.map((r) => r.loadMs ?? 0))
    return { loadMs: maxLoadMs }
  }

  /**
   * Per-worker Python-side memory diagnostics (`mem_stats` command):
   * RSS/VmSize/peak/threads from /proc/self, getrusage maxrss, glibc malloc
   * arena count, gc counts, served-request counters, per-model queue depth,
   * cache entry counts. Queried by the pool memory watchdog once per sweep —
   * the internals that distinguish "leak" from "working set" and that
   * /proc/<pid> alone cannot see. A worker that is not ready (or whose
   * command fails) contributes an `error` record instead of vanishing.
   */
  async getMemStats(): Promise<readonly PoolWorkerMemStats[]> {
    const out: PoolWorkerMemStats[] = []
    for (const [i, w] of this.workers.entries()) {
      if (!w.isReady()) {
        out.push({
          worker: `w${i}`,
          pid: w.getPid(),
          stats: null,
          error: 'worker not ready',
        })
        continue
      }
      try {
        const stats = await w.sendRawCommand({ cmd: 'mem_stats' })
        out.push({ worker: `w${i}`, pid: w.getPid(), stats, error: null })
      } catch (err) {
        out.push({
          worker: `w${i}`,
          pid: w.getPid(),
          stats: null,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return out
  }

  async getStatus(): Promise<readonly ModelSlotStatus[]> {
    // Worker 0 is authoritative — model indices are kept in sync across
    // all workers by the propagation in load/unload/replace.
    if (this.workers.length === 0) return []
    const resp = await this.workers[0]!.sendCommand({ cmd: 'status' })
    return (resp.models ?? []) as ModelSlotStatus[]
  }

  allocateIndex(): number {
    return this.nextFreeIndex++
  }

  /**
   * Give back an index whose load FAILED, so the retry reuses it. Only the most
   * recent allocation can be returned. Loads into one pool are serialised by
   * the provider, so a failed load is normally the latest one; anything else
   * is left allocated rather than risk handing out a live slot twice.
   */
  releaseIndex(index: number): void {
    if (index === this.nextFreeIndex - 1) this.nextFreeIndex = index
  }

  isReady(): boolean {
    return this.workers.length > 0 && this.workers.every((w) => w.isReady())
  }

  /**
   * Why a worker of this pool was declared unusable while alive (D653), or
   * `null`. The provider charges the restart budget with THIS — or, for a
   * `compile-hung` death, does not charge the device at all — so the
   * `inference device FAILED` line names the cause instead of "pool worker is
   * not ready".
   */
  getDeathCause(): PoolDeathCause | null {
    for (const w of this.workers) {
      const cause = w.getDeathCause()
      if (cause !== null) return { ...cause, message: `worker ${cause.message}` }
    }
    return null
  }

  async dispose(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.dispose()))
    this.workers.length = 0
    this.log.info('Pool process(es) terminated', {
      meta: { runtime: this.poolRuntime, device: this.device ?? 'default' },
    })
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Recognise a Python overload-shed response (`"dropped": true`) on the
   * single-frame inference paths. Previously indistinguishable from a
   * genuine empty detection result — now counted + debug-logged so
   * overload is measurable. The response passes through unchanged.
   *
   * SAMPLED log: one line per shed frame turned into 45 741 rows/hour on
   * the hub during the 2026-08-01 chronic overload (~13 shed/s) — 2/3 of
   * the hub's entire log volume, burying every other signal. The counter
   * keeps exact totals (`droppedTotal` is authoritative, surfaced in
   * `getStatus` consumers via `getDroppedResponseCount`); the log line
   * now fires on the FIRST shed and every `SHED_LOG_SAMPLE_EVERY`th,
   * carrying the running total so nothing is lost — only repeated.
   */
  private trackDroppedResponse(
    result: Record<string, unknown>,
    modelIndex: number,
  ): Record<string, unknown> {
    if (result['dropped'] === true) {
      this.droppedResponseCount++
      if (result['shedReason'] === 'deadline-expired') this.deadlineExpiredShedCount++
      const total = this.droppedResponseCount
      if (total === 1 || total % SHED_LOG_SAMPLE_EVERY === 0) {
        this.log.debug('Python pool shed frame under overload', {
          meta: {
            modelIndex,
            droppedTotal: total,
            deadlineExpiredTotal: this.deadlineExpiredShedCount,
            ...(typeof result['shedReason'] === 'string'
              ? { shedReason: result['shedReason'] }
              : {}),
            sampledEvery: SHED_LOG_SAMPLE_EVERY,
            runtime: this.poolRuntime,
            device: this.device ?? 'default',
          },
        })
      }
    }
    return result
  }

  private pickWorker(): PoolWorker {
    if (this.workers.length === 0) {
      throw new Error('SharedInferencePool: not initialized')
    }
    const idx = this.nextDispatchIdx
    this.nextDispatchIdx = (this.nextDispatchIdx + 1) % this.workers.length
    return this.workers[idx]!
  }

  private encodeModelByte(modelIndex: number): number {
    if (modelIndex < 0 || modelIndex > 254) {
      throw new Error(`Model index ${modelIndex} out of range (0-254)`)
    }
    return modelIndex
  }

  private resolveScriptPath(): string {
    const candidates = [
      path.join(__dirname, '../../python/inference_pool.py'),
      path.join(__dirname, '../python/inference_pool.py'),
      path.join(__dirname, '../../../python/inference_pool.py'),
    ]

    try {
      const pkgPath = require.resolve('@camstack/addon-detection-pipeline/package.json')
      candidates.unshift(path.join(path.dirname(pkgPath), 'python', 'inference_pool.py'))
    } catch {
      // Package not resolvable — use relative paths
    }

    const found = candidates.find((p) => fs.existsSync(p))
    if (!found) {
      throw new Error(`inference_pool.py not found. Searched:\n${candidates.join('\n')}`)
    }
    return found
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A failed command's reply as one message: its reason class first, when it has one. */
function describeCommandFailure(resp: CommandResponse): string {
  const error = resp.error ?? 'unknown'
  return resp.reason !== undefined ? `${resp.reason}: ${error}` : error
}

/** Name a command for the lines that must say which one hung (D653). */
function describeCommand(cmd: Record<string, unknown>): PoolCommandDescriptor {
  const name = typeof cmd['cmd'] === 'string' ? cmd['cmd'] : 'unknown'
  const index = cmd['index']
  const config = cmd['config']
  const modelPath =
    typeof config === 'object' && config !== null && 'path' in config ? config.path : undefined
  return {
    cmd: name,
    modelIndex: typeof index === 'number' ? index : null,
    model:
      typeof modelPath === 'string' && modelPath.length > 0
        ? path.basename(modelPath, path.extname(modelPath))
        : null,
  }
}

/** The wire form of a model config — the keys the Python pool reads. Exported for tests. */
export function serializeModelConfig(config: PoolModelConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {
    path: config.path,
    inputSize: config.inputSize,
    preprocessMode: config.preprocessMode,
    postprocessor: config.postprocessor,
    confidence: config.confidence,
  }
  if (config.nmsIouThreshold !== undefined) result['nmsIouThreshold'] = config.nmsIouThreshold
  if (config.inputNormalization !== undefined)
    result['inputNormalization'] = config.inputNormalization
  if (config.outputProbabilities !== undefined)
    result['outputProbabilities'] = config.outputProbabilities
  if (config.gpuInferencePrecision !== undefined)
    result['gpuInferencePrecision'] = config.gpuInferencePrecision
  if (config.inputWidth !== undefined) result['inputWidth'] = config.inputWidth
  if (config.inputHeight !== undefined) result['inputHeight'] = config.inputHeight
  if (config.inputChannels !== undefined) result['inputChannels'] = config.inputChannels
  if (config.labels) result['labels'] = config.labels
  if (config.charset) result['charset'] = config.charset
  if (config.plateRegion !== undefined) result['plateRegion'] = config.plateRegion
  if (config.minTextLength !== undefined) result['minTextLength'] = config.minTextLength
  if (config.minTextConfidence !== undefined) result['minTextConfidence'] = config.minTextConfidence
  if (config.minCharProbability !== undefined)
    result['minCharProbability'] = config.minCharProbability
  if (config.numClasses) result['numClasses'] = config.numClasses
  if (config.strides) result['strides'] = config.strides
  if (config.maskThreshold !== undefined) result['maskThreshold'] = config.maskThreshold
  if (config.device) result['device'] = config.device
  return result
}
