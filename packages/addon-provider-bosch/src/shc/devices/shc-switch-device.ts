import {
  switchCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { buildPowerSwitchPutBody, readShcSwitchOn } from '../shc-domain-mapping.js'
import type { ShcPowerSwitchState } from '../shc-types.js'
import { ShcBaseDevice } from './shc-device-base.js'

const SWITCH_CAP = 'switch'
const SERVICE = 'PowerSwitch'

const SWITCH_COLD: SwitchStatus = { on: false, lastChangedAt: 0 }

export class ShcSwitchDevice extends ShcBaseDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  protected override registerCaps(): void {
    const switchProvider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD,
      setState: async ({ on }) => {
        await this.requireClient().putServiceState(
          this.shcDeviceId,
          SERVICE,
          buildPowerSwitchPutBody(on),
        )
        this.deviceLog('info', 'SHC switch set', { on })
        this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, switchProvider)
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD)
  }

  protected override async refreshFromController(): Promise<void> {
    const client = this.resolveClient()
    if (client === null) return
    const state = await client.getServiceState<ShcPowerSwitchState>(this.shcDeviceId, SERVICE)
    const on = readShcSwitchOn(state)
    const prev = this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP)
    const now = Date.now()
    this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: now })
    if (prev !== undefined && prev.on !== on) {
      this.deviceLog('info', 'SHC switch updated from controller', { on, previous: prev.on })
    }
  }
}
