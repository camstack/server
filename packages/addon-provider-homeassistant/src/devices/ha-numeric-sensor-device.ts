import {
  temperatureSensorCapability,
  humiditySensorCapability,
  ambientLightSensorCapability,
  pressureSensorCapability,
  numericSensorCapability,
  enumSensorCapability,
  quantityFromUnit,
  type DeviceContext,
  type ReadingQuantity,
  type InferNativeProvider,
  type DeviceRole,
  type EnumSensorStatus,
  type NumericSensorStatus,
  type TemperatureSensorStatus,
  type HumiditySensorStatus,
  type AmbientLightSensorStatus,
  type PressureSensorStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { takeReading } from '../ha-reading.js'
import type { HaEntityState } from '../ha-types.js'

const SUPPORTED_CAP_NAMES = [
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'pressure-sensor',
  'numeric-sensor',
] as const
type SupportedCapName = (typeof SUPPORTED_CAP_NAMES)[number]

/** Map a supported cap to its canonical "value" field. */
const VALUE_FIELD: Record<SupportedCapName, string> = {
  'temperature-sensor': 'celsius',
  'humidity-sensor': 'percent',
  'ambient-light-sensor': 'lux',
  'pressure-sensor': 'hpa',
  'numeric-sensor': 'value',
}

/** Typed sensors already name their quantity. The generic sensor learns it. */
const FIXED_QUANTITY: Partial<Record<SupportedCapName, ReadingQuantity>> = {
  'temperature-sensor': 'temperature',
  'humidity-sensor': 'humidity',
  'ambient-light-sensor': 'illuminance',
  'pressure-sensor': 'pressure',
}

/**
 * Generic HA numeric-sensor child device. One class hosts every
 * single-metric numeric sensor cap (Phase B B2 + the B3 fallback)
 * — the cap name comes from `persistedConfig.capabilities[0]` and
 * drives both the registered cap provider and the slice-write field
 * name.
 *
 * HA pushes `state.state` as a string; we `Number(...)` it. NaN
 * results (`unavailable` / `unknown`) leave the numeric slice untouched
 * so consumers see the last known good value with a stale `lastFetchedAt`.
 *
 * String fallback: when the state is a non-empty, non-numeric string
 * (e.g. an already-adopted free-text sensor whose device_class is null
 * — IP address, SSID, firmware version), the device also registers an
 * `enum-sensor` cap so the string value is stored verbatim and the UI
 * can render it. New free-text adoptions are mapped to `enum-sensor`
 * directly by the domain mapper; this path covers existing wrong-adopted
 * devices that carry `capabilities: ['numeric-sensor']`.
 *
 * Multi-metric caps (`power-meter`, `air-quality-sensor`) get their
 * own class in Phase F2.
 */
export class HaNumericSensorDevice extends HaBaseChildDevice {
  private readonly capName: SupportedCapName
  private readonly valueKey: string
  /** Whether this instance also registered an enum-sensor fallback cap. */
  private readonly hasStringFallback: boolean

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as {
      capabilities?: readonly string[]
      role?: DeviceRole
    }
    const capName = pickSupportedCap(persisted.capabilities)
    if (!capName) {
      throw new Error(
        `HaNumericSensorDevice: no supported numeric-sensor cap in persisted config (id=${ctx.id})`,
      )
    }
    super(ctx, persisted.role !== undefined ? { role: persisted.role } : {})
    this.capName = capName
    this.valueKey = VALUE_FIELD[capName]

    // String fallback: register enum-sensor alongside numeric-sensor so that
    // free-text states (IP, SSID, version) that were adopted under the wrong
    // cap still reach the UI. Only for the generic 'numeric-sensor' cap —
    // temperature/humidity/… sensors always receive genuine numeric values.
    this.hasStringFallback = capName === 'numeric-sensor'
    this.registerCap(capName)
    if (this.hasStringFallback) {
      this.registerStringFallbackCap()
    }
    // Cold-start slice with `lastFetchedAt: 0` so consumers see the
    // documented "no push received yet" sentinel.
    // unit/precision are absent at cold-start (not yet received from HA).
    this.runtimeState.setCapState(this.capName, this.buildSlice(0, 0, undefined, undefined))
  }

  protected override handleStatePush(state: HaEntityState): void {
    const value = Number(state.state)
    const lastFetchedAt = Date.parse(state.last_updated) || Date.now()
    if (Number.isFinite(value)) {
      const unitRaw =
        typeof state.attributes['unit_of_measurement'] === 'string'
          ? state.attributes['unit_of_measurement']
          : undefined
      this.runtimeState.setCapState(this.capName, this.buildSlice(value, lastFetchedAt, unitRaw))
      return
    }
    // Non-numeric state (e.g. 'unavailable' / 'unknown') — leave the numeric
    // slice untouched. For the string-fallback path, also write to enum-sensor
    // so free-text values (IP, SSID, version) reach the UI.
    const rawState = state.state
    if (
      this.hasStringFallback &&
      rawState !== 'unavailable' &&
      rawState !== 'unknown' &&
      rawState !== ''
    ) {
      const enumSlice: EnumSensorStatus = { value: rawState, lastFetchedAt }
      this.runtimeState.setCapState('enum-sensor', enumSlice)
    }
  }

  private buildSlice(
    value: number,
    lastFetchedAt: number,
    unitRaw: string | undefined,
  ): Record<string, unknown> {
    const quantity = this.resolveQuantity(unitRaw)
    const stored =
      quantity === null ? null : takeReading(this.deviceLogger, this.id, value, unitRaw, quantity)
    if (this.capName === 'numeric-sensor') {
      const slice: NumericSensorStatus = { value: stored, lastFetchedAt }
      return slice
    }
    return { [this.valueKey]: stored, lastFetchedAt }
  }

  /**
   * Typed sensors already name their quantity. A generic numeric sensor
   * learns it once from the unit and stores it on the device, so later
   * samples convert against the same quantity.
   */
  private resolveQuantity(unitRaw: string | undefined): ReadingQuantity | null {
    const fixed = FIXED_QUANTITY[this.capName]
    if (fixed !== undefined) return fixed
    const stored = this.sourceInfo.quantity
    if (stored !== undefined && stored !== 'device') return stored
    if (unitRaw === undefined) return 'none'
    const learned = quantityFromUnit(unitRaw)
    if (learned === undefined || learned === 'device') {
      this.deviceLogger.warn('numeric reading refused', {
        tags: { deviceId: this.id },
        meta: { quantity: 'device', unit: unitRaw, reason: 'unknown-unit' },
      })
      return null
    }
    void this.updateSourceInfo({ quantity: learned })
    return learned
  }

  /**
   * Register an `enum-sensor` cap backed by the same `runtimeState` so that
   * string-valued pushes (IP, SSID, firmware version) are reachable from the
   * UI via the `enum-sensor` slice, alongside the `numeric-sensor` slice that
   * remains for any genuinely-numeric pushes this entity may also emit.
   */
  private registerStringFallbackCap(): void {
    const COLD_START: EnumSensorStatus = { value: '', lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof enumSensorCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<EnumSensorStatus>('enum-sensor') ?? COLD_START
      },
    }
    this.ctx.registerNativeCap(enumSensorCapability, provider)
    this.runtimeState.setCapState('enum-sensor', COLD_START)
  }

  private registerCap(name: SupportedCapName): void {
    switch (name) {
      case 'temperature-sensor': {
        const COLD_START: TemperatureSensorStatus = { celsius: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
          getStatus: async () => this.readSlice<TemperatureSensorStatus>(COLD_START),
        }
        this.ctx.registerNativeCap(temperatureSensorCapability, provider)
        return
      }
      case 'humidity-sensor': {
        const COLD_START: HumiditySensorStatus = { percent: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof humiditySensorCapability> = {
          getStatus: async () => this.readSlice<HumiditySensorStatus>(COLD_START),
        }
        this.ctx.registerNativeCap(humiditySensorCapability, provider)
        return
      }
      case 'ambient-light-sensor': {
        const COLD_START: AmbientLightSensorStatus = { lux: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof ambientLightSensorCapability> = {
          getStatus: async () => this.readSlice<AmbientLightSensorStatus>(COLD_START),
        }
        this.ctx.registerNativeCap(ambientLightSensorCapability, provider)
        return
      }
      case 'pressure-sensor': {
        const COLD_START: PressureSensorStatus = { hpa: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof pressureSensorCapability> = {
          getStatus: async () => this.readSlice<PressureSensorStatus>(COLD_START),
        }
        this.ctx.registerNativeCap(pressureSensorCapability, provider)
        return
      }
      case 'numeric-sensor': {
        const COLD_START: NumericSensorStatus = { value: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () => this.readSlice<NumericSensorStatus>(COLD_START),
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        return
      }
    }
  }

  private readSlice<T extends Record<string, unknown>>(fallback: T): T {
    return this.runtimeState.getCapState<T>(this.capName) ?? fallback
  }
}

function pickSupportedCap(capabilities: readonly string[] | undefined): SupportedCapName | null {
  if (!capabilities) return null
  for (const cap of capabilities) {
    if (SUPPORTED_CAP_NAMES.includes(cap as SupportedCapName)) {
      return cap as SupportedCapName
    }
  }
  return null
}

/** Exposed for the class factory. */
export function hostsNumericSensor(capabilities: readonly string[]): boolean {
  return capabilities.some((c) => SUPPORTED_CAP_NAMES.includes(c as SupportedCapName))
}
