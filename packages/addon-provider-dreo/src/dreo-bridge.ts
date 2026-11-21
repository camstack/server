import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { z } from 'zod'
import type { DreoConfig } from './config.js'

/**
 * The Dreo Python bridge: ONE long-lived `python/dreo_worker.py` per Dreo account, built on
 * the MIT `pydreo-community` library (pinned in `python/requirements.txt`). Requests are one
 * JSON line on stdin, answers one JSON line on stdout matched by id; the worker also pushes
 * lines of its own (device state, the WebSocket channel going up or down).
 *
 * The password travels ONLY in the `login` line written to the child's stdin — never in argv,
 * never in the environment — and the worker never prints it. Nothing here is a frame-rate
 * path: a state line is a handful of numbers.
 */

export const DreoDeviceStateSchema = z.object({
  on: z.boolean().nullable(),
  speed: z.number().nullable(),
  speedMin: z.number().nullable(),
  speedMax: z.number().nullable(),
  oscillating: z.boolean().nullable(),
  /** Degrees Celsius, whatever unit the account reports in. */
  temperature: z.number().nullable(),
  humidity: z.number().nullable(),
  pm25: z.number().nullable(),
  connected: z.boolean().nullable(),
})
export type DreoDeviceState = z.infer<typeof DreoDeviceStateSchema>

const BridgeDeviceSchema = z.object({
  deviceId: z.string().min(1),
  model: z.string(),
  name: z.string(),
  /** False for a model the library has no device class for: it has no state to read. */
  supported: z.boolean(),
  state: DreoDeviceStateSchema,
})
export type DreoBridgeDevice = z.infer<typeof BridgeDeviceSchema>

const LoginResultSchema = z.object({ devices: z.array(BridgeDeviceSchema) })
const StatesResultSchema = z.object({ states: z.record(z.string(), DreoDeviceStateSchema) })

const FailureCode = z.enum([
  'auth',
  'unreachable',
  'rejected',
  'unknown-device',
  'unsupported',
  'bad-request',
  'not-logged-in',
  'api',
])
export type DreoBridgeErrorCode = z.infer<typeof FailureCode> | 'timeout' | 'exited' | 'protocol'

const AnswerSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), code: FailureCode, error: z.string() }),
])

const PushSchema = z.discriminatedUnion('push', [
  z.object({ push: z.literal('state'), deviceId: z.string(), state: DreoDeviceStateSchema }),
  z.object({ push: z.literal('channel'), state: z.enum(['up', 'down']) }),
])
/** An unsolicited line from the worker. `exited` is the bridge's own: the process is gone. */
export type DreoPush =
  | z.infer<typeof PushSchema>
  | { readonly push: 'exited'; readonly code: number | null }

/** A failed bridge call. The message never carries more than a short stderr tail. */
export class DreoBridgeError extends Error {
  readonly name = 'DreoBridgeError'
  readonly code: DreoBridgeErrorCode
  constructor(code: DreoBridgeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** One command the worker maps onto the library setter of the model. */
export type DreoCommand =
  | { readonly command: 'power'; readonly value: boolean }
  | { readonly command: 'speed'; readonly value: number }
  | { readonly command: 'oscillating'; readonly value: boolean }

export interface DreoBridge {
  /** Start the worker, sign in, open the push channel; resolves with every device of the account. */
  login(config: DreoConfig): Promise<readonly DreoBridgeDevice[]>
  command(deviceId: string, command: DreoCommand): Promise<void>
  /** Read every device again from the cloud (not from the library's cache). */
  refresh(): Promise<Readonly<Record<string, DreoDeviceState>>>
  onPush(listener: (push: DreoPush) => void): void
  /** Stop the worker. Safe to call twice. */
  close(): void
}

export type DreoSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface DreoBridgeDeps {
  readonly pythonPath: string
  readonly scriptPath: string
  readonly spawnFn?: DreoSpawn
  readonly loginTimeoutMs?: number
  readonly commandTimeoutMs?: number
  readonly readTimeoutMs?: number
}

/** A sign-in plus the device list plus one state read per device. */
const DEFAULT_LOGIN_TIMEOUT_MS = 60_000
/** The library waits up to 2 s for an ack, three times. */
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000
const DEFAULT_READ_TIMEOUT_MS = 60_000
const MAX_STDERR_BYTES = 16 * 1024
const STDERR_TAIL = 300

interface Waiter {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: DreoBridgeError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export function createDreoBridge(deps: DreoBridgeDeps): DreoBridge {
  const spawnFn = deps.spawnFn ?? nodeSpawn
  const timeouts = {
    login: deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    command: deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    read: deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  }
  const listeners: Array<(push: DreoPush) => void> = []
  const waiters = new Map<string, Waiter>()
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let stdoutBuffer = ''
  let stderrTail = ''
  let closed = false

  function deliver(push: DreoPush): void {
    for (const listener of listeners) listener(push)
  }

  function failAll(error: DreoBridgeError): void {
    for (const [id, waiter] of [...waiters]) {
      waiters.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  function acceptLine(line: string): void {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      return
    }
    if (typeof json === 'object' && json !== null && 'push' in json) {
      const push = PushSchema.safeParse(json)
      if (push.success) deliver(push.data)
      return
    }
    const answer = AnswerSchema.safeParse(json)
    if (!answer.success) return
    const waiter = waiters.get(answer.data.id)
    if (waiter === undefined) return
    waiters.delete(answer.data.id)
    clearTimeout(waiter.timer)
    if (answer.data.ok) waiter.resolve(answer.data.result)
    else waiter.reject(new DreoBridgeError(answer.data.code, answer.data.error))
  }

  function start(): ChildProcessWithoutNullStreams {
    const spawned = spawnFn(deps.pythonPath, [deps.scriptPath], { stdio: 'pipe' })
    child = spawned
    spawned.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') acceptLine(line)
    })
    spawned.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    spawned.stdin.on('error', () => undefined)
    spawned.on('error', (err) => {
      failAll(new DreoBridgeError('exited', `cannot start the Dreo bridge: ${err.message}`))
    })
    spawned.on('close', (code) => {
      if (child !== spawned) return
      child = null
      const tail = stderrTail.trim().slice(-STDERR_TAIL) || 'no stderr'
      failAll(new DreoBridgeError('exited', `the Dreo bridge exited (${code ?? 'null'}): ${tail}`))
      if (!closed) deliver({ push: 'exited', code })
    })
    return spawned
  }

  function request(body: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown> {
    if (closed) return Promise.reject(new DreoBridgeError('exited', 'the Dreo bridge is closed'))
    const target = child ?? start()
    return new Promise<unknown>((resolve, reject) => {
      const id = String(nextId)
      nextId += 1
      const timer = setTimeout(() => {
        // not-a-state-poll: the deadline of one bridge request
        waiters.delete(id)
        reject(
          new DreoBridgeError(
            'timeout',
            `the Dreo bridge did not answer within ${timeoutMs / 1000}s`,
          ),
        )
      }, timeoutMs)
      waiters.set(id, { resolve, reject, timer })
      target.stdin.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }

  return {
    async login(config) {
      const result = await request(
        { op: 'login', email: config.email, password: config.password, region: config.region },
        timeouts.login,
      )
      const parsed = LoginResultSchema.safeParse(result)
      if (!parsed.success)
        throw new DreoBridgeError('protocol', 'the Dreo bridge answered an unknown shape')
      return parsed.data.devices
    },
    async command(deviceId, command) {
      await request({ op: 'command', deviceId, ...command }, timeouts.command)
    },
    async refresh() {
      const result = await request({ op: 'refresh' }, timeouts.read)
      const parsed = StatesResultSchema.safeParse(result)
      if (!parsed.success)
        throw new DreoBridgeError('protocol', 'the Dreo bridge answered an unknown shape')
      return parsed.data.states
    },
    onPush(listener) {
      listeners.push(listener)
    },
    close() {
      if (closed) return
      closed = true
      const current = child
      child = null
      failAll(new DreoBridgeError('exited', 'the Dreo bridge is closed'))
      if (current === null) return
      current.stdin.end()
      setTimeout(() => current.kill('SIGKILL'), 5_000).unref() // not-a-state-poll: grace before a stuck worker is killed
    },
  }
}
