import {
  switchCapability,
  temperatureSensorCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
  type TemperatureSensorStatus,
} from '@camstack/types'
import { DreoChildDevice } from './dreo-child-device.js'

const SWITCH_CAP = 'switch'
const TEMP_CAP = 'temperature-sensor'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const TEMP_COLD_START: TemperatureSensorStatus = { temperature: 0, lastFetchedAt: 0 }

/**
 * Dreo heater device. Registers `switch` (power) + `temperature-sensor` (the
 * ambient temperature the heater reports). Maps the handle's reported state →
 * the two cap slices on every state change.
 *
 * Commands: switch.setState→power, through the worker and not echoed (D1061). The `temperature-sensor` cap is
 * read-only (the heater's internal thermometer).
 *
 * TODO (deferred climate surface): the heater has NO target-temperature
 * setpoint in this bridge (the cloud exposes a heat level and an eco level, not a degrees
 * setpoint), so it is modelled as a switch + a
 * temperature readout rather than the `climate-control` cap. A later phase could
 * map `htalevel` onto a `fan-control`-style level or add a vendor heat-level cap.
 * The worker converts the reported temperature to Celsius.
 */
export class DreoHeaterDevice extends DreoChildDevice {
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

    const tempProvider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<TemperatureSensorStatus>(TEMP_CAP) ?? TEMP_COLD_START,
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, tempProvider)
    this.runtimeState.setCapState(TEMP_CAP, TEMP_COLD_START)
  }

  protected override recomputeSlices(): void {
    const handle = this.resolveHandle()
    if (handle === null) return
    const { on, temperature } = handle.state
    const now = Date.now()

    this.runtimeState.setCapState(SWITCH_CAP, { on: on === true, lastChangedAt: now })

    if (temperature !== null) {
      this.runtimeState.setCapState(TEMP_CAP, { temperature, lastFetchedAt: now })
    }
  }
}
