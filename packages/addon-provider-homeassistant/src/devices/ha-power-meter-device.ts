import {
  powerMeterCapability,
  type DeviceContext,
  type InferNativeProvider,
  type PowerMeterStatus,
  type DeviceRole,
  type ReadingQuantity,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { takeReading } from '../ha-reading.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: PowerMeterStatus = { lastFetchedAt: 0 }

/**
 * HA-backed power-meter sensor child. Multi-field cap — the slice
 * carries `watts` / `volts` / `amps` / `kwhTotal` etc., but each HA
 * `sensor.*` entity surfaces ONE metric (device_class = `power` /
 * `voltage` / `current` / `energy`). The class populates the field
 * corresponding to the entity's device_class.
 *
 * A real multi-metric appliance (Aqara plug, Shelly) typically
 * exposes ONE HA device with 3-4 sensor entities. Each entity becomes
 * a separate CamStack child here, each with its own power-meter cap
 * populating one field. UI consumers aggregate across the parent's
 * accessories. Future enhancement: collapse same-device sensors into
 * ONE multi-cap CamStack accessory; out of scope for Phase F5.
 *
 * Maps HA device_class to slice field:
 *   - `power`  → watts
 *   - `energy` → kwhTotal
 *   - `voltage`→ volts
 *   - `current`→ amps
 *   - anything else → ignored (slice stays at cold-start until a
 *     re-discovery picks up a matching device_class)
 */
export class HaPowerMeterDevice extends HaBaseChildDevice {
  private readonly haDeviceClass: string | null

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as { role?: DeviceRole }
    super(ctx, persisted.role !== undefined ? { role: persisted.role } : {})
    // device_class isn't persisted in the child config (yet) — read
    // from the entity's attributes on the first push instead. Track
    // it in-memory so subsequent pushes know which slot to write.
    this.haDeviceClass = null
    this.registerPowerMeterCap()
    this.runtimeState.setCapState('power-meter', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const value = Number(state.state)
    if (!Number.isFinite(value)) return
    const lastFetchedAt = Date.parse(state.last_updated) || Date.now()

    // HA `device_class` attribute determines which slice field to set.
    const deviceClassRaw = state.attributes['device_class']
    const deviceClass = typeof deviceClassRaw === 'string' ? deviceClassRaw : this.haDeviceClass
    const quantity = powerQuantity(deviceClass)
    if (quantity === undefined) return
    const unitRaw = state.attributes['unit_of_measurement']
    const stored = takeReading(
      this.deviceLogger,
      this.id,
      value,
      typeof unitRaw === 'string' ? unitRaw : undefined,
      quantity,
    )
    if (stored === null) return
    const prev = this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_START
    const update = applyDeviceClass(prev, deviceClass, stored, lastFetchedAt)
    if (update !== null) this.runtimeState.setCapState('power-meter', update)
  }

  private registerPowerMeterCap(): void {
    const provider: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_START
      },
    }
    this.ctx.registerNativeCap(powerMeterCapability, provider)
  }
}

function powerQuantity(deviceClass: string | null): ReadingQuantity | undefined {
  switch (deviceClass) {
    case 'power':
      return 'power'
    case 'energy':
      return 'energy'
    case 'voltage':
      return 'voltage'
    case 'current':
      return 'current'
    default:
      return undefined
  }
}

function applyDeviceClass(
  prev: PowerMeterStatus,
  deviceClass: string | null,
  value: number,
  lastFetchedAt: number,
): PowerMeterStatus | null {
  switch (deviceClass) {
    case 'power':
      return { ...prev, power: value, lastFetchedAt }
    case 'energy':
      return { ...prev, energy: value, lastFetchedAt }
    case 'voltage':
      return { ...prev, voltage: value, lastFetchedAt }
    case 'current':
      return { ...prev, current: value, lastFetchedAt }
    default:
      return null
  }
}
