import {
  type DeviceContext,
  type InferNativeProvider,
  switchCapability,
  type SwitchStatus,
} from '@camstack/types'
import { z } from 'zod'
import { booleanDpPatch, readBooleanDp } from '../tuya-dp-mapping.js'
import { tuyaChildSchema, TuyaChildDevice } from './tuya-child-device.js'

const CAP_NAME = 'switch'
const COLD: SwitchStatus = { on: false, lastChangedAt: 0 }

/** Persisted config for a boolean-DP switch child (kettle power / keep-warm). */
export const tuyaDpSwitchSchema = tuyaChildSchema.extend({
  dp: z.string().min(1).describe('Boolean DP this switch drives'),
  label: z.string().optional(),
})

export type TuyaDpSwitchConfig = z.infer<typeof tuyaDpSwitchSchema>

/**
 * A single boolean Tuya DP exposed as a `DeviceType.Switch` accessory child of a
 * kettle Container (power / keep-warm). Reads/writes the configured DP through
 * the parent's SHARED live handle; registers the generic `switch` cap.
 */
export class TuyaDpSwitchDevice extends TuyaChildDevice {
  readonly #dp: string

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = tuyaDpSwitchSchema.parse(ctx.persistedConfig ?? {})
    this.#dp = cfg.dp
    void this.updateSourceInfo({ id: `${this.tuyaDeviceId}:switch:${cfg.dp}`, system: 'tuya' })
  }

  #read(): boolean | null {
    return readBooleanDp(this.dps(), this.#dp)
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(CAP_NAME) ?? COLD,
      setState: async ({ on }) => {
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `TuyaDpSwitchDevice: LAN client unavailable (device=${this.tuyaDeviceId}, dp=${this.#dp})`,
          )
        }
        await handle.set(booleanDpPatch(this.#dp, on))
        this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    const on = this.#read()
    this.runtimeState.setCapState(CAP_NAME, on === null ? COLD : { on, lastChangedAt: Date.now() })
  }

  protected override recomputeSlice(): void {
    const on = this.#read()
    if (on === null) return
    const current = this.runtimeState.getCapState<SwitchStatus>(CAP_NAME)
    if (current?.on === on) return
    this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
  }
}
