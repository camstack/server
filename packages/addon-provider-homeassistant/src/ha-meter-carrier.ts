import {
  powerMeterCapability,
  type DeviceContext,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  type IScopedLogger,
  type PowerMeterStatus,
} from '@camstack/types'
import { takeReading } from './ha-reading.js'
import {
  applyMeterReading,
  METER_FIELDS,
  meterKindForDeviceClass,
  type MeterEntities,
  type MeterField,
} from './ha-meter-fold.js'
import type { HaEntityState } from './ha-types.js'

const COLD_START: PowerMeterStatus = { lastFetchedAt: 0 }

/**
 * The `power-meter` of a device whose power / energy readings come from sibling
 * HA sensors (D951). It registers the cap, names the entities the owner must
 * subscribe to, and turns each of their pushes into one field of the slice.
 * The owner is any HA child that is an electrical load (switch, light, fan, ...);
 * none of them knows how a reading is converted.
 */
export class HaMeterCarrier {
  private readonly fieldByEntity: ReadonlyMap<string, MeterField>

  constructor(
    private readonly ctx: DeviceContext,
    private readonly runtimeState: IDeviceRuntimeState,
    private readonly logger: IScopedLogger,
    private readonly deviceId: number,
    meters: MeterEntities,
  ) {
    this.fieldByEntity = new Map(
      METER_FIELDS.flatMap((field): [string, MeterField][] => {
        const entityId = meters[field]
        return entityId === undefined ? [] : [[entityId, field]]
      }),
    )
    const provider: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_START,
    }
    this.ctx.registerNativeCap(powerMeterCapability, provider)
    this.runtimeState.setCapState('power-meter', {
      ...COLD_START,
      ...this.runtimeState.getCapState<PowerMeterStatus>('power-meter'),
    })
  }

  /** The meter entities the owner must subscribe to, beside its own. */
  entityIds(): readonly string[] {
    return [...this.fieldByEntity.keys()]
  }

  /** Whether a push belongs to one of the meter entities. */
  carries(entityId: string): boolean {
    return this.fieldByEntity.has(entityId)
  }

  /** Apply one meter push; an unavailable or unreadable sample changes nothing. */
  push(entityId: string, state: HaEntityState): void {
    const field = this.fieldByEntity.get(entityId)
    if (field === undefined) return
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const value = Number(state.state)
    if (!Number.isFinite(value)) return
    const deviceClass = state.attributes['device_class']
    const kind = meterKindForDeviceClass(typeof deviceClass === 'string' ? deviceClass : null)
    if (kind === undefined || kind.field !== field) return
    const unit = state.attributes['unit_of_measurement']
    const stored = takeReading(
      this.logger,
      this.deviceId,
      value,
      typeof unit === 'string' ? unit : undefined,
      kind.quantity,
    )
    if (stored === null) return
    const prev = this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_START
    const lastFetchedAt = Date.parse(state.last_updated) || Date.now()
    this.runtimeState.setCapState(
      'power-meter',
      applyMeterReading(prev, field, stored, lastFetchedAt),
    )
  }
}
