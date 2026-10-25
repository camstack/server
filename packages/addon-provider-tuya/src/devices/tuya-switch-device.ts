import {
  type DeviceContext,
  DeviceType,
  type InferNativeProvider,
  switchCapability,
  type SwitchStatus,
} from '@camstack/types'
import { booleanDpPatch, readBooleanDp } from '../tuya-dp-mapping.js'
import { TuyaBaseDevice } from './tuya-base-device.js'

const CAP_NAME = 'switch'
const COLD: SwitchStatus = { on: false, lastChangedAt: 0 }

/**
 * A raw on/off Tuya device (wall / ceiling light switch, socket) as a
 * `DeviceType.Switch`, backed by ONE boolean DP (`switchDp`, default `'1'`) on
 * its own live LAN client. Registers the generic `switch` cap: `setState` writes
 * the boolean DP; each `dps` push re-derives the slice. Multi-gang switches
 * (several boolean DPs) drive only their first gang in v1 — additional gangs are
 * a documented follow-up.
 */
export class TuyaSwitchDevice extends TuyaBaseDevice {
  constructor(ctx: DeviceContext) {
    super(ctx, DeviceType.Switch)
    void this.updateSourceInfo({ id: `${this.tuyaDeviceId}:switch`, system: 'tuya' })
  }

  /** Read the configured boolean DP from the live handle, or null. */
  #read(): boolean | null {
    const handle = this.handle
    if (handle === null) return null
    return readBooleanDp(handle.dps, this.switchDp)
  }

  protected override registerCaps(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(CAP_NAME) ?? COLD,
      setState: async ({ on }) => {
        const handle = this.handle
        if (handle === null) {
          throw new Error(`TuyaSwitchDevice: LAN client unavailable (device=${this.tuyaDeviceId})`)
        }
        await handle.set(booleanDpPatch(this.switchDp, on))
        this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    const on = this.#read()
    this.runtimeState.setCapState(CAP_NAME, on === null ? COLD : { on, lastChangedAt: Date.now() })
  }

  protected override onDpsPush(): void {
    const on = this.#read()
    if (on === null) return
    const current = this.runtimeState.getCapState<SwitchStatus>(CAP_NAME)
    if (current?.on === on) return
    this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
  }
}
