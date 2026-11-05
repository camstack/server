/**
 * One Python process per broker, for the life of the addon. Requests are one JSON line
 * on stdin; responses are one JSON line on stdout, matched by id.
 * A crash restarts the process until the same bound CrashSupervisor uses,
 * then requests fail instead of looping.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import type { IScopedLogger } from '@camstack/types'
import {
  ECHO_COMMAND_DEADLINE_MS,
  ECHO_READ_DEADLINE_MS,
  WORKER_CRASH_WINDOW_MS,
  WORKER_MAX_CRASHES,
  WORKER_SLOW_REQUEST_MS,
} from './constants.js'
import { scrubSecrets } from './secret-file.js'
import {
  RATE_LIMITED_CODE,
  RateLimitedError,
  type WorkerLine,
  WorkerLineSchema,
  type WorkerRequest,
  requestLine,
} from './worker-protocol.js'

export interface WorkerChild {
  readonly stdin: { write(chunk: string): void }
  readonly stdout: {
    on(event: 'data', listener: (chunk: Buffer) => void): void
  }
  readonly stderr: {
    on(event: 'data', listener: (chunk: Buffer) => void): void
  }
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

/** Per-call knobs. Both are optional; an op without a default deadline waits as long as it takes. */
export interface WorkerRequestOptions {
  /** Numeric CamStack device id the call is for; tags the timing line. */
  readonly deviceId?: number
  /** Rejects the caller when the call has not started, or not finished, by then. */
  readonly deadlineMs?: number
}

export interface AlexaWorker {
  /**
   * One lane, one line in flight. A call not STARTED by its deadline is dropped
   * from the queue and never sent. A started one that overruns rejects its caller;
   * the lane stays held until the worker answers that id (the worker is serial), so
   * the late reply is dropped by id and never handed to the next call.
   * A queued `set_volume` is replaced by a newer one for the same serial (last wins),
   * a queued read is shared with an identical one, and a command goes ahead of queued reads.
   */
  request(request: WorkerRequest, options?: WorkerRequestOptions): Promise<unknown>
  /** Secrets currently in play, so a child traceback cannot be logged raw. */
  noteSecrets(secrets: readonly string[]): void
  stop(): void
  readonly failed: boolean
  readonly crashesInWindow: number
}

interface Waiter {
  readonly resolve: (result: unknown) => void
  readonly reject: (err: Error) => void
}

interface Entry {
  readonly id: string
  readonly request: WorkerRequest
  readonly key: string | null
  readonly isRead: boolean
  readonly deviceId: number | undefined
  readonly enqueuedAt: number
  sentAt: number | null
  waiters: Waiter[]
  /** The caller was already answered (deadline); the worker's reply is dropped. */
  abandoned: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const READ_OPS: ReadonlySet<WorkerRequest['op']> = new Set([
  'player_state',
  'device_volumes',
  'dnd_state',
  'devices',
  'session_status',
])

function coalesceKey(request: WorkerRequest): string | null {
  switch (request.op) {
    case 'set_volume':
    case 'player_state':
      return `${request.op}:${request.serial}`
    case 'device_volumes':
    case 'dnd_state':
    case 'devices':
    case 'session_status':
      return request.op
    default:
      return null
  }
}

function defaultDeadlineMs(request: WorkerRequest): number | undefined {
  if (request.op === 'set_volume' || request.op === 'np_command' || request.op === 'set_dnd') {
    return ECHO_COMMAND_DEADLINE_MS
  }
  if (READ_OPS.has(request.op) && request.op !== 'devices' && request.op !== 'session_status') {
    return ECHO_READ_DEADLINE_MS
  }
  return undefined
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
  let pending: Entry | null = null
  const queue: Entry[] = []

  function scrub(text: string): string {
    return scrubSecrets(text, secrets)
  }

  function clearTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }

  function timing(entry: Entry, outcome: string): void {
    const end = now()
    const queuedMs = (entry.sentAt ?? end) - entry.enqueuedAt
    const workerMs = entry.sentAt === null ? 0 : end - entry.sentAt
    const totalMs = end - entry.enqueuedAt
    const extras = {
      ...(entry.deviceId === undefined ? {} : { tags: { deviceId: entry.deviceId } }),
      meta: { op: entry.request.op, outcome, queuedMs, workerMs, totalMs },
    }
    if (totalMs > WORKER_SLOW_REQUEST_MS) logger.warn('alexa worker request was slow', extras)
    else logger.debug('alexa worker request', extras)
  }

  function settle(entry: Entry, outcome: string, error: Error | null, result?: unknown): void {
    clearTimer(entry)
    timing(entry, outcome)
    const waiters = entry.waiters
    entry.waiters = []
    for (const waiter of waiters) {
      if (error === null) waiter.resolve(result)
      else waiter.reject(error)
    }
  }

  function failPending(err: Error): void {
    const current = pending
    pending = null
    if (current !== null && !current.abandoned) settle(current, 'worker-gone', err)
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
      logger.warn('alexa worker stderr', {
        meta: { text: text.slice(0, 500) },
      })
    })
    spawned.on('error', (err) => {
      logger.warn('alexa worker spawn error', {
        meta: { error: scrub(err.message) },
      })
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
      logger.warn('alexa worker line failed schema', {
        meta: { error: checked.error.message },
      })
      return
    }
    const message: WorkerLine = checked.data
    if (pending === null || pending.id !== message.id) {
      logger.warn('alexa worker line for an unknown request', {
        meta: { id: message.id },
      })
      return
    }
    const current = pending
    pending = null
    if (current.abandoned) {
      logger.debug('alexa worker late reply dropped', {
        ...(current.deviceId === undefined ? {} : { tags: { deviceId: current.deviceId } }),
        meta: { op: current.request.op, lateMs: now() - current.enqueuedAt },
      })
    } else if (message.ok) settle(current, 'ok', null, message.result)
    else if (message.code === RATE_LIMITED_CODE) {
      settle(current, 'rate-limited', new RateLimitedError(scrub(message.error)))
    } else settle(current, 'error', new Error(scrub(message.error)))
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
        settle(item, 'worker-gone', new Error('alexa worker restart bound reached'))
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
    pending = next
    next.sentAt = now()
    child.stdin.write(requestLine(next.id, next.request))
  }

  function expire(entry: Entry, deadlineMs: number): void {
    if (pending === entry) {
      entry.abandoned = true
      settle(
        entry,
        'timeout-in-flight',
        new Error(`alexa worker call timed out after ${deadlineMs} ms`),
      )
      return
    }
    const at = queue.indexOf(entry)
    if (at < 0) return
    queue.splice(at, 1)
    settle(
      entry,
      'expired-queued',
      new Error(`alexa worker call not started within ${deadlineMs} ms`),
    )
  }

  function enqueue(entry: Entry): void {
    if (entry.isRead) {
      queue.push(entry)
      return
    }
    // A command goes ahead of every queued read, behind earlier commands.
    const firstRead = queue.findIndex((queued) => queued.isRead)
    if (firstRead < 0) queue.push(entry)
    else queue.splice(firstRead, 0, entry)
  }

  function request(body: WorkerRequest, options?: WorkerRequestOptions): Promise<unknown> {
    if (failed) return Promise.reject(new Error('alexa worker restart bound reached'))
    if (stopped) return Promise.reject(new Error('alexa worker stopped'))
    const key = coalesceKey(body)
    const isRead = READ_OPS.has(body.op)
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      const twin = key === null ? undefined : queue.find((queued) => queued.key === key)
      if (twin !== undefined && isRead) {
        // The same read is already waiting for the lane: share it.
        twin.waiters.push(waiter)
        return
      }
      const id = String(nextId)
      nextId += 1
      const entry: Entry = {
        id,
        request: body,
        key,
        isRead,
        deviceId: options?.deviceId,
        enqueuedAt: now(),
        sentAt: null,
        waiters: [waiter],
        abandoned: false,
        timer: null,
      }
      if (twin !== undefined) {
        // Last wins: the newer set replaces the queued one; its caller gets the newer outcome.
        queue.splice(queue.indexOf(twin), 1)
        clearTimer(twin)
        entry.waiters = [...twin.waiters, waiter]
        logger.debug('alexa worker queued call replaced by a newer one', {
          ...(twin.deviceId === undefined ? {} : { tags: { deviceId: twin.deviceId } }),
          meta: { op: body.op },
        })
      }
      const deadlineMs = options?.deadlineMs ?? defaultDeadlineMs(body)
      if (deadlineMs !== undefined) {
        entry.timer = setTimeout(() => expire(entry, deadlineMs), deadlineMs)
        entry.timer.unref()
      }
      enqueue(entry)
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
      for (const item of waiting) settle(item, 'worker-gone', new Error('alexa worker stopped'))
    },
    get failed(): boolean {
      return failed
    },
    get crashesInWindow(): number {
      return crashTimes.length
    },
  }
}
