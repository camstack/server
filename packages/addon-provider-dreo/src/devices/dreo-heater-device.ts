import {
  switchCapability,
  temperatureSensorCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
  type TemperatureSensorStatus,
} from '@camstack/types'
import { HeaterDevice as DreoHeater } from '@apocaliss92/nodedreo'
import { DreoChildDevice } from './dreo-child-device.js'

const SWITCH_CAP = 'switch'
const TEMP_CAP = 'temperature-sensor'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const TEMP_COLD_START: TemperatureSensorStatus = { celsius: 0, lastFetchedAt: 0 }

/**
 * Dreo heater device. Registers `switch` (power) + `temperature-sensor` (the
 * ambient temperature the heater reports). Maps the library `HeaterDevice`
 * getters → the two cap slices on every `stateChanged` push.
 *
 * Commands: switch.setState→`setPower()`. The `temperature-sensor` cap is
 * read-only (the heater's internal thermometer).
 *
 * TODO (deferred climate surface): the heater has NO target-temperature
 * setpoint on the library (`HeaterDevice` exposes heat-level `htalevel` and an
 * `ecolevel`, not a degrees setpoint), so it is modelled as a switch + a
 * temperature readout rather than the `climate-control` cap. A later phase could
 * map `htalevel` onto a `fan-control`-style level or add a vendor heat-level cap.
 * The heater's reported temperature unit (°C vs °F) is also assumed Celsius — a
 * follow-up should confirm and convert if the account is imperial.
 */
export class DreoHeaterDevice extends DreoChildDevice {
  // Widens the base's `protected` constructor to public so `dreoChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  private resolveHeater(): DreoHeater | null {
    const handle = this.resolveHandle()
    return handle instanceof DreoHeater ? handle : null
  }

  private requireHeater(): DreoHeater {
    const heater = this.resolveHeater()
    if (heater === null) {
      throw new Error(`DreoHeaterDevice: handle unavailable (device=${this.dreoDeviceId})`)
    }
    return heater
  }

  protected override registerCaps(): void {
    const switchProvider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        this.requireHeater().setPower(on)
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
    const heater = this.resolveHeater()
    if (heater === null) return
    const now = Date.now()

    this.runtimeState.setCapState(SWITCH_CAP, {
      on: heater.power,
      lastChangedAt: now,
    })

    const temperature = heater.temperature
    if (temperature !== undefined) {
      this.runtimeState.setCapState(TEMP_CAP, {
        celsius: temperature,
        lastFetchedAt: now,
      })
    }
  }
}
