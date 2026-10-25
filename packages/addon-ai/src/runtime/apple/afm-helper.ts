/**
 * Supervisor for the `camstack-afm` child — one per node, darwin only.
 *
 * Why a child and not a native addon: a crash here must kill THIS process, not
 * the `ml` runner every co-located addon lives in (D29). The bound on respawns
 * is the same `CrashPolicy` the llama-server supervisor uses, and a helper past
 * it is terminally `failed` rather than restarted forever (D6).
 *
 * Every request resolves to an OUTCOME, never a throw, and exactly once: a
 * reply, a timeout, a cancel, a crash, a refusal to spawn, or `busy`. A
 * generation the caller stopped waiting for is also stopped in the helper
 * (`cancel` op) — a timed-out gate must not leave the model busy for nobody.
 *
 * Two failure shapes a crash bound alone does not see, both handled here:
 *   - a write into a helper that already died raises EPIPE on the child's
 *     stdin as an async 'error' event. Unlistened, that is an
 *     uncaughtException and the WHOLE `ml` runner exits (D29) — so stdin
 *     errors are routed into the same exit path as a crash;
 *   - a helper that HANGS never exits, so `CrashPolicy` never hears of it. A
 *     probe timeout, or `AFM_MAX_CONSECUTIVE_TIMEOUTS` generation timeouts with
 *     no GENERATION reply in between (late ones count), kills it — and that
 *     kill counts against the crash bound.
 */
import { spawn as spawnChild } from 'node:child_process'
import * as fs from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { AppleFmUnavailableReason, IScopedLogger } from '@camstack/types'
import { CrashPolicy, type CrashPolicyOptions, DEFAULT_CRASH_POLICY } from '../crash-policy.js'
import { AfmEnvelopeSchema, type AfmRequest } from './afm-protocol.js'

/** The narrow slice of a child process the supervisor uses — fakeable. */
export interface HelperProcess {
  write(line: string): void
  readonly stdout: Readable
  readonly stderr: Readable
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  onError(listener: (err: Error) => void): void
  kill(): void
}

export type HelperSpawner = (binaryPath: string) => HelperProcess

export type HelperOutcome =
  | { readonly kind: 'reply'; readonly reply: Readonly<Record<string, unknown>> }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'crashed'; readonly detail: string }
  | {
      readonly kind: 'unavailable'
      readonly reason: Extract<AppleFmUnavailableReason, 'helperMissing' | 'helperCrashed'>
      readonly detail: string
    }
  | { readonly kind: 'busy' }

export interface HelperRequestOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Counts against `maxInFlight` — generations do, probes do not. */
  readonly counted?: boolean
}

export type HelperState = 'idle' | 'running' | 'failed'

export interface AppleFmHelperDeps {
  readonly binaryPath: string
  readonly spawn?: HelperSpawner
  readonly exists?: (path: string) => boolean
  readonly logger: IScopedLogger
  readonly crashPolicy?: CrashPolicyOptions
  /** Concurrent generations before `busy`. Apple's own features share the model. */
  readonly maxInFlight?: number
  readonly now?: () => number
}

/** Four measured fine on an M3 Pro (4/4 in 1.4 s); beyond it the call is
 *  answered `busy` (→ `rate-limited`), never queued. */
export const AFM_DEFAULT_MAX_IN_FLIGHT = 4
/** Generation timeouts in a row after which the helper is treated as wedged. */
export const AFM_MAX_CONSECUTIVE_TIMEOUTS = 3
const AFM_MAX_REMEMBERED_GENERATES = 256
const CRASH_KEY = 'camstack-afm'

interface Pending {
  readonly counted: boolean
  readonly settle: (outcome: HelperOutcome) => void
}

export function spawnAfmHelper(binaryPath: string): HelperProcess {
  const child = spawnChild(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const errorListeners: Array<(err: Error) => void> = []
  const emitError = (err: Error): void => {
    for (const listener of errorListeners) listener(err)
  }
  child.on('error', emitError)
  // EPIPE when the helper died between our last read and this write. Without a
  // listener this is an uncaughtException in the `ml` runner (D29).
  child.stdin.on('error', emitError)
  return {
    write: (line) => {
      if (!child.stdin.writable) throw new Error('helper stdin is closed')
      child.stdin.write(line)
    },
    stdout: child.stdout,
    stderr: child.stderr,
    onExit: (listener) => {
      child.on('exit', listener)
    },
    onError: (listener) => {
      errorListeners.push(listener)
    },
    kill: () => {
      child.kill()
    },
  }
}

export class AppleFmHelper {
  private proc: HelperProcess | null = null
  private failed = false
  private respawnNotBefore = 0
  private disposing = false
  private nextId = 0
  private inFlight = 0
  private consecutiveTimeouts = 0
  /** Ids of generations sent and not yet answered (late answers included). */
  private readonly generateIds = new Set<string>()
  private readonly pending = new Map<string, Pending>()
  private readonly crashes: CrashPolicy
  private readonly spawn: HelperSpawner
  private readonly exists: (path: string) => boolean
  private readonly now: () => number
  private readonly maxInFlight: number

  constructor(private readonly deps: AppleFmHelperDeps) {
    this.crashes = new CrashPolicy(deps.crashPolicy ?? DEFAULT_CRASH_POLICY)
    this.spawn = deps.spawn ?? spawnAfmHelper
    this.exists = deps.exists ?? fs.existsSync
    this.now = deps.now ?? Date.now
    this.maxInFlight = deps.maxInFlight ?? AFM_DEFAULT_MAX_IN_FLIGHT
  }

  state(): HelperState {
    if (this.failed) return 'failed'
    return this.proc === null ? 'idle' : 'running'
  }

  request(payload: AfmRequest, opts: HelperRequestOptions): Promise<HelperOutcome> {
    if (opts.signal?.aborted === true) return Promise.resolve({ kind: 'cancelled' })
    const counted = opts.counted === true
    if (counted && this.inFlight >= this.maxInFlight) {
      this.deps.logger.info('apple fm helper busy; refusing a generation', {
        meta: { inFlight: this.inFlight, maxInFlight: this.maxInFlight },
      })
      return Promise.resolve({ kind: 'busy' })
    }
    const ready = this.ensureProcess()
    if (ready.kind !== 'ok') return Promise.resolve(ready.outcome)
    const proc = ready.proc

    this.nextId += 1
    const id = `afm-${String(this.nextId)}`
    if (payload.op === 'generate') this.rememberGenerate(id)
    return new Promise<HelperOutcome>((resolve) => {
      let settled = false
      const onAbort = (): void => {
        this.stopRemote(proc, id)
        settle({ kind: 'cancelled' })
      }
      const timer = setTimeout(() => {
        this.deps.logger.warn('apple fm helper request timed out; stopping it', {
          meta: { id, op: payload.op, timeoutMs: opts.timeoutMs },
        })
        this.stopRemote(proc, id)
        settle({ kind: 'timeout' })
        this.noteTimeout(proc, payload.op)
      }, opts.timeoutMs)
      const settle = (outcome: HelperOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (this.pending.delete(id) && counted) this.inFlight -= 1
        resolve(outcome)
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { counted, settle })
      if (counted) this.inFlight += 1
      this.send(proc, `${JSON.stringify({ id, ...payload })}\n`)
    })
  }

  /** Bounded: a helper that never answers must not grow this set forever. */
  private rememberGenerate(id: string): void {
    if (this.generateIds.size >= AFM_MAX_REMEMBERED_GENERATES) {
      const oldest = this.generateIds.values().next().value
      if (oldest !== undefined) this.generateIds.delete(oldest)
    }
    this.generateIds.add(id)
  }

  /** A write that throws is the same fact as an exit: the helper is gone. */
  private send(proc: HelperProcess, line: string): void {
    try {
      proc.write(line)
    } catch (err) {
      // Detached-but-alive is worse than dead: kill it so it is never unowned.
      proc.kill()
      this.onExit(proc, `write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * A probe has no reason to be slow — it does not touch the model — so ONE
   * probe timeout means the helper is wedged. Generations can be legitimately
   * slow, so it takes several in a row. The kill goes through `onExit`, i.e.
   * the crash bound: a helper that wedges every time ends terminally `failed`.
   */
  private noteTimeout(proc: HelperProcess, op: AfmRequest['op']): void {
    if (op === 'generate') this.consecutiveTimeouts += 1
    const wedged = op === 'probe' || this.consecutiveTimeouts >= AFM_MAX_CONSECUTIVE_TIMEOUTS
    if (!wedged || this.proc !== proc) return
    this.deps.logger.warn('apple fm helper looks wedged; killing it', {
      meta: { op, consecutiveTimeouts: this.consecutiveTimeouts },
    })
    this.consecutiveTimeouts = 0
    proc.kill()
    this.onExit(proc, `killed after a ${op} timeout`)
  }

  dispose(): void {
    this.disposing = true
    const proc = this.proc
    this.proc = null
    proc?.kill()
    this.settleAll('the helper was stopped')
    this.disposing = false
  }

  private ensureProcess():
    | { readonly kind: 'ok'; readonly proc: HelperProcess }
    | { readonly kind: 'refused'; readonly outcome: HelperOutcome } {
    if (this.proc !== null) return { kind: 'ok', proc: this.proc }
    if (this.failed) {
      return {
        kind: 'refused',
        outcome: {
          kind: 'unavailable',
          reason: 'helperCrashed',
          detail: 'the helper crashed too often and was stopped; restart the ai addon to retry',
        },
      }
    }
    if (this.now() < this.respawnNotBefore) {
      // Transient: the helper is RESTARTING, which is not a known absence.
      return {
        kind: 'refused',
        outcome: {
          kind: 'crashed',
          detail: `the helper is restarting (in ${String(this.respawnNotBefore - this.now())} ms)`,
        },
      }
    }
    if (!this.exists(this.deps.binaryPath)) {
      this.deps.logger.warn('apple fm helper binary is missing from the installed addon', {
        meta: { binaryPath: this.deps.binaryPath },
      })
      return {
        kind: 'refused',
        outcome: {
          kind: 'unavailable',
          reason: 'helperMissing',
          detail: `no helper binary at ${this.deps.binaryPath}`,
        },
      }
    }
    const proc = this.spawn(this.deps.binaryPath)
    this.proc = proc
    this.wire(proc)
    this.deps.logger.info('apple fm helper started', {
      meta: { binaryPath: this.deps.binaryPath },
    })
    return { kind: 'ok', proc }
  }

  private wire(proc: HelperProcess): void {
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    createInterface({ input: proc.stderr }).on('line', (line) => {
      this.deps.logger.debug('apple fm helper stderr', { meta: { line } })
    })
    proc.onExit((code, signal) =>
      this.onExit(proc, `exit code ${String(code)}, signal ${String(signal)}`),
    )
    proc.onError((err) => this.onExit(proc, err.message))
  }

  private onLine(line: string): void {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.deps.logger.warn('apple fm helper wrote an unparseable line; dropped', {
        meta: { line: line.slice(0, 200) },
      })
      return
    }
    const envelope = AfmEnvelopeSchema.safeParse(parsed)
    if (!envelope.success) {
      this.deps.logger.warn('apple fm helper wrote a line with no id; dropped', {
        meta: { line: line.slice(0, 200) },
      })
      return
    }
    // Only a GENERATION answering — on time or late — proves the model path is
    // alive. A cancel ack or a probe reply is written by the helper's reader
    // thread even while every generation is stuck, so neither counts.
    if (this.generateIds.delete(envelope.data.id)) this.consecutiveTimeouts = 0
    const waiter = this.pending.get(envelope.data.id)
    if (waiter === undefined) {
      // A late answer to a request we already timed out or cancelled, or the
      // acknowledgement of a `cancel` — both expected, neither is work lost.
      this.deps.logger.debug('apple fm helper reply with no waiter', {
        meta: { id: envelope.data.id },
      })
      return
    }
    waiter.settle({ kind: 'reply', reply: envelope.data })
  }

  private onExit(proc: HelperProcess, detail: string): void {
    if (this.proc !== proc) return
    this.proc = null
    if (this.disposing) return
    const pendingCount = this.pending.size
    this.settleAll(`the helper exited (${detail})`)
    const decision = this.crashes.recordCrash(CRASH_KEY, this.now())
    if (decision.action === 'failed') {
      this.failed = true
      this.deps.logger.error('apple fm helper exited too often; not restarting it', {
        meta: { detail, crashesInWindow: decision.crashesInWindow, pendingCount },
      })
      return
    }
    this.respawnNotBefore = this.now() + decision.backoffMs
    this.deps.logger.warn('apple fm helper exited; it respawns on the next request', {
      meta: {
        detail,
        backoffMs: decision.backoffMs,
        crashesInWindow: decision.crashesInWindow,
        pendingCount,
      },
    })
  }

  private settleAll(detail: string): void {
    for (const waiter of [...this.pending.values()]) waiter.settle({ kind: 'crashed', detail })
  }

  private stopRemote(proc: HelperProcess, target: string): void {
    if (this.proc !== proc) return
    this.nextId += 1
    this.send(
      proc,
      `${JSON.stringify({ id: `afm-${String(this.nextId)}`, op: 'cancel', target })}\n`,
    )
  }
}
