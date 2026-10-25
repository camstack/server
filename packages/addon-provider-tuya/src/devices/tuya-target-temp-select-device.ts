import {
  controlCapability,
  type ControlStatus,
  type DeviceContext,
  DeviceRole,
  type InferNativeProvider,
} from '@camstack/types'
import { z } from 'zod'
import { numberDpPatch, readNumberDp } from '../tuya-dp-mapping.js'
import { tuyaChildSchema, TuyaChildDevice } from './tuya-child-device.js'

const CAP_NAME = 'control'

/** Persisted config for the kettle target-temperature select child. */
export const tuyaTargetTempSelectSchema = tuyaChildSchema.extend({
  dp: z.string().min(1).describe('Integer target-temperature (setpoint) DP'),
  /** Divisor for the raw DP integer (deci-degree kettles). */
  scale: z.number().positive().default(1),
  /** Selectable temperature labels in °C (e.g. ['70','80','90','100']). */
  options: z.array(z.string().min(1)).min(1),
  label: z.string().optional(),
})

export type TuyaTargetTempSelectConfig = z.infer<typeof tuyaTargetTempSelectSchema>

/**
 * The kettle target-temperature setpoint exposed as a `DeviceType.Control`
 * (`select-control` role) child, mirroring localtuya's kettle temp select
 * (options `['70','80','90','100']`). Reads the integer DP → the matching °C
 * label; `setValue` maps the chosen label → the integer DP (× `scale`) written
 * through the parent's shared handle. Uses the generic `control` cap (kind
 * `select`).
 */
export class TuyaTargetTempSelectDevice extends TuyaChildDevice {
  readonly #dp: string
  readonly #scale: number
  readonly #options: readonly string[]

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.SelectControl)
    const cfg = tuyaTargetTempSelectSchema.parse(ctx.persistedConfig ?? {})
    this.#dp = cfg.dp
    this.#scale = cfg.scale
    this.#options = cfg.options
    void this.updateSourceInfo({ id: `${this.tuyaDeviceId}:target:${cfg.dp}`, system: 'tuya' })
  }

  /** Read the setpoint DP and resolve it to an options label, or null. */
  #readLabel(): string | null {
    const raw = readNumberDp(this.dps(), this.#dp)
    if (raw === null) return null
    const degrees = this.#scale === 1 ? raw : raw / this.#scale
    // Return the °C label even when it is not one of the declared options — a
    // raw read is informative (the UI still renders the current setpoint).
    return String(Math.round(degrees))
  }

  #slice(value: string): ControlStatus {
    return { kind: 'select', value, options: [...this.#options], lastChangedAt: Date.now() }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ControlStatus>(CAP_NAME) ??
        this.#slice(this.#readLabel() ?? ''),
      setValue: async ({ control }) => {
        if (control.kind !== 'select') {
          throw new Error(
            `TuyaTargetTempSelectDevice: expected a select value (device=${this.tuyaDeviceId})`,
          )
        }
        const degrees = Number.parseInt(control.value, 10)
        if (!Number.isFinite(degrees)) {
          throw new Error(
            `TuyaTargetTempSelectDevice: invalid option "${control.value}" (device=${this.tuyaDeviceId})`,
          )
        }
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `TuyaTargetTempSelectDevice: LAN client unavailable (device=${this.tuyaDeviceId})`,
          )
        }
        const raw = this.#scale === 1 ? degrees : Math.round(degrees * this.#scale)
        await handle.set(numberDpPatch(this.#dp, raw))
        this.runtimeState.setCapState(CAP_NAME, this.#slice(control.value))
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, this.#slice(this.#readLabel() ?? ''))
  }

  protected override recomputeSlice(): void {
    const label = this.#readLabel()
    if (label === null) return
    const current = this.runtimeState.getCapState<ControlStatus>(CAP_NAME)
    if (current?.value === label) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(label))
  }
}
