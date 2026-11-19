/**
 * One `python/unifi_worker.py` process per UniFi controller, for the life of the connection.
 * Requests are one JSON line on stdin, answered by id on stdout (the worker serves them
 * concurrently); `push` lines are the websocket's live changes. A crash restarts the process
 * lazily (on the next request) until the same bound the Alexa worker uses, then every request
 * fails instead of looping. The password never travels here: `connect` names a 0600 file.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  type UnifiWorkerPush,
  type UnifiWorkerRequest,
  requestLine,
  workerAnswerSchema,
  workerFailureError,
  workerPushSchema,
} from './unifi-worker-protocol.js'

/** The pipes the channel uses; a test hands a fake. */
export interface UnifiWorkerChild {
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

export type UnifiWorkerSpawner = (pythonPath: string, scriptPath: string) => UnifiWorkerChild

export interface UnifiWorkerChannel {
  /** Send one request; resolves with the worker's `result`, rejects with a typed UniFi error. */
  request(body: UnifiWorkerRequest, timeoutMs?: number): Promise<unknown>
  /** Live lines from the worker. A worker that exits reports its channel `down`. */
  onPush(listener: (push: UnifiWorkerPush) => void): () => void
  /** Values to scrub from anything the child writes to stderr. */
  noteSecrets(secrets: readonly string[]): void
  stop(): void
  readonly failed: boolean
}

export interface UnifiWorkerChannelDeps {
  readonly pythonPath: string
  readonly scriptPath: string
  readonly logger: IScopedLogger
  readonly spawnChild?: UnifiWorkerSpawner
  readonly now?: () => number
  readonly maxCrashes?: number
  readonly windowMs?: number
}

/** The Alexa worker's bound: 5 exits within a minute and the worker is failed for good. */
export const UNIFI_WORKER_MAX_CRASHES = 5
export const UNIFI_WORKER_CRASH_WINDOW_MS = 60_000
/** A request the worker has not answered by then rejects its caller (a late answer is dropped). */
export const UNIFI_WORKER_REQUEST_TIMEOUT_MS = 45_000
const REDACTED = '‹redacted›'

interface Pending {
  readonly resolve: (result: unknown) => void
  readonly reject: (err: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Pure: true once `times` (this exit included) reaches the bound inside the window. */
export function workerCrashBoundReached(
  times: readonly number[],
  windowMs: number,
  maxCrashes: number,
  now: number,
): { readonly times: readonly number[]; readonly failed: boolean } {
  const recent = [...times.filter((t) => t >= now - windowMs), now]
  return { times: recent, failed: recent.length >= maxCrashes }
}

function wrapChild(child: ChildProcess): UnifiWorkerChild {
  const { stdin, stdout, stderr } = child
  if (stdin === null || stdout === null || stderr === null) {
    throw new Error('unifi worker spawn did not provide pipes')
  }
  stdin.on('error', () => undefined)
  return {
    stdin: { write: (chunk) => void stdin.write(chunk) },
    stdout: { on: (event, listener) => void stdout.on(event, listener) },
    stderr: { on: (event, listener) => void stderr.on(event, listener) },
    on(event, listener): void {
      if (event === 'close') child.on('close', listener)
      else child.on('error', listener)
    },
    kill: (signal) => void child.kill(signal),
  }
}

/** No secret on argv or in the environment: the child inherits only the process env. */
const defaultSpawn: UnifiWorkerSpawner = (pythonPath, scriptPath) =>
  wrapChild(spawn(pythonPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] }))

export function startUnifiWorkerChannel(deps: UnifiWorkerChannelDeps): UnifiWorkerChannel {
  const logger = deps.logger
  const now = deps.now ?? Date.now
  const spawnChild = deps.spawnChild ?? defaultSpawn
  const maxCrashes = deps.maxCrashes ?? UNIFI_WORKER_MAX_CRASHES
  const windowMs = deps.windowMs ?? UNIFI_WORKER_CRASH_WINDOW_MS

  let child: UnifiWorkerChild | null = null
  let buffer = ''
  let nextId = 1
  let stopped = false
  let failed = false
  let crashTimes: readonly number[] = []
  let secrets: readonly string[] = []
  const pending = new Map<string, Pending>()
  const listeners = new Set<(push: UnifiWorkerPush) => void>()

  const scrub = (text: string): string =>
    secrets.reduce((out, s) => (s.length === 0 ? out : out.split(s).join(REDACTED)), text)

  function deliver(push: UnifiWorkerPush): void {
    for (const listener of listeners) {
      try {
        listener(push)
      } catch (err) {
        logger.warn('unifi worker push listener failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  function rejectAll(err: Error): void {
    const waiting = [...pending.values()]
    pending.clear()
    for (const p of waiting) {
      clearTimeout(p.timer)
      p.reject(err)
    }
  }

  function acceptLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      logger.warn('unifi worker wrote a non-JSON line', {
        meta: { error: errMsg(err) },
      })
      return
    }
    if (typeof parsed === 'object' && parsed !== null && 'push' in parsed) {
      const push = workerPushSchema.safeParse(parsed)
      if (push.success) deliver(push.data)
      else
        logger.warn('unifi worker push failed its schema', {
          meta: { error: push.error.message },
        })
      return
    }
    const answer = workerAnswerSchema.safeParse(parsed)
    if (!answer.success) {
      logger.warn('unifi worker answer failed its schema', {
        meta: { error: answer.error.message },
      })
      return
    }
    const waiter = pending.get(answer.data.id)
    if (waiter === undefined) {
      logger.debug('unifi worker answer for no waiting request (late or unknown)', {
        meta: { id: answer.data.id },
      })
      return
    }
    pending.delete(answer.data.id)
    clearTimeout(waiter.timer)
    if (answer.data.ok) waiter.resolve(answer.data.result)
    else waiter.reject(workerFailureError(answer.data))
  }

  function onExit(spawned: UnifiWorkerChild, code: number | null): void {
    if (child !== spawned) return
    child = null
    deliver({ push: 'channel', state: 'down', reason: 'worker exited' })
    rejectAll(
      new Error(stopped ? 'unifi worker stopped' : `unifi worker exited (${code ?? 'null'})`),
    )
    if (stopped) return
    const decision = workerCrashBoundReached(crashTimes, windowMs, maxCrashes, now())
    crashTimes = decision.times
    if (decision.failed) {
      failed = true
      logger.error('unifi worker restart bound reached; the local account is unavailable', {
        meta: { crashes: crashTimes.length, windowMs },
      })
      return
    }
    logger.warn('unifi worker exited; it restarts on the next request', {
      meta: { code, crashes: crashTimes.length },
    })
  }

  function launch(): UnifiWorkerChild {
    const spawned = spawnChild(deps.pythonPath, deps.scriptPath)
    child = spawned
    buffer = ''
    let exited = false
    const exit = (code: number | null): void => {
      if (exited) return
      exited = true
      onExit(spawned, code)
    }
    spawned.stdout.on('data', (chunk) => {
      if (child !== spawned) return
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim().length > 0) acceptLine(line)
    })
    spawned.stderr.on('data', (chunk) => {
      const text = scrub(chunk.toString('utf8')).trim()
      if (text.length > 0)
        logger.warn('unifi worker stderr', {
          meta: { text: text.slice(0, 500) },
        })
    })
    spawned.on('error', (err) => {
      logger.warn('unifi worker spawn error', {
        meta: { error: scrub(err.message) },
      })
      exit(null)
    })
    spawned.on('close', (code) => exit(code))
    return spawned
  }

  return {
    request(body, timeoutMs = UNIFI_WORKER_REQUEST_TIMEOUT_MS): Promise<unknown> {
      if (failed) return Promise.reject(new Error('unifi worker restart bound reached'))
      if (stopped) return Promise.reject(new Error('unifi worker stopped'))
      const target = child ?? launch()
      const id = String(nextId++)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // not-a-state-poll: worker request deadline
          pending.delete(id)
          reject(new Error(`unifi worker did not answer ${body.op} within ${timeoutMs} ms`))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        target.stdin.write(requestLine(id, body))
      })
    },
    onPush(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    noteSecrets(next) {
      secrets = [...next]
    },
    stop() {
      stopped = true
      const current = child
      child = null
      current?.kill('SIGTERM')
      rejectAll(new Error('unifi worker stopped'))
    },
    get failed() {
      return failed
    },
  }
}
