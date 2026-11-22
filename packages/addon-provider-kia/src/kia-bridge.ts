import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { z } from 'zod'
import type { KiaConfig } from './config.js'

/**
 * The Kia Python bridge: ONE long-lived `python/kia_worker.py` per Kia account, built on the
 * `hyundai-kia-connect-api` library (pinned in `python/requirements.txt`). A request is one JSON
 * line on stdin, an answer one JSON line on stdout matched by id. There is no push channel: the
 * caller decides when to read again, because every cloud call counts against a daily quota.
 *
 * The password and the PIN travel ONLY in the `login` line written to the child's stdin, never
 * in argv, never in the environment, and the worker never prints them.
 */

const Nullable = {
  number: z.number().nullable(),
  boolean: z.boolean().nullable(),
} as const

const CornersSchema = z.object({
  frontLeft: Nullable.boolean,
  frontRight: Nullable.boolean,
  rearLeft: Nullable.boolean,
  rearRight: Nullable.boolean,
})
export type KiaCorners = z.infer<typeof CornersSchema>

/** What the car last REPORTED to the maker cloud, SI units, null where the cloud says nothing. */
export const KiaVehicleStateSchema = z.object({
  odometerM: Nullable.number,
  rangeM: Nullable.number,
  fuelLevelPct: Nullable.number,
  fuelLow: Nullable.boolean,
  engineOn: Nullable.boolean,
  doors: CornersSchema,
  windows: CornersSchema,
  trunkOpen: Nullable.boolean,
  hoodOpen: Nullable.boolean,
  sunroofOpen: Nullable.boolean,
  tyreWarnings: CornersSchema,
  auxBatteryPct: Nullable.number,
  locked: Nullable.boolean,
  climateOn: Nullable.boolean,
  climateTargetC: Nullable.number,
  washerFluidLow: Nullable.boolean,
  brakeFluidLow: Nullable.boolean,
  smartKeyBatteryLow: Nullable.boolean,
  nextServiceM: Nullable.number,
  latitude: Nullable.number,
  longitude: Nullable.number,
  fixAtMs: Nullable.number,
  reportedAtMs: Nullable.number,
})
export type KiaVehicleState = z.infer<typeof KiaVehicleStateSchema>

const BridgeVehicleSchema = z.object({
  vehicleId: z.string().min(1),
  vin: z.string().nullable(),
  name: z.string(),
  model: z.string(),
  year: z.number().nullable(),
  engineType: z.string().nullable(),
  state: KiaVehicleStateSchema,
})
export type KiaBridgeVehicle = z.infer<typeof BridgeVehicleSchema>

const LoginResultSchema = z.object({ vehicles: z.array(BridgeVehicleSchema) })
const StatesResultSchema = z.object({ states: z.record(z.string(), KiaVehicleStateSchema) })
const StateResultSchema = z.object({ state: KiaVehicleStateSchema })
const CommandResultSchema = z.object({
  outcome: z.enum(['success', 'unknown']),
  state: KiaVehicleStateSchema,
})
export type KiaCommandResult = z.infer<typeof CommandResultSchema>

const FailureCode = z.enum([
  'auth',
  'otp-required',
  'rate-limited',
  'unreachable',
  'rejected',
  'vehicle-unreachable',
  'unknown-vehicle',
  'unsupported',
  'bad-request',
  'not-logged-in',
  'api',
])
export type KiaBridgeErrorCode = z.infer<typeof FailureCode> | 'timeout' | 'exited' | 'protocol'

const AnswerSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), code: FailureCode, error: z.string() }),
])

/** A failed bridge call. The message never carries more than a short stderr tail. */
export class KiaBridgeError extends Error {
  readonly name = 'KiaBridgeError'
  readonly code: KiaBridgeErrorCode
  constructor(code: KiaBridgeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** One command the worker maps onto the library action of the car. */
export type KiaCommand =
  | { readonly command: 'lock' }
  | { readonly command: 'unlock' }
  | {
      readonly command: 'climate-start'
      readonly temperature?: number
      readonly durationMinutes?: number
    }
  | { readonly command: 'climate-stop' }

export interface KiaBridge {
  /** Start the worker, sign in; resolves with every vehicle of the account and its state. */
  login(config: KiaConfig): Promise<readonly KiaBridgeVehicle[]>
  /** The cloud's CACHED state of every vehicle: never wakes a car. */
  read(): Promise<Readonly<Record<string, KiaVehicleState>>>
  /** Wake ONE car and read it. Costs real quota and the car's 12 V battery. */
  refresh(vehicleId: string): Promise<KiaVehicleState>
  /** Send one command and wait for the car's answer; resolves with the read-back state. */
  command(vehicleId: string, command: KiaCommand): Promise<KiaCommandResult>
  /** Stop the worker. Safe to call twice. */
  close(): void
}

export type KiaSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface KiaBridgeDeps {
  readonly pythonPath: string
  readonly scriptPath: string
  readonly spawnFn?: KiaSpawn
  readonly loginTimeoutMs?: number
  readonly commandTimeoutMs?: number
  readonly readTimeoutMs?: number
}

const DEFAULT_LOGIN_TIMEOUT_MS = 90_000
/** The worker itself waits up to 30 s for the car's answer, then reads once. */
const DEFAULT_COMMAND_TIMEOUT_MS = 75_000
const DEFAULT_READ_TIMEOUT_MS = 90_000
const MAX_STDERR_BYTES = 16 * 1024
const STDERR_TAIL = 300

interface Waiter {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: KiaBridgeError) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export function createKiaBridge(deps: KiaBridgeDeps): KiaBridge {
  const spawnFn = deps.spawnFn ?? nodeSpawn
  const timeouts = {
    login: deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    command: deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    read: deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  }
  const waiters = new Map<string, Waiter>()
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let stdoutBuffer = ''
  let stderrTail = ''
  let closed = false

  function failAll(error: KiaBridgeError): void {
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
    const answer = AnswerSchema.safeParse(json)
    if (!answer.success) return
    const waiter = waiters.get(answer.data.id)
    if (waiter === undefined) return
    waiters.delete(answer.data.id)
    clearTimeout(waiter.timer)
    if (answer.data.ok) waiter.resolve(answer.data.result)
    else waiter.reject(new KiaBridgeError(answer.data.code, answer.data.error))
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
      failAll(new KiaBridgeError('exited', `cannot start the Kia bridge: ${err.message}`))
    })
    spawned.on('close', (code) => {
      if (child !== spawned) return
      child = null
      const tail = stderrTail.trim().slice(-STDERR_TAIL) || 'no stderr'
      failAll(new KiaBridgeError('exited', `the Kia bridge exited (${code ?? 'null'}): ${tail}`))
    })
    return spawned
  }

  function request(body: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown> {
    if (closed) return Promise.reject(new KiaBridgeError('exited', 'the Kia bridge is closed'))
    const target = child ?? start()
    return new Promise<unknown>((resolve, reject) => {
      const id = String(nextId)
      nextId += 1
      const timer = setTimeout(() => {
        // not-a-state-poll: the deadline of one bridge request
        waiters.delete(id)
        reject(
          new KiaBridgeError(
            'timeout',
            `the Kia bridge did not answer within ${timeoutMs / 1000}s`,
          ),
        )
      }, timeoutMs)
      waiters.set(id, { resolve, reject, timer })
      target.stdin.write(`${JSON.stringify({ id, ...body })}\n`)
    })
  }

  function parse<T>(schema: z.ZodType<T>, result: unknown): T {
    const parsed = schema.safeParse(result)
    if (!parsed.success) {
      throw new KiaBridgeError('protocol', 'the Kia bridge answered an unknown shape')
    }
    return parsed.data
  }

  return {
    async login(config) {
      const result = await request(
        {
          op: 'login',
          username: config.username,
          password: config.password,
          pin: config.pin,
          region: config.region,
          brand: config.brand,
        },
        timeouts.login,
      )
      return parse(LoginResultSchema, result).vehicles
    },
    async read() {
      return parse(StatesResultSchema, await request({ op: 'read' }, timeouts.read)).states
    },
    async refresh(vehicleId) {
      const result = await request({ op: 'refresh', vehicleId }, timeouts.read)
      return parse(StateResultSchema, result).state
    },
    async command(vehicleId, command) {
      const result = await request({ op: 'command', vehicleId, ...command }, timeouts.command)
      return parse(CommandResultSchema, result)
    },
    close() {
      if (closed) return
      closed = true
      const current = child
      child = null
      failAll(new KiaBridgeError('exited', 'the Kia bridge is closed'))
      if (current === null) return
      current.stdin.end()
      setTimeout(() => current.kill('SIGKILL'), 5_000).unref() // not-a-state-poll: grace before a stuck worker is killed
    },
  }
}
