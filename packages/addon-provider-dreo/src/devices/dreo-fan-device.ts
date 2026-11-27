import {
  DeviceFeature,
  fanControlCapability,
  humiditySensorCapability,
  switchCapability,
  temperatureSensorCapability,
  type DeviceContext,
  type FanControlStatus,
  type FanOscillationAxes,
  type FanOscillationAxis,
  type HumiditySensorStatus,
  type TemperatureSensorStatus,
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

const TEMP_CAP = 'temperature-sensor'
const HUMIDITY_CAP = 'humidity-sensor'
const TEMP_COLD_START: TemperatureSensorStatus = {
  temperature: null,
  lastFetchedAt: 0,
}
const HUMIDITY_COLD_START: HumiditySensorStatus = {
  humidity: null,
  lastFetchedAt: 0,
}

/** An axis the library reports; the leaves it does not expose stay null (D393). */
function axisOf(oscillating: boolean | null): FanOscillationAxis | null {
  if (oscillating === null) return null
  return {
    oscillating,
    angle: null,
    sweepFrom: null,
    sweepTo: null,
    min: null,
    max: null,
    step: null,
  }
}

function axesOf(
  horizontal: boolean | null,
  vertical: boolean | null,
): FanOscillationAxes | undefined {
  const axes: FanOscillationAxes = {
    horizontal: axisOf(horizontal),
    vertical: axisOf(vertical),
  }
  return axes.horizontal === null && axes.vertical === null ? undefined : axes
}

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
 * Presets are the library's own mode names (`preset` / `availablePresets`); an air circulator's
 * horizontal and vertical oscillation are the `oscillationAxes` (on/off per axis). The axis
 * angles are not mapped: the library exposes them as sweep widths per model, not as the cap's
 * fixed position and sweep bounds. The ambient temperature (and humidity, when the model
 * reports it) are `temperature-sensor` / `humidity-sensor` bindings of this same device.
 */
export class DreoFanDevice extends DreoChildDevice {
  override readonly features: readonly DeviceFeature[] = [
    DeviceFeature.FanSpeed,
    DeviceFeature.FanPreset,
    DeviceFeature.FanOscillating,
  ]

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
        await this.requireHandle().setPreset(preset)
      },
      setOscillationAxis: async ({ axis, oscillating, angle, sweepFrom, sweepTo }) => {
        const unmapped = [
          ...(angle === undefined ? [] : (['angle'] as const)),
          ...(sweepFrom === undefined ? [] : (['sweepFrom'] as const)),
          ...(sweepTo === undefined ? [] : (['sweepTo'] as const)),
        ]
        if (oscillating === undefined && unmapped.length === 0) {
          return {
            status: 'refused',
            reason: 'nothing-to-set',
            detail: 'no field to set',
            applied: [],
          }
        }
        if (oscillating !== undefined) {
          const handle = this.requireHandle()
          const reported =
            axis === 'horizontal'
              ? handle.state.horizontalOscillating
              : handle.state.verticalOscillating
          if (reported === null) {
            this.ctx.logger.warn('dreo fan: axis oscillation refused, the model has no such axis', {
              tags: { deviceId: this.id },
              meta: { axis, dreoDeviceId: this.dreoDeviceId },
            })
            return {
              status: 'refused',
              reason: 'axis-not-linked',
              field: 'oscillating',
              detail: `this fan has no ${axis} oscillation axis`,
              applied: [],
            }
          }
          await handle.setAxisOscillating(axis, oscillating)
        }
        const [field] = unmapped
        if (field !== undefined) {
          return {
            status: 'refused',
            reason: 'axis-not-linked',
            field,
            detail: `the ${axis} ${field} of this fan is not exposed by the Dreo cloud library`,
            applied: oscillating === undefined ? [] : ['oscillating'],
          }
        }
        return { status: 'applied' }
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

    const tempProvider: InferNativeProvider<typeof temperatureSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<TemperatureSensorStatus>(TEMP_CAP) ?? TEMP_COLD_START,
    }
    this.ctx.registerNativeCap(temperatureSensorCapability, tempProvider)
    this.runtimeState.setCapState(TEMP_CAP, TEMP_COLD_START)
  }

  /** Humidity is registered on the first reading: a model that never reports it gets no empty binding. */
  private humidityRegistered = false

  private ensureHumidityBinding(): void {
    if (this.humidityRegistered) return
    this.humidityRegistered = true
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
    const {
      on,
      speed,
      speedMax,
      oscillating,
      horizontalOscillating,
      verticalOscillating,
      preset,
      presets,
      temperature,
      humidity,
    } = handle.state
    const max = speedMax ?? DREO_MAX_FAN_LEVEL
    const now = Date.now()

    const switchSlice: SwitchStatus = { on, lastChangedAt: now }
    this.runtimeState.setCapState(SWITCH_CAP, switchSlice)

    const axes = axesOf(horizontalOscillating, verticalOscillating)
    const axesSlice = axes === undefined ? {} : { oscillationAxes: axes }
    const fanSlice: FanControlStatus = {
      speed: speed === null ? null : levelToPercentage(speed, max),
      percentageStep: percentageStep(max),
      preset: preset ?? '',
      availablePresets: presets ?? [],
      direction: null,
      oscillating,
      ...axesSlice,
      lastChangedAt: now,
    }
    this.runtimeState.setCapState(FAN_CAP, fanSlice)

    if (temperature !== null) {
      this.runtimeState.setCapState(TEMP_CAP, {
        temperature,
        lastFetchedAt: now,
      })
    }
    if (humidity !== null) {
      this.ensureHumidityBinding()
      this.runtimeState.setCapState(HUMIDITY_CAP, {
        humidity,
        lastFetchedAt: now,
      })
    }
  }
}
