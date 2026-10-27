import {
  type DeviceContext,
  type InferNativeProvider,
  type TemperatureSensorStatus,
  temperatureSensorCapability,
} from '@camstack/types'
import { z } from 'zod'
import { readNumberDp } from '../tuya-dp-mapping.js'
import { tuyaChildSchema, TuyaChildDevice } from './tuya-child-device.js'

const CAP_NAME = 'temperature-sensor'

/** Persisted config for a Tuya numeric-temperature DP child (kettle current-temp). */
export const tuyaTemperatureSensorSchema = tuyaChildSchema.extend({
  dp: z.string().min(1).describe('Integer temperature DP'),
  /** Divisor for the raw DP integer (some kettles report deci-degrees). */
  scale: z.number().positive().default(1),
  label: z.string().optional(),
})

export type TuyaTemperatureSensorConfig = z.infer<typeof tuyaTemperatureSensorSchema>

/**
 * A read-only Tuya temperature DP exposed as a `DeviceType.Sensor` child
 * (`temperature-sensor` cap, always Celsius) of a kettle Container. Reads the
 * configured integer DP through the parent's shared handle, applying `scale`.
 */
export class TuyaTemperatureSensorDevice extends TuyaChildDevice {
  readonly #dp: string
  readonly #scale: number

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = tuyaTemperatureSensorSchema.parse(ctx.persistedConfig ?? {})
    this.#dp = cfg.dp
    this.#scale = cfg.scale
    void this.updateSourceInfo({ id: `${this.tuyaDeviceId}:temp:${cfg.dp}`, system: 'tuya' })
  }

  #read(): number | null {
    const raw = readNumberDp(this.dps(), this.#dp)
    if (raw === null) return null
    return this.#scale === 1 ? raw : raw / this.#scale
  }

  #slice(celsius: number): TemperatureSensorStatus {
    return { temperature: celsius, lastFetchedAt: Date.now() }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<TemperatureSensorStatus>(CAP_NAME) ?? this.#slice(0),
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, provider)
    const initial = this.#read()
    this.runtimeState.setCapState(CAP_NAME, this.#slice(initial ?? 0))
  }

  protected override recomputeSlice(): void {
    const celsius = this.#read()
    if (celsius === null) return
    const current = this.runtimeState.getCapState<TemperatureSensorStatus>(CAP_NAME)
    if (current?.temperature === celsius) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(celsius))
  }
}
