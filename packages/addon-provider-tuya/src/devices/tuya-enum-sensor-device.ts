import {
  type DeviceContext,
  enumSensorCapability,
  type EnumSensorStatus,
  type InferNativeProvider,
} from '@camstack/types'
import { z } from 'zod'
import { readStringDp } from '../tuya-dp-mapping.js'
import { tuyaChildSchema, TuyaChildDevice } from './tuya-child-device.js'

const CAP_NAME = 'enum-sensor'

/** Persisted config for a Tuya enum/string DP child (kettle work-status). */
export const tuyaEnumSensorSchema = tuyaChildSchema.extend({
  dp: z.string().min(1).describe('Enum/string status DP'),
  label: z.string().optional(),
})

export type TuyaEnumSensorConfig = z.infer<typeof tuyaEnumSensorSchema>

/**
 * A read-only Tuya enum/string DP exposed as a `DeviceType.Sensor` child
 * (`enum-sensor` cap) of a kettle Container — the kettle work-status
 * (`heating` / `warm` / `standby`, product-specific). Reads the raw DP string
 * through the parent's shared handle.
 */
export class TuyaEnumSensorDevice extends TuyaChildDevice {
  readonly #dp: string

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = tuyaEnumSensorSchema.parse(ctx.persistedConfig ?? {})
    this.#dp = cfg.dp
    void this.updateSourceInfo({ id: `${this.tuyaDeviceId}:enum:${cfg.dp}`, system: 'tuya' })
  }

  #read(): string | null {
    return readStringDp(this.dps(), this.#dp)
  }

  #slice(value: string): EnumSensorStatus {
    return { value, lastFetchedAt: Date.now() }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<EnumSensorStatus>(CAP_NAME) ??
        this.#slice(this.#read() ?? ''),
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, this.#slice(this.#read() ?? ''))
  }

  protected override recomputeSlice(): void {
    const value = this.#read()
    if (value === null) return
    const current = this.runtimeState.getCapState<EnumSensorStatus>(CAP_NAME)
    if (current?.value === value) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(value))
  }
}
