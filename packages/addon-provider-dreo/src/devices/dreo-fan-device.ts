import {
  fanControlCapability,
  switchCapability,
  type DeviceContext,
  type FanControlStatus,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { FanDevice as DreoFan } from '@apocaliss92/nodedreo'
import { DreoChildDevice } from './dreo-child-device.js'
import { levelToPercentage, percentageStep, percentageToLevel } from '../dreo-domain-mapping.js'

const SWITCH_CAP = 'switch'
const FAN_CAP = 'fan-control'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const FAN_COLD_START: FanControlStatus = {
  percentage: null,
  preset: '',
  availablePresets: [],
  direction: null,
  oscillating: null,
  lastChangedAt: 0,
}

/**
 * Dreo fan / air-circulator device. Registers `switch` (power) + `fan-control`
 * (speed percentage + oscillation) and maps the library `FanDevice` getters →
 * the two cap slices on every `stateChanged` push.
 *
 * Commands: switch.setState→`setPower()`; fan-control.setPercentage→`setSpeed()`
 * (percentage↔wind-level via the domain mapping); fan-control.setOscillating→
 * `setOscillate()`.
 *
 * TODO: per-model max fan level is not exposed by the library, so the
 * percentage↔level conversion uses a fixed `DREO_MAX_FAN_LEVEL` constant. A
 * later phase should probe the model's real max level. Preset / wind-mode
 * (`mode` / `windType`) and air-circulator horizontal/vertical oscillation are
 * also deferred — the `fan-control` cap models a single `oscillating` boolean.
 */
export class DreoFanDevice extends DreoChildDevice {
  // Widens the base's `protected` constructor to public so `dreoChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  /** Narrow the generic handle to the library's typed {@link DreoFan}, or null. */
  private resolveFan(): DreoFan | null {
    const handle = this.resolveHandle()
    return handle instanceof DreoFan ? handle : null
  }

  /** The live typed fan handle, or throw a clear error when disconnected. */
  private requireFan(): DreoFan {
    const fan = this.resolveFan()
    if (fan === null) {
      throw new Error(`DreoFanDevice: fan handle unavailable (device=${this.dreoDeviceId})`)
    }
    return fan
  }

  protected override registerCaps(): void {
    const switchProvider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        this.requireFan().setPower(on)
      },
    }
    this.ctx.registerNativeCap(switchCapability, switchProvider)
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD_START)

    const fanProvider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<FanControlStatus>(FAN_CAP) ?? FAN_COLD_START,
      setPercentage: async ({ percentage }) => {
        const fan = this.requireFan()
        const level = percentageToLevel(percentage)
        // 0% → power off; otherwise ensure power on then set the wind level.
        if (level <= 0) {
          fan.setPower(false)
          return
        }
        if (!fan.power) fan.setPower(true)
        fan.setSpeed(level)
      },
      setPreset: async ({ preset }) => {
        // Preset / wind-mode mapping is deferred (see class TODO).
        throw new Error(`dreo fan: presets not yet supported (got "${preset}")`)
      },
      setDirection: async ({ direction }) => {
        throw new Error(`dreo fan: direction control not supported (got "${direction}")`)
      },
      setOscillating: async ({ oscillating }) => {
        this.requireFan().setOscillate(oscillating)
      },
    }
    this.ctx.registerNativeCap(fanControlCapability, fanProvider)
    this.runtimeState.setCapState(FAN_CAP, FAN_COLD_START)
  }

  protected override recomputeSlices(): void {
    const fan = this.resolveFan()
    if (fan === null) return
    const now = Date.now()

    const switchSlice: SwitchStatus = { on: fan.power, lastChangedAt: now }
    this.runtimeState.setCapState(SWITCH_CAP, switchSlice)

    const fanSlice: FanControlStatus = {
      percentage: levelToPercentage(fan.speed),
      percentageStep: percentageStep(),
      preset: '',
      availablePresets: [],
      direction: null,
      oscillating: fan.oscillate,
      lastChangedAt: now,
    }
    this.runtimeState.setCapState(FAN_CAP, fanSlice)
  }
}
