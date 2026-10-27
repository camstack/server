import {
  DeviceType,
  powerMeterCapability,
  type PowerMeterStatus,
  type ReadingQuantity,
} from '@camstack/types'
import type { HaContainerEntityConfig } from './ha-container-reconcile.js'

/**
 * Power and energy are a feature of the electrical device itself (D951). A
 * metered plug is exposed by Home Assistant as a switch plus separate
 * power / energy / voltage / current sensors; the switch carries the readings
 * and the sensors stay as children (D865), flagged `foldedInto`.
 */

/** The `power-meter` status field a reading lands in. */
export const METER_FIELDS = ['watts', 'kwhTotal', 'volts', 'amps'] as const
export type MeterField = (typeof METER_FIELDS)[number]

/** Reading field → the sibling sensor entity it is read from. */
export type MeterEntities = Readonly<Partial<Record<MeterField, string>>>

interface MeterKind {
  readonly field: MeterField
  readonly quantity: ReadingQuantity
}

const METER_BY_DEVICE_CLASS: Readonly<Record<string, MeterKind>> = {
  power: { field: 'watts', quantity: 'power' },
  energy: { field: 'kwhTotal', quantity: 'energy' },
  voltage: { field: 'volts', quantity: 'voltage' },
  current: { field: 'amps', quantity: 'current' },
}

/** The meter field and quantity an HA `device_class` feeds; undefined for any other class. */
export function meterKindForDeviceClass(
  deviceClass: string | null | undefined,
): MeterKind | undefined {
  return deviceClass === null || deviceClass === undefined
    ? undefined
    : METER_BY_DEVICE_CLASS[deviceClass]
}

/** Status with one reading applied; the clock moves with it. */
export function applyMeterReading(
  prev: PowerMeterStatus,
  field: MeterField,
  value: number,
  lastFetchedAt: number,
): PowerMeterStatus {
  return { ...prev, [field]: value, lastFetchedAt }
}

const LOAD_TYPES: ReadonlySet<DeviceType> = new Set(
  powerMeterCapability.deviceTypes.filter((type) => type !== DeviceType.Sensor),
)

function isLoad(entity: HaContainerEntityConfig): boolean {
  return (
    LOAD_TYPES.has(entity.deviceType) &&
    entity.entityCategory === undefined &&
    !entity.capabilities.includes('power-meter')
  )
}

function meterFieldOf(entity: HaContainerEntityConfig): MeterField | undefined {
  if (!entity.capabilities.includes('power-meter')) return undefined
  return meterKindForDeviceClass(entity.deviceClass)?.field
}

/**
 * Fold the device's meter sensors into its electrical load: the first normal
 * control of a load type gains `power-meter` and the entity ids it reads; each
 * sensor it reads is flagged `foldedInto`. A device with no load, or no meter,
 * comes back unchanged.
 */
export function foldMeterEntities(
  entities: readonly HaContainerEntityConfig[],
): HaContainerEntityConfig[] {
  const primary = entities.find(isLoad)
  if (primary === undefined) return [...entities]
  const meters: Partial<Record<MeterField, string>> = {}
  for (const entity of entities) {
    const field = meterFieldOf(entity)
    if (field !== undefined && meters[field] === undefined) meters[field] = entity.entityId
  }
  const folded = new Set(Object.values(meters))
  if (folded.size === 0) return [...entities]
  return entities.map((entity) => {
    if (entity.entityId === primary.entityId) {
      return {
        ...entity,
        capabilities: [...entity.capabilities, 'power-meter'],
        meterEntities: meters,
      }
    }
    return folded.has(entity.entityId) ? { ...entity, foldedInto: primary.entityId } : entity
  })
}
