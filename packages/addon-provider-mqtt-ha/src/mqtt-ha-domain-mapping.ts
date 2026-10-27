import { DeviceType } from '@camstack/types'
import type { MqttHaEntity } from './mqtt-ha-discovery-types.js'

/**
 * Discovery component + `device_class` + unit → CamStack caps. Generic by
 * design: nothing here knows a bridge, a vendor or a model.
 *
 * One physical device is ONE CamStack device. Its primary function (climate,
 * light, switch, event, else sensor) picks the device type; the other entities
 * become caps of that device, never separate sensors (D951): power, energy,
 * voltage and current fold into the `power-meter` of the load, and the battery
 * is the `battery` cap. Diagnostic and config entities (link quality, battery
 * voltage, child lock, …) are not exposed.
 */

export type MqttHaCap =
  | 'switch'
  | 'brightness'
  | 'color'
  | 'power-meter'
  | 'battery'
  | 'contact'
  | 'motion'
  | 'flood'
  | 'vibration'
  | 'tamper'
  | 'temperature-sensor'
  | 'humidity-sensor'
  | 'ambient-light-sensor'
  | 'numeric-sensor'
  | 'climate-control'
  | 'event-emitter'

export type MqttHaBinaryCap = 'contact' | 'motion' | 'flood' | 'vibration' | 'tamper'

/** The `power-meter` status field a reading lands in. */
export type MqttHaMeterField = 'watts' | 'kwhTotal' | 'volts' | 'amps'

export type MqttHaMeterEntities = Partial<Record<MqttHaMeterField, string>>

const METER_FIELD_BY_CLASS: Readonly<Record<string, MqttHaMeterField>> = {
  power: 'watts',
  energy: 'kwhTotal',
  voltage: 'volts',
  current: 'amps',
}

const BINARY_CAP_BY_CLASS: Readonly<Record<string, MqttHaBinaryCap>> = {
  door: 'contact',
  window: 'contact',
  garage_door: 'contact',
  opening: 'contact',
  motion: 'motion',
  occupancy: 'motion',
  presence: 'motion',
  moving: 'motion',
  moisture: 'flood',
  vibration: 'vibration',
  tamper: 'tamper',
}

export type MqttHaRole =
  | { readonly kind: 'switch' }
  | { readonly kind: 'light' }
  | { readonly kind: 'climate' }
  | { readonly kind: 'event' }
  | { readonly kind: 'binary'; readonly cap: MqttHaBinaryCap }
  | { readonly kind: 'meter'; readonly field: MqttHaMeterField }
  | { readonly kind: 'battery' }
  | { readonly kind: 'temperature' }
  | { readonly kind: 'humidity' }
  | { readonly kind: 'illuminance' }
  | { readonly kind: 'numeric' }

function classifySensor(entity: MqttHaEntity): MqttHaRole | null {
  const deviceClass = entity.deviceClass
  if (deviceClass === 'battery') return { kind: 'battery' }
  if (entity.entityCategory !== null) return null
  if (deviceClass !== null) {
    const field = METER_FIELD_BY_CLASS[deviceClass]
    if (field !== undefined) return { kind: 'meter', field }
    if (deviceClass === 'temperature') return { kind: 'temperature' }
    if (deviceClass === 'humidity') return { kind: 'humidity' }
    if (deviceClass === 'illuminance' || deviceClass === 'illuminance_lux') {
      return { kind: 'illuminance' }
    }
  }
  return { kind: 'numeric' }
}

/** What an entity is to CamStack; null when it is not exposed. */
export function classifyMqttHaEntity(entity: MqttHaEntity): MqttHaRole | null {
  switch (entity.component) {
    case 'switch':
      return entity.entityCategory === null ? { kind: 'switch' } : null
    case 'light':
      return entity.entityCategory === null ? { kind: 'light' } : null
    case 'climate':
      return { kind: 'climate' }
    case 'event':
      return { kind: 'event' }
    case 'binary_sensor': {
      if (entity.entityCategory !== null || entity.deviceClass === null) return null
      const cap = BINARY_CAP_BY_CLASS[entity.deviceClass]
      return cap === undefined ? null : { kind: 'binary', cap }
    }
    case 'sensor':
      return classifySensor(entity)
  }
}

/** A switch, light or climate entity: one function that cannot share a device with another. */
export function isActuatorEntity(entity: MqttHaEntity): boolean {
  const role = classifyMqttHaEntity(entity)
  return (
    role !== null && (role.kind === 'switch' || role.kind === 'light' || role.kind === 'climate')
  )
}

export interface MqttHaDevicePlan {
  readonly deviceType: DeviceType
  /** Caps the device registers, primary first. */
  readonly capabilities: readonly MqttHaCap[]
  /** Cap → the entity that feeds it (`power-meter` is fed through `meter`). */
  readonly bindings: Readonly<Partial<Record<MqttHaCap, string>>>
  /** `power-meter` field → the entity that feeds it (D951). */
  readonly meter: Readonly<MqttHaMeterEntities>
  /** Entities the device keeps (those feeding a cap). */
  readonly members: readonly MqttHaEntity[]
  /** Entities of the physical device that feed nothing (diagnostics, unsupported). */
  readonly skipped: readonly string[]
}

const COLOR_MODES: ReadonlySet<string> = new Set(['color_temp', 'xy', 'hs', 'rgb', 'rgbw', 'rgbww'])

const ALLOWED_CAPS: Readonly<Record<string, ReadonlySet<MqttHaCap>>> = {
  [DeviceType.Thermostat]: new Set<MqttHaCap>(['climate-control', 'battery', 'power-meter']),
  [DeviceType.Light]: new Set<MqttHaCap>(['switch', 'brightness', 'color', 'power-meter']),
  [DeviceType.Switch]: new Set<MqttHaCap>(['switch', 'power-meter', 'battery']),
  [DeviceType.EventEmitter]: new Set<MqttHaCap>(['event-emitter', 'battery']),
  [DeviceType.Sensor]: new Set<MqttHaCap>([
    'contact',
    'motion',
    'flood',
    'vibration',
    'tamper',
    'temperature-sensor',
    'humidity-sensor',
    'ambient-light-sensor',
    'numeric-sensor',
    'power-meter',
    'battery',
  ]),
}

/** Cap order on the device: function first, then readings, battery last. */
const CAP_ORDER: readonly MqttHaCap[] = [
  'climate-control',
  'switch',
  'brightness',
  'color',
  'event-emitter',
  'contact',
  'motion',
  'flood',
  'vibration',
  'tamper',
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'numeric-sensor',
  'power-meter',
  'battery',
]

interface RoleEntity {
  readonly entity: MqttHaEntity
  readonly role: MqttHaRole
}

function primaryType(roles: readonly RoleEntity[]): DeviceType | null {
  const kinds = new Set(roles.map((r) => r.role.kind))
  if (kinds.has('climate')) return DeviceType.Thermostat
  if (kinds.has('light')) return DeviceType.Light
  if (kinds.has('switch')) return DeviceType.Switch
  if (kinds.has('event')) return DeviceType.EventEmitter
  return roles.length > 0 ? DeviceType.Sensor : null
}

function capsFor(item: RoleEntity): readonly MqttHaCap[] {
  const { entity, role } = item
  switch (role.kind) {
    case 'switch':
      return ['switch']
    case 'light': {
      const caps: MqttHaCap[] = ['switch']
      if (entity.light?.json === true && entity.light.brightness) caps.push('brightness')
      if (
        entity.light?.json === true &&
        entity.light.supportedColorModes.some((m) => COLOR_MODES.has(m))
      ) {
        caps.push('color')
      }
      return caps
    }
    case 'climate':
      return ['climate-control']
    case 'event':
      return ['event-emitter']
    case 'binary':
      return [role.cap]
    case 'meter':
      return ['power-meter']
    case 'battery':
      return ['battery']
    case 'temperature':
      return ['temperature-sensor']
    case 'humidity':
      return ['humidity-sensor']
    case 'illuminance':
      return ['ambient-light-sensor']
    case 'numeric':
      return ['numeric-sensor']
  }
}

/** Specific readings win over the generic numeric sensor, which is only a fallback. */
const SPECIFIC_READINGS: ReadonlySet<MqttHaCap> = new Set([
  'contact',
  'motion',
  'flood',
  'vibration',
  'tamper',
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'power-meter',
])

/**
 * Plan one physical device (or one gang of a multi-gang one): its type, caps
 * and which entity feeds which. Null when nothing in it can be exposed.
 */
export function planMqttHaDevice(input: {
  readonly entities: readonly MqttHaEntity[]
}): MqttHaDevicePlan | null {
  const roles: RoleEntity[] = []
  for (const entity of input.entities) {
    const role = classifyMqttHaEntity(entity)
    if (role !== null) roles.push({ entity, role })
  }
  const deviceType = primaryType(roles)
  if (deviceType === null) return null
  const allowed = ALLOWED_CAPS[deviceType]
  if (allowed === undefined) return null

  const bindings: Partial<Record<MqttHaCap, string>> = {}
  const meter: MqttHaMeterEntities = {}
  for (const item of roles) {
    for (const cap of capsFor(item)) {
      if (!allowed.has(cap)) continue
      if (item.role.kind === 'meter') {
        if (meter[item.role.field] !== undefined) continue
        meter[item.role.field] = item.entity.entityKey
        continue
      }
      // A light's switch / brightness / colour all read the same entity.
      if (bindings[cap] !== undefined) continue
      bindings[cap] = item.entity.entityKey
    }
  }
  if (Object.keys(meter).length > 0) bindings['power-meter'] = Object.values(meter)[0]

  const present = new Set<MqttHaCap>(Object.keys(bindings).filter(isMqttHaCap))
  if (
    bindings['numeric-sensor'] !== undefined &&
    [...present].some((c) => SPECIFIC_READINGS.has(c))
  ) {
    delete bindings['numeric-sensor']
    present.delete('numeric-sensor')
  }
  const capabilities = CAP_ORDER.filter((cap) => present.has(cap))
  if (capabilities.length === 0) return null

  const feeding = new Set<string>(Object.values(bindings))
  for (const entityKey of Object.values(meter)) feeding.add(entityKey)
  const members = input.entities.filter((e) => feeding.has(e.entityKey))
  const skipped = input.entities.filter((e) => !feeding.has(e.entityKey)).map((e) => e.entityKey)
  return { deviceType, capabilities, bindings, meter, members, skipped }
}

function isMqttHaCap(value: string): value is MqttHaCap {
  return CAP_ORDER.some((cap) => cap === value)
}
