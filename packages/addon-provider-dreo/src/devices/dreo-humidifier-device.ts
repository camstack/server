import {
  humiditySensorCapability,
  switchCapability,
  type DeviceContext,
  type HumiditySensorStatus,
  type InferNativeProvider,
  type SwitchStatus,
} from '@dominevo/types'
import { DreoChildDevice } from './dreo-child-device.js'
import { clampPercent } from '../dreo-domain-mapping.js'

const SWITCH_CAP = 'switch'
const HUMIDITY_CAP = 'humidity-sensor'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const HUMIDITY_COLD_START: HumiditySensorStatus = { humidity: 0, lastFetchedAt: 0 }

/**
 * Dreo humidifier device. Registers `switch` (power) + `humidity-sensor` (the
 * relative humidity the humidifier reports). Maps the handle's reported state →
 * the two cap slices on every state change.
 *
 * Commands: switch.setState→power, through the worker and not echoed (D1061). The `humidity-sensor` cap is read-only
 * (the humidifier's internal hygrometer).
 *
 * TODO (deferred control surface): the humidifier exposes a TARGET humidity
 * (`rhautolevel` / `rhsleeplevel`) and a fog level (`foglevel`), but there is no
 * standalone "set target humidity" cap in Dominevo outside `climate-control` /
 * the `humidifier` actuator cap (not in this addon's declared cap set). For this
 * INITIAL version the humidifier is a switch + a humidity readout. A later phase
 * should add the target-humidity control via the appropriate actuator cap.
 */
export class DreoHumidifierDevice extends DreoChildDevice {
  // Widens the base's `protected` constructor to public so `dreoChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  protected override registerCaps(): void {
    const switchProvider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        await this.requireHandle().setPower(on)
      },
    }
    this.ctx.registerNativeCap(switchCapability, switchProvider)
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD_START)

    const humidityProvider: InferNativeProvider<typeof humiditySensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<HumiditySensorStatus>(HUMIDITY_CAP) ?? HUMIDITY_COLD_START,
    }
    this.ctx.registerNativeCap(humiditySensorCapability, humidityProvider)
    this.runtimeState.setCapState(HUMIDITY_CAP, HUMIDITY_COLD_START)
  }

  protected override recomputeSlices(): void {
    const handle = this.resolveHandle()
    if (handle === null) return
    const { on, humidity } = handle.state
    const now = Date.now()

    this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: now })

    const percent = clampPercent(humidity)
    if (percent !== null) {
      this.runtimeState.setCapState(HUMIDITY_CAP, { humidity: percent, lastFetchedAt: now })
    }
  }
}
