/**
 * `LlamaSupervisor` — single-child llama-server lifecycle on one node. Copies
 * the two proven in-repo patterns: the embedded-Python engine's spawn +
 * SIGTERM→deadline→SIGKILL escalation, and the CrashSupervisor breaker (bounded
 * respawn, never an infinite loop — D6). Guards the async ChildProcess 'error'
 * race the way fork-decode-worker's wrapChild does (7a95ab54): an uncaught late
 * error event must never become an uncaughtException.
 *
 * v1: at most one running child. Resource ceiling = llama-server flags +
 * idleStopMinutes ONLY (no RSS watchdog — operator decision #3).
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { IScopedLogger, LlmRuntimeStatus } from '@camstack/types'
import { CrashPolicy, DEFAULT_CRASH_POLICY } from './crash-policy.js'

export interface LlamaStartConfig {
  readonly nodeId: string
  readonly modelId: string
  readonly modelPath: string
  readonly mmprojPath?: string
  readonly contextSize: number
  readonly gpuLayers: number
  readonly threads?: number
  readonly parallel: number
  readonly batchSize?: number
  readonly ubatchSize?: number
  readonly flashAttention?: boolean
  readonly mlock?: boolean
  readonly noMmap?: boolean
  readonly cacheTypeK?: string
  readonly cacheTypeV?: string
  /** Flags this schema does not model. Never a duplicate of the fields above. */
  readonly extraArgs?: readonly string[]
  readonly idleStopMinutes: number
  readonly binaryPath: string
}

/**
 * Every llama-server flag a TYPED field above already owns, mapped to the
 * field that owns it.
 *
 * This map is the whole reconciliation between the typed tuning surface and
 * the free-text "additional arguments" box. Both exist because neither is
 * sufficient — the typed fields give the common knobs a validated control and
 * a default, and llama.cpp has a hundred flags nobody is going to model — but
 * a flag settable from BOTH is a bug generator: whichever one loses is a
 * control the operator watched do nothing. So the box is an escape hatch for
 * what is NOT modelled, and reaching into it for something that is gets
 * rejected by name.
 */
const OWNED_FLAGS: Readonly<Record<string, string>> = {
  '-m': 'model',
  '--model': 'model',
  '--host': 'fixed to 127.0.0.1',
  '--port': 'assigned by the supervisor',
  '-c': 'contextSize',
  '--ctx-size': 'contextSize',
  '-ngl': 'gpuLayers',
  '--gpu-layers': 'gpuLayers',
  '--n-gpu-layers': 'gpuLayers',
  '-t': 'threads',
  '--threads': 'threads',
  '--parallel': 'parallel',
  '-np': 'parallel',
  '-b': 'batchSize',
  '--batch-size': 'batchSize',
  '-ub': 'ubatchSize',
  '--ubatch-size': 'ubatchSize',
  '-fa': 'flashAttention',
  '--flash-attn': 'flashAttention',
  '--mlock': 'mlock',
  '--no-mmap': 'noMmap',
  '-ctk': 'cacheTypeK',
  '--cache-type-k': 'cacheTypeK',
  '-ctv': 'cacheTypeV',
  '--cache-type-v': 'cacheTypeV',
  '--mmproj': 'the vision model’s projector',
}

export type ExtraArgsCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/**
 * Reject an `extraArgs` list that reaches for a flag a typed field owns.
 * `--flag=value` counts as `--flag`.
 */
export function checkExtraArgs(extraArgs: readonly string[]): ExtraArgsCheck {
  for (const token of extraArgs) {
    if (!token.startsWith('-')) continue
    const flag = token.split('=')[0] ?? token
    const owner = OWNED_FLAGS[flag]
    if (owner !== undefined) {
      return {
        ok: false,
        message: `"${flag}" is already set by the runtime field "${owner}" — set it there, not in additional arguments (a flag with two owners is a control that silently does nothing)`,
      }
    }
  }
  return { ok: true }
}

export interface LlamaSupervisorDeps {
  readonly logger: IScopedLogger
  readonly spawnFn?: typeof nodeSpawn
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  readonly pickPort?: () => Promise<number>
  readonly healthPollMs?: number
  readonly startTimeoutMs?: number
  readonly killGraceMs?: number
}

type RuntimeState = LlmRuntimeStatus['state']

const HEALTH_GATE_INTERVAL_MS = 500

function defaultPickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        server.close()
        reject(new Error('failed to pick port'))
        return
      }
      const { port } = addr
      server.close(() => resolve(port))
    })
  })
}

/**
 * The argv, and it is the WHOLE tuning surface of a managed model.
 *
 * Every flag here is one the operator can set on the profile; nothing is
 * hard-coded that a real deployment needs to change. `--host 127.0.0.1` is the
 * one deliberate exception — a managed llama-server is reachable only from the
 * node that started it, and binding it wider would publish an unauthenticated
 * inference endpoint on the LAN.
 */
export function buildLlamaArgs(cfg: LlamaStartConfig, port: number): string[] {
  const args = [
    '-m',
    cfg.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    String(cfg.contextSize),
    '-ngl',
    String(cfg.gpuLayers),
    '--parallel',
    String(cfg.parallel),
  ]
  if (cfg.threads !== undefined) args.push('-t', String(cfg.threads))
  if (cfg.batchSize !== undefined) args.push('-b', String(cfg.batchSize))
  if (cfg.ubatchSize !== undefined) args.push('-ub', String(cfg.ubatchSize))
  if (cfg.flashAttention === true) args.push('--flash-attn')
  if (cfg.mlock === true) args.push('--mlock')
  if (cfg.noMmap === true) args.push('--no-mmap')
  if (cfg.cacheTypeK !== undefined) args.push('--cache-type-k', cfg.cacheTypeK)
  if (cfg.cacheTypeV !== undefined) args.push('--cache-type-v', cfg.cacheTypeV)
  if (cfg.mmprojPath !== undefined) args.push('--mmproj', cfg.mmprojPath)
  // Last, so an operator reading `ps` sees their own additions at the end.
  // Never a flag `OWNED_FLAGS` claims — `checkExtraArgs` runs before start.
  args.push(...(cfg.extraArgs ?? []))
  return args
}

export class LlamaSupervisor {
  private readonly spawnFn: typeof nodeSpawn
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly pickPort: () => Promise<number>
  private readonly healthPollMs: number
  private readonly startTimeoutMs: number
  private readonly killGraceMs: number
  private readonly crashPolicy = new CrashPolicy(DEFAULT_CRASH_POLICY)
  private readonly supervisorId = 'llama'

  private child: ChildProcess | undefined
  private state: RuntimeState = 'stopped'
  private cfg: LlamaStartConfig | undefined
  private _port: number | undefined
  private lastError: string | undefined
  private lastActivity = 0
  private intentionalStop = false

  private healthGateTimer: ReturnType<typeof setTimeout> | undefined
  private startDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  private healthPollTimer: ReturnType<typeof setInterval> | undefined
  private idleTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: LlamaSupervisorDeps) {
    this.spawnFn = deps.spawnFn ?? nodeSpawn
    this.fetchFn = deps.fetchFn ?? fetch
    this.now = deps.now ?? Date.now
    this.pickPort = deps.pickPort ?? defaultPickPort
    this.healthPollMs = deps.healthPollMs ?? 15_000
    this.startTimeoutMs = deps.startTimeoutMs ?? 120_000
    this.killGraceMs = deps.killGraceMs ?? 5_000
  }

  get port(): number | undefined {
    return this._port
  }

  status(): LlmRuntimeStatus {
    return {
      nodeId: this.cfg?.nodeId ?? 'unknown',
      state: this.state,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      ...(this._port !== undefined ? { port: this._port } : {}),
      ...(this.cfg !== undefined
        ? { modelPath: this.cfg.modelPath, modelId: this.cfg.modelId }
        : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      crashesInWindow: this.crashPolicy.crashesInWindow(this.supervisorId, this.now()),
    }
  }

  noteActivity(): void {
    this.lastActivity = this.now()
  }

  private sameConfig(cfg: LlamaStartConfig): boolean {
    const c = this.cfg
    if (c === undefined) return false
    return (
      c.modelPath === cfg.modelPath &&
      c.mmprojPath === cfg.mmprojPath &&
      c.contextSize === cfg.contextSize &&
      c.gpuLayers === cfg.gpuLayers &&
      c.threads === cfg.threads &&
      c.parallel === cfg.parallel &&
      c.batchSize === cfg.batchSize &&
      c.ubatchSize === cfg.ubatchSize &&
      c.flashAttention === cfg.flashAttention &&
      c.mlock === cfg.mlock &&
      c.noMmap === cfg.noMmap &&
      c.cacheTypeK === cfg.cacheTypeK &&
      c.cacheTypeV === cfg.cacheTypeV
    )
  }

  async start(cfg: LlamaStartConfig): Promise<LlmRuntimeStatus> {
    if (this.state === 'ready' && this.sameConfig(cfg)) return this.status()
    if (this.child !== undefined) await this.stop()

    this.cfg = cfg
    this.lastError = undefined
    this.intentionalStop = false
    this.crashPolicy.reset(this.supervisorId)
    await this.spawnChild(cfg)
    return this.status()
  }

  private async spawnChild(cfg: LlamaStartConfig): Promise<void> {
    const port = await this.pickPort()
    this._port = port
    this.state = 'starting'
    const child = this.spawnFn(cfg.binaryPath, buildLlamaArgs(cfg, port), { stdio: 'pipe' })
    this.child = child

    // wrapChild lesson: a late async 'error' event must never crash the process.
    child.on('error', (err) => {
      this.deps.logger.warn('llama-server error event', { meta: { error: String(err) } })
    })
    child.stdout?.on('data', (chunk: Buffer) => this.logLines(chunk, false))
    child.stderr?.on('data', (chunk: Buffer) => this.logLines(chunk, true))
    child.on('exit', (code, signal) => this.onExit(code, signal))

    this.beginHealthGate(port)
  }

  private logLines(chunk: Buffer, isErr: boolean): void {
    for (const line of chunk.toString().split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (isErr) this.deps.logger.warn(trimmed)
      else this.deps.logger.debug(trimmed)
    }
  }

  private beginHealthGate(port: number): void {
    const deadlineAt = this.now() + this.startTimeoutMs
    const poll = async (): Promise<void> => {
      if (this.state !== 'starting') return
      if (this.now() >= deadlineAt) {
        this.lastError = `health gate timed out after ${this.startTimeoutMs}ms`
        this.deps.logger.warn(this.lastError)
        this.intentionalStop = true
        this.killChild('SIGKILL')
        this.state = 'crashed'
        return
      }
      const healthy = await this.probeHealth(port)
      if (this.state !== 'starting') return
      if (healthy) {
        this.onReady()
        return
      }
      this.healthGateTimer = setTimeout(() => void poll(), HEALTH_GATE_INTERVAL_MS)
      this.healthGateTimer.unref?.()
    }
    void poll()
  }

  private async probeHealth(port: number): Promise<boolean> {
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${port}/health`)
      return res.status === 200
    } catch {
      return false
    }
  }

  private onReady(): void {
    this.clearStartTimers()
    this.state = 'ready'
    this.lastError = undefined
    this.noteActivity()
    this.startHealthPoll()
    this.startIdleWatch()
  }

  private startHealthPoll(): void {
    this.healthPollTimer = setInterval(() => {
      if (this.state !== 'ready' || this._port === undefined) return
      void this.probeHealth(this._port).then((healthy) => {
        if (!healthy && this.state === 'ready') {
          this.deps.logger.warn('llama-server health poll failed → treating as crash')
          this.killChild('SIGKILL')
        }
      })
    }, this.healthPollMs)
    this.healthPollTimer.unref?.()
  }

  private startIdleWatch(): void {
    const cfg = this.cfg
    if (cfg === undefined || cfg.idleStopMinutes <= 0) return
    const idleMs = cfg.idleStopMinutes * 60_000
    this.idleTimer = setInterval(
      () => {
        if (this.state !== 'ready') return
        if (this.now() - this.lastActivity >= idleMs) {
          this.deps.logger.info('llama-server idle-stop')
          void this.stop()
        }
      },
      Math.min(idleMs, 30_000),
    )
    this.idleTimer.unref?.()
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearAllTimers()
    this.child = undefined
    if (this.intentionalStop) {
      this.state = 'stopped'
      return
    }
    this.deps.logger.warn('llama-server exited unexpectedly', { meta: { code, signal } })
    const decision = this.crashPolicy.recordCrash(this.supervisorId, this.now())
    if (decision.action === 'failed') {
      this.state = 'failed'
      this.lastError = `crash breaker tripped (${decision.crashesInWindow} crashes)`
      return
    }
    this.state = 'crashed'
    const cfg = this.cfg
    if (cfg === undefined) return
    const respawn = setTimeout(() => {
      if (this.state !== 'crashed') return
      void this.spawnChild(cfg).catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        this.state = 'crashed'
      })
    }, decision.backoffMs)
    respawn.unref?.()
  }

  private killChild(signal: NodeJS.Signals): void {
    this.child?.kill(signal)
  }

  async stop(): Promise<void> {
    this.intentionalStop = true
    this.clearAllTimers()
    this.crashPolicy.reset(this.supervisorId)
    const child = this.child
    if (child === undefined) {
      this.state = 'stopped'
      return
    }
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const grace = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, this.killGraceMs)
      grace.unref?.()
      child.once('exit', () => {
        clearTimeout(grace)
        resolve()
      })
    })
    this.child = undefined
    this.state = 'stopped'
  }

  private clearStartTimers(): void {
    if (this.healthGateTimer !== undefined) clearTimeout(this.healthGateTimer)
    if (this.startDeadlineTimer !== undefined) clearTimeout(this.startDeadlineTimer)
    this.healthGateTimer = undefined
    this.startDeadlineTimer = undefined
  }

  private clearAllTimers(): void {
    this.clearStartTimers()
    if (this.healthPollTimer !== undefined) clearInterval(this.healthPollTimer)
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.healthPollTimer = undefined
    this.idleTimer = undefined
  }
}
