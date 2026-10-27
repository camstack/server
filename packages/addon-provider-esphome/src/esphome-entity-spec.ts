import type { EspEntity } from './esphome-link.js'

/** What a board entity becomes in CamStack. One plan = one child device. */
export type ChildKind =
  | 'switch'
  | 'light'
  | 'cover'
  | 'button'
  | 'number-control'
  | 'select-control'
  | 'event'
  | 'numeric-sensor'
  | 'enum-sensor'
  | 'contact'
  | 'flood'
  | 'smoke'
  | 'motion'
  | 'binary'
  | 'power-meter'

/** Which board sensor feeds each `power-meter` field. */
export interface PowerSlots {
  readonly watts?: string
  readonly kwhTotal?: string
  readonly volts?: string
  readonly amps?: string
  readonly va?: string
  readonly powerFactor?: string
}

export interface ChildPlan {
  readonly kind: ChildKind
  /** Stable suffix inside the board; the entity id, or `power-meter` for the aggregate. */
  readonly key: string
  readonly name: string
  /** The entity behind a one-to-one child. */
  readonly entity?: EspEntity
  /** The entities behind a power meter. */
  readonly slots?: PowerSlots
  /** The unit each power-meter field's entity reports in, keyed like `slots`. */
  readonly slotUnits?: Readonly<Record<string, string>>
}

const POWER_CLASS_TO_SLOT: Readonly<Record<string, keyof PowerSlots>> = {
  power: 'watts',
  energy: 'kwhTotal',
  voltage: 'volts',
  current: 'amps',
  apparent_power: 'va',
  power_factor: 'powerFactor',
}

const POWER_METER_KEY = 'power-meter'

function binaryKind(deviceClass: string): ChildKind {
  switch (deviceClass) {
    case 'door':
    case 'window':
    case 'opening':
    case 'garage_door':
      return 'contact'
    case 'moisture':
      return 'flood'
    case 'smoke':
      return 'smoke'
    case 'motion':
    case 'occupancy':
    case 'presence':
      return 'motion'
    default:
      return 'binary'
  }
}

/** Operator-facing entities only: no firmware plumbing, nothing the board hides by default. */
function isExposed(entity: EspEntity): boolean {
  if (entity.disabledByDefault) return false
  if (entity.category === 'diagnostic') return false
  if (entity.type === 'binary_sensor' && entity.isStatusBinarySensor) return false
  return true
}

function single(kind: ChildKind, entity: EspEntity): ChildPlan {
  return { kind, key: entity.id, name: entity.name, entity }
}

/**
 * Plan the children of one board (the container). Pure: the same entity list
 * always yields the same plan, which is what lets a reconnect re-derive the
 * children instead of persisting them.
 */
export function planBoard(entities: readonly EspEntity[]): ChildPlan[] {
  const plans: ChildPlan[] = []
  const slots: Record<string, string> = {}
  const slotUnits: Record<string, string> = {}

  for (const entity of entities) {
    if (!isExposed(entity)) continue
    switch (entity.type) {
      case 'switch':
        plans.push(single('switch', entity))
        break
      case 'light':
        plans.push(single('light', entity))
        break
      case 'cover':
        plans.push(single('cover', entity))
        break
      case 'button':
        plans.push(single('button', entity))
        break
      case 'number':
        plans.push(single('number-control', entity))
        break
      case 'select':
        plans.push(single('select-control', entity))
        break
      case 'event':
        plans.push(single('event', entity))
        break
      case 'text_sensor':
        plans.push(single('enum-sensor', entity))
        break
      case 'binary_sensor':
        plans.push(single(binaryKind(entity.deviceClass), entity))
        break
      case 'sensor': {
        const slot = POWER_CLASS_TO_SLOT[entity.deviceClass]
        if (slot !== undefined && slots[slot] === undefined) {
          slots[slot] = entity.id
          slotUnits[slot] = entity.unit
        } else {
          plans.push(single('numeric-sensor', entity))
        }
        break
      }
    }
  }

  if (Object.keys(slots).length > 0) {
    const meter: ChildPlan = {
      kind: 'power-meter',
      key: POWER_METER_KEY,
      name: 'Power',
      slots,
      slotUnits,
    }
    // The aggregate leads the sensors so its position does not depend on sensor order.
    const firstSensor = plans.findIndex((p) => p.kind === 'numeric-sensor')
    if (firstSensor === -1) plans.push(meter)
    else plans.splice(firstSensor, 0, meter)
  }
  return plans
}
