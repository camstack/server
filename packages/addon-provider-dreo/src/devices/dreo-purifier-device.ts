import {
  airQualitySensorCapability,
  fanControlCapability,
  switchCapability,
  type AirQualitySensorStatus,
  type DeviceContext,
  type FanControlStatus,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { AirPurifierDevice as DreoPurifier } from '@apocaliss92/nodedreo'
import { DreoChildDevice } from './dreo-child-device.js'
import { levelToPercentage, percentageStep, percentageToLevel } from '../dreo-domain-mapping.js'

const SWITCH_CAP = 'switch'
const FAN_CAP = 'fan-control'
const AQ_CAP = 'air-quality-sensor'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const FAN_COLD_START: FanControlStatus = {
  percentage: null,
  preset: '',
  availablePresets: [],
  direction: null,
  oscillating: null,
  lastChangedAt: 0,
}
const AQ_COLD_START: AirQualitySensorStatus = { lastFetchedAt: 0 }

/**
 * Dreo air-purifier device. Registers `switch` (power) + `fan-control` (fan
 * speed) + `air-quality-sensor` (the PM2.5 the purifier reports). Maps the
 * library `AirPurifierDevice` getters → the three cap slices on every
 * `stateChanged` push.
 *
 * Commands: switch.setState→`setPower()`; fan-control.setPercentage→
 * `setWindlevel()` (percentage↔wind-level). The `air-quality-sensor` cap has no
 * methods — it is a read-only push slice carrying `pm25`.
 *
 * TODO: the purifier reports `mode` (auto/manual/sleep) as a string preset; that
 * is deferred (the `fan-control` preset surface is left empty). Filter life and
 * the `childlockon` toggle are also not yet surfaced.
 */
export class DreoPurifierDevice extends DreoChildDevice {
  // Widens the base's `protected` constructor to public so `dreoChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  private resolvePurifier(): DreoPurifier | null {
    const handle = this.resolveHandle()
    return handle instanceof DreoPurifier ? handle : null
  }

  private requirePurifier(): DreoPurifier {
    const purifier = this.resolvePurifier()
    if (purifier === null) {
      throw new Error(`DreoPurifierDevice: handle unavailable (device=${this.dreoDeviceId})`)
    }
    return purifier
  }

  protected override registerCaps(): void {
    const switchProvider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        this.requirePurifier().setPower(on)
      },
    }
    this.ctx.registerNativeCap(switchCapability, switchProvider)
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD_START)

    const fanProvider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<FanControlStatus>(FAN_CAP) ?? FAN_COLD_START,
      setPercentage: async ({ percentage }) => {
        const purifier = this.requirePurifier()
        const level = percentageToLevel(percentage)
        if (level <= 0) {
          purifier.setPower(false)
          return
        }
        if (!purifier.power) purifier.setPower(true)
        purifier.setWindlevel(level)
      },
      setPreset: async ({ preset }) => {
        throw new Error(`dreo purifier: presets not yet supported (got "${preset}")`)
      },
      setDirection: async ({ direction }) => {
        throw new Error(`dreo purifier: direction control not supported (got "${direction}")`)
      },
      setOscillating: async ({ oscillating }) => {
        throw new Error(`dreo purifier: oscillation not supported (got ${String(oscillating)})`)
      },
    }
    this.ctx.registerNativeCap(fanControlCapability, fanProvider)
    this.runtimeState.setCapState(FAN_CAP, FAN_COLD_START)

    const aqProvider: InferNativeProvider<typeof airQualitySensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<AirQualitySensorStatus>(AQ_CAP) ?? AQ_COLD_START,
    }
    this.ctx.registerNativeCap(airQualitySensorCapability, aqProvider)
    this.runtimeState.setCapState(AQ_CAP, AQ_COLD_START)
  }

  protected override recomputeSlices(): void {
    const purifier = this.resolvePurifier()
    if (purifier === null) return
    const now = Date.now()

    this.runtimeState.setCapState(SWITCH_CAP, {
      on: purifier.power,
      lastChangedAt: now,
    })

    const level = purifier.windlevel
    this.runtimeState.setCapState(FAN_CAP, {
      percentage: level === undefined ? null : levelToPercentage(level),
      percentageStep: percentageStep(),
      preset: '',
      availablePresets: [],
      direction: null,
      oscillating: null,
      lastChangedAt: now,
    })

    const pm25 = purifier.pm25
    const aqSlice: AirQualitySensorStatus = {
      ...(pm25 !== undefined ? { pm25 } : {}),
      lastFetchedAt: now,
    }
    this.runtimeState.setCapState(AQ_CAP, aqSlice)
  }
}
