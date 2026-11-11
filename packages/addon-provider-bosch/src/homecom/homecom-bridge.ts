import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { z } from 'zod'

/**
 * The HomeCom Python bridge: one `python/homecom_worker.py` run per poll or write, built on
 * the MIT `homecom_alt` library (pinned in `python/requirements.txt`).
 *
 * The access token travels ONLY in the JSON written to the child's stdin — never in argv,
 * never in the environment — and the worker never prints it. The OAuth refresh stays in
 * TypeScript: the worker answers `auth` and the caller refreshes and runs it again.
 */

export const HOMECOM_BRIDGE_DEVICE_TYPES = ['k40', 'k30', 'icom'] as const
export type HomeComBridgeDeviceType = (typeof HOMECOM_BRIDGE_DEVICE_TYPES)[number]

export function isBridgeDeviceType(value: string | undefined): value is HomeComBridgeDeviceType {
  return HOMECOM_BRIDGE_DEVICE_TYPES.some((type) => type === value)
}

const SettingSchema = z.object({
  value: z.union([z.string(), z.number()]).nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  allowed: z.array(z.string()),
  writeable: z.boolean().nullable(),
})
export type HomeComBridgeSetting = z.infer<typeof SettingSchema>

const MaybeSetting = SettingSchema.nullable()

const HeatingCircuitSchema = z.object({
  id: z.string(),
  operationMode: MaybeSetting,
  heatCoolMode: MaybeSetting,
  currentSuWiMode: MaybeSetting,
  suWiSwitchMode: MaybeSetting,
  roomTemp: z.number().nullable(),
  humidity: z.number().nullable(),
  currentRoomSetpoint: MaybeSetting,
  manualRoomSetpoint: MaybeSetting,
  coolingRoomSetpoint: MaybeSetting,
  comfortSetpoint: MaybeSetting,
  ecoSetpoint: MaybeSetting,
  maxFlowTemp: MaybeSetting,
})
export type HomeComBridgeHeatingCircuit = z.infer<typeof HeatingCircuitSchema>

const DhwCircuitSchema = z.object({
  id: z.string(),
  operationMode: MaybeSetting,
  actualTemp: z.number().nullable(),
  currentTemperatureLevel: MaybeSetting,
  charge: MaybeSetting,
  chargeDuration: MaybeSetting,
  singleChargeSetpoint: MaybeSetting,
  currentSetpoint: MaybeSetting,
  temperatureLevels: z.record(z.string(), SettingSchema),
})
export type HomeComBridgeDhwCircuit = z.infer<typeof DhwCircuitSchema>

const ReadingSchema = z.object({
  heatSource: z.object({
    heatPumpType: z.string().nullable(),
    supplyTemp: z.number().nullable(),
    returnTemp: z.number().nullable(),
    modulationPct: z.number().nullable(),
    pressureBar: z.number().nullable(),
    starts: z.number().nullable(),
    outdoorTemp: z.number().nullable(),
    thermalKwh: z.number().nullable(),
    electricalKwh: z.number().nullable(),
  }),
  system: z.object({
    away: MaybeSetting,
    silent: MaybeSetting,
    additionalHeater: MaybeSetting,
    holiday: MaybeSetting,
  }),
  heatingCircuits: z.array(HeatingCircuitSchema),
  dhwCircuits: z.array(DhwCircuitSchema),
})
export type HomeComBridgeReading = z.infer<typeof ReadingSchema>

const FailureKind = z.enum(['auth', 'unreachable', 'refused', 'api', 'protocol', 'bad-request'])

const AnswerSchema = z.union([
  z.object({ ok: z.literal(true), reading: ReadingSchema }),
  z.object({ ok: z.literal(true), written: z.string() }),
  z.object({ ok: z.literal(false), kind: FailureKind, error: z.string() }),
])

export type HomeComBridgeErrorKind = z.infer<typeof FailureKind> | 'timeout'

/** A failed bridge run. The message never carries more than a short stderr tail. */
export class HomeComBridgeError extends Error {
  readonly name = 'HomeComBridgeError'
  readonly kind: HomeComBridgeErrorKind
  constructor(kind: HomeComBridgeErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

type CircuitTextOp =
  | 'hcOperationMode'
  | 'hcHeatCoolMode'
  | 'hcSuWiSwitchMode'
  | 'dhwOperationMode'
  | 'dhwTemperatureLevel'
  | 'dhwCharge'
type CircuitNumberOp =
  | 'hcManualRoomSetpoint'
  | 'hcCoolingRoomSetpoint'
  | 'hcComfortSetpoint'
  | 'hcEcoSetpoint'
  | 'hcMaxFlowTemp'
  | 'dhwChargeDuration'
export type HomeComSystemOp = 'awayMode' | 'silentMode' | 'additionalHeaterMode' | 'holidayMode'

/** One named write; the worker maps each op onto the library method that PUTs it. */
export type HomeComBridgeWrite =
  | {
      readonly op: CircuitTextOp
      readonly circuitId: string
      readonly value: string
    }
  | {
      readonly op: CircuitNumberOp
      readonly circuitId: string
      readonly value: number
    }
  | {
      readonly op: 'dhwLevelTemp'
      readonly circuitId: string
      readonly level: string
      readonly value: number
    }
  | { readonly op: HomeComSystemOp; readonly value: string }

export interface HomeComBridgeTarget {
  readonly token: string
  readonly gatewayId: string
  readonly deviceType: HomeComBridgeDeviceType
}

export interface HomeComBridge {
  read(target: HomeComBridgeTarget): Promise<HomeComBridgeReading>
  write(target: HomeComBridgeTarget, write: HomeComBridgeWrite): Promise<void>
}

export type HomeComSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface HomeComBridgeDeps {
  readonly pythonPath: string
  readonly scriptPath: string
  readonly readTimeoutMs?: number
  readonly writeTimeoutMs?: number
  readonly spawnFn?: HomeComSpawn
}

/** A K40 bulk read is several bulk POSTs plus per-circuit GETs, 15 s each at most. */
const DEFAULT_READ_TIMEOUT_MS = 50_000
const DEFAULT_WRITE_TIMEOUT_MS = 30_000
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const STDERR_TAIL = 300

type Answer = z.infer<typeof AnswerSchema>

function runWorker(
  deps: HomeComBridgeDeps,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Answer> {
  const spawnFn = deps.spawnFn ?? nodeSpawn
  return new Promise<Answer>((resolve, reject) => {
    const child = spawnFn(deps.pythonPath, [deps.scriptPath], {
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() =>
        reject(
          new HomeComBridgeError(
            'timeout',
            `the HomeCom bridge did not answer within ${timeoutMs / 1000}s`,
          ),
        ),
      )
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL')
        finish(() =>
          reject(new HomeComBridgeError('protocol', 'the HomeCom bridge wrote too much output')),
        )
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    child.on('error', (err) => {
      finish(() =>
        reject(
          new HomeComBridgeError('protocol', `cannot start the HomeCom bridge: ${err.message}`),
        ),
      )
    })
    child.on('close', (code) => {
      finish(() => {
        let json: unknown
        try {
          json = JSON.parse(stdout.trim())
        } catch {
          const tail = stderr.trim().slice(-STDERR_TAIL) || 'no stderr'
          reject(
            new HomeComBridgeError(
              'protocol',
              `the HomeCom bridge produced no JSON (exit ${code ?? 'null'}): ${tail}`,
            ),
          )
          return
        }
        const parsed = AnswerSchema.safeParse(json)
        if (!parsed.success) {
          reject(new HomeComBridgeError('protocol', 'the HomeCom bridge answered an unknown shape'))
          return
        }
        resolve(parsed.data)
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(request))
  })
}

function failure(answer: Answer): HomeComBridgeError | null {
  return answer.ok ? null : new HomeComBridgeError(answer.kind, answer.error)
}

export function createHomeComBridge(deps: HomeComBridgeDeps): HomeComBridge {
  const readTimeoutMs = deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  const writeTimeoutMs = deps.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS
  return {
    async read(target) {
      const answer = await runWorker(deps, { ...target, action: 'read' }, readTimeoutMs)
      const failed = failure(answer)
      if (failed !== null) throw failed
      if (!('reading' in answer)) {
        throw new HomeComBridgeError(
          'protocol',
          'the HomeCom bridge answered a read with no reading',
        )
      }
      return answer.reading
    },
    async write(target, write) {
      const answer = await runWorker(deps, { ...target, action: 'write', write }, writeTimeoutMs)
      const failed = failure(answer)
      if (failed !== null) throw failed
      if (!('written' in answer) || answer.written !== write.op) {
        throw new HomeComBridgeError('protocol', 'the HomeCom bridge did not confirm the write')
      }
    },
  }
}
