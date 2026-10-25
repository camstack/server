import {
  humiditySensorCapability,
  switchCapability,
  type DeviceContext,
  type HumiditySensorStatus,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { HumidifierDevice as DreoHumidifier } from '@apocaliss92/nodedreo'
import { DreoChildDevice } from './dreo-child-device.js'
import { clampPercent } from '../dreo-domain-mapping.js'

const SWITCH_CAP = 'switch'
const HUMIDITY_CAP = 'humidity-sensor'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const HUMIDITY_COLD_START: HumiditySensorStatus = { percent: 0, lastFetchedAt: 0 }

/**
 * Dreo humidifier device. Registers `switch` (power) + `humidity-sensor` (the
 * relative-humidity `rh` the humidifier reports). Maps the library
 * `HumidifierDevice` getters → the two cap slices on every `stateChanged` push.
 *
 * Commands: switch.setState→`setPower()`. The `humidity-sensor` cap is read-only
 * (the humidifier's internal hygrometer).
 *
 * TODO (deferred control surface): the humidifier exposes a TARGET humidity
 * (`rhautolevel` / `rhsleeplevel`) and a fog level (`foglevel`), but there is no
 * standalone "set target humidity" cap in CamStack outside `climate-control` /
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

  private resolveHumidifier(): DreoHumidifier | null {
    const handle = this.resolveHandle()
    return handle instanceof DreoHumidifier ? handle : null
  }

  private requireHumidifier(): DreoHumidifier {
    const humidifier = this.resolveHumidifier()
    if (humidifier === null) {
      throw new Error(`DreoHumidifierDevice: handle unavailable (device=${this.dreoDeviceId})`)
    }
    return humidifier
  }

  protected override registerCaps(): void {
    const switchProvider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        this.requireHumidifier().setPower(on)
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
    const humidifier = this.resolveHumidifier()
    if (humidifier === null) return
    const now = Date.now()

    this.runtimeState.setCapState(SWITCH_CAP, {
      on: humidifier.power,
      lastChangedAt: now,
    })

    const percent = clampPercent(humidifier.rh)
    if (percent !== null) {
      this.runtimeState.setCapState(HUMIDITY_CAP, {
        percent,
        unit: '%',
        lastFetchedAt: now,
      })
    }
  }
}
