import { DeviceRole, DeviceType, type DeviceContext, type IDevice } from '@camstack/types'
import { EspActuatorDevice } from './devices/esp-actuator-device.js'
import type { EspChildConfig } from './devices/esp-child-device.js'
import { EspEventDevice } from './devices/esp-event-device.js'
import { EspSensorDevice } from './devices/esp-sensor-device.js'
import type { ChildKind, ChildPlan } from './esphome-entity-spec.js'

/** The CamStack device type of each child kind. */
const DEVICE_TYPE: Readonly<Record<ChildKind, DeviceType>> = {
  switch: DeviceType.Switch,
  light: DeviceType.Light,
  cover: DeviceType.Cover,
  button: DeviceType.Button,
  'number-control': DeviceType.Control,
  'select-control': DeviceType.Control,
  event: DeviceType.EventEmitter,
  'numeric-sensor': DeviceType.Sensor,
  'enum-sensor': DeviceType.Sensor,
  contact: DeviceType.Sensor,
  flood: DeviceType.Sensor,
  smoke: DeviceType.Sensor,
  motion: DeviceType.Sensor,
  binary: DeviceType.Sensor,
  'power-meter': DeviceType.Sensor,
}

/** The sub-type of the kinds that share a device type with others. */
const ROLE: Readonly<Partial<Record<ChildKind, DeviceRole>>> = {
  'number-control': DeviceRole.NumericControl,
  'select-control': DeviceRole.SelectControl,
  'numeric-sensor': DeviceRole.NumericSensor,
  'enum-sensor': DeviceRole.EnumSensor,
  contact: DeviceRole.ContactSensor,
  flood: DeviceRole.LeakSensor,
  smoke: DeviceRole.SmokeSensor,
  motion: DeviceRole.MotionSensor,
  binary: DeviceRole.BinarySensor,
  'power-meter': DeviceRole.PowerSensor,
}

export function deviceTypeOf(kind: ChildKind): DeviceType {
  return DEVICE_TYPE[kind]
}

export function roleOf(kind: ChildKind): DeviceRole | undefined {
  return ROLE[kind]
}

/** The persisted config of one child, derived from its plan. */
export function childConfigFor(plan: ChildPlan, brokerId: string): EspChildConfig {
  const entity = plan.entity
  const slotEntries = Object.entries(plan.slots ?? {}).filter(
    (pair): pair is [string, string] => pair[1] !== undefined,
  )
  return {
    brokerId,
    kind: plan.kind,
    ...(entity !== undefined ? { entityId: entity.id } : {}),
    ...(slotEntries.length > 0 ? { slots: Object.fromEntries(slotEntries) } : {}),
    ...(plan.slotUnits !== undefined ? { slotUnits: { ...plan.slotUnits } } : {}),
    ...(entity !== undefined && entity.unit.length > 0 ? { unit: entity.unit } : {}),
    ...(entity !== undefined && entity.deviceClass.length > 0
      ? { deviceClass: entity.deviceClass }
      : {}),
    ...(entity !== undefined && entity.options.length > 0 ? { options: [...entity.options] } : {}),
    ...(entity !== undefined && entity.min !== null ? { min: entity.min } : {}),
    ...(entity !== undefined && entity.max !== null ? { max: entity.max } : {}),
    ...(entity !== undefined && entity.step !== null ? { step: entity.step } : {}),
    ...(entity !== undefined && entity.eventTypes.length > 0
      ? { eventTypes: [...entity.eventTypes] }
      : {}),
    ...(entity?.supportsBrightness === true ? { supportsBrightness: true } : {}),
    ...(entity !== undefined && plan.kind === 'cover'
      ? { supportsPosition: entity.supportsPosition, supportsStop: entity.supportsStop }
      : {}),
  }
}

/** Construct the concrete child class of a kind. */
export function childFactoryFor(kind: ChildKind): (ctx: DeviceContext) => IDevice {
  switch (kind) {
    case 'switch':
    case 'light':
    case 'cover':
    case 'button':
    case 'number-control':
    case 'select-control':
      return (ctx) => new EspActuatorDevice(ctx)
    case 'event':
      return (ctx) => new EspEventDevice(ctx)
    case 'numeric-sensor':
    case 'enum-sensor':
    case 'contact':
    case 'flood':
    case 'smoke':
    case 'motion':
    case 'binary':
    case 'power-meter':
      return (ctx) => new EspSensorDevice(ctx)
  }
}
