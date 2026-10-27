/**
 * One Python process per broker, for the life of the addon. Requests are one JSON line
 * on stdin; responses are one JSON line on stdout, matched by id.
 * A crash restarts the process until the same bound CrashSupervisor uses,
 * then requests fail instead of looping.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import type { IScopedLogger } from '@camstack/types'
import { WORKER_CRASH_WINDOW_MS, WORKER_MAX_CRASHES } from './constants.js'
import { scrubSecrets } from './secret-file.js'
import {
  type WorkerLine,
  WorkerLineSchema,
  type WorkerRequest,
  requestLine,
} from './worker-protocol.js'

export interface WorkerChild {
  readonly stdin: { write(chunk: string): void }
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  kill(signal?: NodeJS.Signals): void
}

export type WorkerSpawner = (
  pythonPath: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
) => WorkerChild

export interface AlexaWorkerDeps {
  readonly pythonPath: string
  readonly scriptPath: string
  readonly spawnChild?: WorkerSpawner
  readonly logger?: IScopedLogger
  readonly now?: () => number
  readonly schedule?: (fn: () => void, delayMs: number) => void
  readonly maxCrashes?: number
  readonly windowMs?: number
  /** Inherited by the child. A secret is never added here. */
  readonly env?: NodeJS.ProcessEnv
}

export interface AlexaWorker {
  request(request: WorkerRequest): Promise<unknown>
  /** Secrets currently in play, so a child traceback cannot be logged raw. */
  noteSecrets(secrets: readonly string[]): void
  stop(): void
  readonly failed: boolean
  readonly crashesInWindow: number
}

interface Pending {
  readonly id: string
  readonly resolve: (result: unknown) => void
  readonly reject: (err: Error) => void
}

interface CrashDecision {
  readonly action: 'respawn' | 'failed'
  readonly times: readonly number[]
}

/** Pure: a new timestamp list, never a mutated one. */
export function recordWorkerCrash(
  times: readonly number[],
  now: number,
  windowMs: number,
  maxCrashes: number,
): CrashDecision {
  const cutoff = now - windowMs
  const recent = [...times.filter((t) => t >= cutoff), now]
  if (recent.length >= maxCrashes) return { action: 'failed', times: recent }
  return { action: 'respawn', times: recent }
}

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger
    },
    withTags() {
      return logger
    },
  }
  return logger
}

function wrapChild(child: ChildProcess): WorkerChild {
  const stdin = child.stdin
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdin === null || stdout === null || stderr === null) {
    throw new Error('alexa worker spawn did not provide pipes')
  }
  return {
    stdin: {
      write(chunk: string): void {
        stdin.write(chunk)
      },
    },
    stdout: {
      on(event, listener): void {
        stdout.on(event, listener)
      },
    },
    stderr: {
      on(event, listener): void {
        stderr.on(event, listener)
      },
    },
    on(event, listener): void {
      if (event === 'close') child.on('close', listener)
      else child.on('error', listener)
    },
    kill(signal): void {
      child.kill(signal)
    },
  }
}

function defaultSpawn(pythonPath: string, scriptPath: string, env: NodeJS.ProcessEnv): WorkerChild {
  return wrapChild(
    spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }),
  )
}

export function startAlexaWorker(deps: AlexaWorkerDeps): AlexaWorker {
  const logger = deps.logger ?? quietLogger()
  const now = deps.now ?? (() => Date.now())
  const schedule =
    deps.schedule ??
    ((fn, delayMs) => {
      setTimeout(fn, delayMs)
    })
  const spawnChild = deps.spawnChild ?? defaultSpawn
  const maxCrashes = deps.maxCrashes ?? WORKER_MAX_CRASHES
  const windowMs = deps.windowMs ?? WORKER_CRASH_WINDOW_MS
  const env = deps.env ?? process.env

  let child: WorkerChild | null = null
  let buffer = ''
  let nextId = 1
  let stopped = false
  let failed = false
  let crashTimes: readonly number[] = []
  let secrets: readonly string[] = []
  let pending: Pending | null = null
  const queue: Array<{ request: WorkerRequest; pending: Pending }> = []

  function scrub(text: string): string {
    return scrubSecrets(text, secrets)
  }

  function failPending(err: Error): void {
    const current = pending
    pending = null
    current?.reject(err)
  }

  function attach(spawned: WorkerChild): void {
    child = spawned
    buffer = ''
    let settled = false
    const finish = (code: number | null): void => {
      if (settled || child !== spawned) return
      settled = true
      onExit(code)
    }
    spawned.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        acceptLine(line)
      }
    })
    spawned.stderr.on('data', (chunk) => {
      const text = scrub(chunk.toString('utf8')).trim()
      if (text.length === 0) return
      logger.warn('alexa worker stderr', { meta: { text: text.slice(0, 500) } })
    })
    spawned.on('error', (err) => {
      logger.warn('alexa worker spawn error', { meta: { error: scrub(err.message) } })
      finish(null)
    })
    spawned.on('close', (code) => {
      finish(code)
    })
  }

  function acceptLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      logger.warn('alexa worker non-JSON line', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    const checked = WorkerLineSchema.safeParse(parsed)
    if (!checked.success) {
      logger.warn('alexa worker line failed schema', { meta: { error: checked.error.message } })
      return
    }
    const message: WorkerLine = checked.data
    if (pending === null || pending.id !== message.id) {
      logger.warn('alexa worker line for an unknown request', { meta: { id: message.id } })
      return
    }
    const current = pending
    pending = null
    if (message.ok) current.resolve(message.result)
    else current.reject(new Error(scrub(message.error)))
    pump()
  }

  function onExit(code: number | null): void {
    child = null
    if (stopped) {
      failPending(new Error('alexa worker stopped'))
      return
    }
    failPending(new Error(`alexa worker exited (${code ?? 'null'})`))
    const decision = recordWorkerCrash(crashTimes, now(), windowMs, maxCrashes)
    crashTimes = decision.times
    if (decision.action === 'failed') {
      failed = true
      logger.error('alexa worker restart bound reached', {
        meta: { crashes: crashTimes.length },
      })
      const waiting = queue.splice(0, queue.length)
      for (const item of waiting)
        item.pending.reject(new Error('alexa worker restart bound reached'))
      return
    }
    logger.warn('alexa worker exited; restarting', {
      meta: { code, crashes: crashTimes.length },
    })
    const delay = Math.min(30_000, 500 * 2 ** Math.min(6, crashTimes.length - 1))
    schedule(() => {
      if (stopped || failed) return
      launch()
      pump()
    }, delay)
  }

  function launch(): void {
    if (stopped || failed) return
    attach(spawnChild(deps.pythonPath, deps.scriptPath, env))
  }

  function pump(): void {
    if (pending !== null || child === null || failed || stopped) return
    const next = queue.shift()
    if (next === undefined) return
    pending = next.pending
    child.stdin.write(requestLine(next.pending.id, next.request))
  }

  function request(body: WorkerRequest): Promise<unknown> {
    if (failed) return Promise.reject(new Error('alexa worker restart bound reached'))
    if (stopped) return Promise.reject(new Error('alexa worker stopped'))
    const id = String(nextId)
    nextId += 1
    return new Promise((resolve, reject) => {
      queue.push({ request: body, pending: { id, resolve, reject } })
      if (child === null) launch()
      pump()
    })
  }

  return {
    request,
    noteSecrets(next: readonly string[]): void {
      secrets = [...next]
    },
    stop(): void {
      stopped = true
      const current = child
      child = null
      current?.kill('SIGTERM')
      failPending(new Error('alexa worker stopped'))
      const waiting = queue.splice(0, queue.length)
      for (const item of waiting) item.pending.reject(new Error('alexa worker stopped'))
    },
    get failed(): boolean {
      return failed
    },
    get crashesInWindow(): number {
      return crashTimes.length
    },
  }
}
