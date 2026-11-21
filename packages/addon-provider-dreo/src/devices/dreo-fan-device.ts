import {
  fanControlCapability,
  switchCapability,
  type DeviceContext,
  type FanControlStatus,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { DreoChildDevice } from './dreo-child-device.js'
import {
  DREO_MAX_FAN_LEVEL,
  levelToPercentage,
  percentageStep,
  percentageToLevel,
} from '../dreo-domain-mapping.js'

const SWITCH_CAP = 'switch'
const FAN_CAP = 'fan-control'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const FAN_COLD_START: FanControlStatus = {
  speed: null,
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
 * Commands go through the worker and are NOT echoed into the slices: the hub holds a
 * commanded value until the device's own report confirms it (D1061). switch.setState→power;
 * fan-control.setPercentage→speed level (percentage↔level over the device's own range);
 * fan-control.setOscillating→oscillation.
 *
 * TODO: preset / wind-mode (`mode` / `windType`) and air-circulator horizontal/vertical
 * oscillation are deferred — the `fan-control` cap models a single `oscillating` boolean.
 */
export class DreoFanDevice extends DreoChildDevice {
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

    const fanProvider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<FanControlStatus>(FAN_CAP) ?? FAN_COLD_START,
      setPercentage: async ({ speed: percentage }) => {
        const handle = this.requireHandle()
        const { speedMin, speedMax } = handle.state
        const max = speedMax ?? DREO_MAX_FAN_LEVEL
        const level = percentageToLevel(percentage, max)
        // 0% → power off; otherwise ensure power on then set the wind level.
        if (level <= 0) {
          await handle.setPower(false)
          return
        }
        if (handle.state.on !== true) await handle.setPower(true)
        await handle.setSpeed(Math.max(level, speedMin ?? 1))
      },
      setPreset: async ({ preset }) => {
        // Preset / wind-mode mapping is deferred (see class TODO).
        throw new Error(`dreo fan: presets not yet supported (got "${preset}")`)
      },
      setDirection: async ({ direction }) => {
        throw new Error(`dreo fan: direction control not supported (got "${direction}")`)
      },
      setOscillating: async ({ oscillating }) => {
        await this.requireHandle().setOscillating(oscillating)
      },
    }
    this.ctx.registerNativeCap(fanControlCapability, fanProvider)
    this.runtimeState.setCapState(FAN_CAP, FAN_COLD_START)
  }

  protected override recomputeSlices(): void {
    const handle = this.resolveHandle()
    if (handle === null) return
    const { on, speed, speedMax, oscillating } = handle.state
    const max = speedMax ?? DREO_MAX_FAN_LEVEL
    const now = Date.now()

    const switchSlice: SwitchStatus = { on, lastChangedAt: now }
    this.runtimeState.setCapState(SWITCH_CAP, switchSlice)

    const fanSlice: FanControlStatus = {
      speed: speed === null ? null : levelToPercentage(speed, max),
      percentageStep: percentageStep(max),
      preset: '',
      availablePresets: [],
      direction: null,
      oscillating,
      lastChangedAt: now,
    }
    this.runtimeState.setCapState(FAN_CAP, fanSlice)
  }
}
