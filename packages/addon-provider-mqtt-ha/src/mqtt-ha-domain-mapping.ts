import { DeviceType } from '@dominevo/types'
import type { MqttHaEntity } from './mqtt-ha-discovery-types.js'
import { matchIrProfile } from './mqtt-ha-ir-profiles.js'

/**
 * Discovery component + `device_class` + unit → Dominevo caps. Generic by
 * design: nothing here knows a bridge, a vendor or a model.
 *
 * One physical device is ONE Dominevo device. Its primary function (climate,
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
  | 'air-quality-sensor'
  | 'numeric-sensor'
  | 'climate-control'
  | 'event-emitter'
  | 'ir-transmitter'

export type MqttHaBinaryCap = 'contact' | 'motion' | 'flood' | 'vibration' | 'tamper'

/** The `power-meter` status field a reading lands in. */
export type MqttHaMeterField = 'power' | 'energy' | 'voltage' | 'current'

export type MqttHaMeterEntities = Partial<Record<MqttHaMeterField, string>>

/** The `air-quality-sensor` status field a reading lands in. */
export type MqttHaAirField = 'co2' | 'voc' | 'pm25' | 'pm10' | 'aqi'

export type MqttHaAirEntities = Partial<Record<MqttHaAirField, string>>

const AIR_FIELD_BY_CLASS: Readonly<Record<string, MqttHaAirField>> = {
  carbon_dioxide: 'co2',
  co2: 'co2',
  volatile_organic_compounds: 'voc',
  volatile_organic_compounds_parts: 'voc',
  pm25: 'pm25',
  pm2_5: 'pm25',
  pm10: 'pm10',
  aqi: 'aqi',
}

const METER_FIELD_BY_CLASS: Readonly<Record<string, MqttHaMeterField>> = {
  power: 'power',
  energy: 'energy',
  voltage: 'voltage',
  current: 'current',
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
  | { readonly kind: 'air'; readonly field: MqttHaAirField }
  | { readonly kind: 'battery' }
  | { readonly kind: 'temperature' }
  | { readonly kind: 'humidity' }
  | { readonly kind: 'illuminance' }
  | { readonly kind: 'numeric' }
  | { readonly kind: 'ir' }

function classifySensor(entity: MqttHaEntity): MqttHaRole | null {
  const deviceClass = entity.deviceClass
  if (deviceClass === 'battery') return { kind: 'battery' }
  if (entity.entityCategory !== null) return null
  if (deviceClass !== null) {
    const field = METER_FIELD_BY_CLASS[deviceClass]
    if (field !== undefined) return { kind: 'meter', field }
    const air = AIR_FIELD_BY_CLASS[deviceClass]
    if (air !== undefined) return { kind: 'air', field: air }
    if (deviceClass === 'temperature') return { kind: 'temperature' }
    if (deviceClass === 'humidity') return { kind: 'humidity' }
    if (deviceClass === 'illuminance' || deviceClass === 'illuminance_lux') {
      return { kind: 'illuminance' }
    }
  }
  return { kind: 'numeric' }
}

/** What an entity is to Dominevo; null when it is not exposed. */
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
    case 'text':
    case 'select':
    case 'button':
      // Commands a device profile consumes; alone they are not exposed.
      return null
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
  /** `air-quality-sensor` field → the entity that feeds it. */
  readonly air: Readonly<MqttHaAirEntities>
  /** Entities the device keeps (those feeding a cap). */
  readonly members: readonly MqttHaEntity[]
  /** Entities of the physical device that feed nothing (diagnostics, unsupported). */
  readonly skipped: readonly string[]
  /** The same entities as full records: the device keeps them so its raw state can list them. */
  readonly skippedEntities: readonly MqttHaEntity[]
}

const COLOR_MODES: ReadonlySet<string> = new Set(['color_temp', 'xy', 'hs', 'rgb', 'rgbw', 'rgbww'])

const ALLOWED_CAPS: Readonly<Record<string, ReadonlySet<MqttHaCap>>> = {
  [DeviceType.Climate]: new Set<MqttHaCap>(['climate-control', 'battery', 'power-meter']),
  [DeviceType.Light]: new Set<MqttHaCap>(['switch', 'brightness', 'color', 'power-meter']),
  [DeviceType.Switch]: new Set<MqttHaCap>(['switch', 'power-meter', 'battery']),
  [DeviceType.EventEmitter]: new Set<MqttHaCap>(['event-emitter', 'battery']),
  // An IR blaster keeps its other readings (battery, a temperature, a counter).
  [DeviceType.Generic]: new Set<MqttHaCap>([
    'ir-transmitter',
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
  [DeviceType.Sensor]: new Set<MqttHaCap>([
    'contact',
    'motion',
    'flood',
    'vibration',
    'tamper',
    'temperature-sensor',
    'humidity-sensor',
    'ambient-light-sensor',
    'air-quality-sensor',
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
  'air-quality-sensor',
  'numeric-sensor',
  'power-meter',
  'battery',
  'ir-transmitter',
]

interface RoleEntity {
  readonly entity: MqttHaEntity
  readonly role: MqttHaRole
}

function primaryType(roles: readonly RoleEntity[]): DeviceType | null {
  const kinds = new Set(roles.map((r) => r.role.kind))
  if (kinds.has('ir')) return DeviceType.Generic
  if (kinds.has('climate')) return DeviceType.Climate
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
    case 'air':
      return ['air-quality-sensor']
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
    case 'ir':
      return ['ir-transmitter']
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
  'air-quality-sensor',
  'power-meter',
])

/**
 * Plan one physical device (or one gang of a multi-gang one): its type, caps
 * and which entity feeds which. Null when nothing in it can be exposed.
 */
export function planMqttHaDevice(input: {
  readonly entities: readonly MqttHaEntity[]
  /** Told why an IR profile that otherwise matched was refused. */
  readonly onIrRefused?: (reason: string) => void
}): MqttHaDevicePlan | null {
  const roles: RoleEntity[] = []
  // An IR blaster's send, learn and learned entities are one transmitter.
  const ir = matchIrProfile(input.entities, input.onIrRefused)
  const irKeys = new Set(
    ir === null ? [] : [ir.send.entityKey, ir.learn.entityKey, ir.learned.entityKey],
  )
  for (const entity of input.entities) {
    if (ir !== null && irKeys.has(entity.entityKey)) {
      if (entity.entityKey === ir.send.entityKey) roles.push({ entity, role: { kind: 'ir' } })
      continue
    }
    const role = classifyMqttHaEntity(entity)
    if (role !== null) roles.push({ entity, role })
  }
  const deviceType = primaryType(roles)
  if (deviceType === null) return null
  const allowed = ALLOWED_CAPS[deviceType]
  if (allowed === undefined) return null

  const bindings: Partial<Record<MqttHaCap, string>> = {}
  const meter: MqttHaMeterEntities = {}
  const air: MqttHaAirEntities = {}
  for (const item of roles) {
    for (const cap of capsFor(item)) {
      if (!allowed.has(cap)) continue
      if (item.role.kind === 'meter') {
        if (meter[item.role.field] !== undefined) continue
        meter[item.role.field] = item.entity.entityKey
        continue
      }
      if (item.role.kind === 'air') {
        if (air[item.role.field] !== undefined) continue
        air[item.role.field] = item.entity.entityKey
        continue
      }
      // A light's switch / brightness / colour all read the same entity.
      if (bindings[cap] !== undefined) continue
      bindings[cap] = item.entity.entityKey
    }
  }
  if (Object.keys(meter).length > 0) bindings['power-meter'] = Object.values(meter)[0]
  if (Object.keys(air).length > 0) bindings['air-quality-sensor'] = Object.values(air)[0]

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
  for (const entityKey of irKeys) feeding.add(entityKey)
  for (const entityKey of Object.values(meter)) feeding.add(entityKey)
  for (const entityKey of Object.values(air)) feeding.add(entityKey)
  const members = input.entities.filter((e) => feeding.has(e.entityKey))
  const skippedEntities = input.entities.filter((e) => !feeding.has(e.entityKey))
  const skipped = skippedEntities.map((e) => e.entityKey)
  return { deviceType, capabilities, bindings, meter, air, members, skipped, skippedEntities }
}

function isMqttHaCap(value: string): value is MqttHaCap {
  return CAP_ORDER.some((cap) => cap === value)
}

/** Why an entity feeds no cap of its device, for the raw-state listing. */
export function mqttHaSkipReason(entity: MqttHaEntity): string {
  if (entity.entityCategory !== null) return `${entity.entityCategory} entity`
  if (classifyMqttHaEntity(entity) === null) {
    return `no capability for ${entity.component}${entity.deviceClass === null ? '' : ` / ${entity.deviceClass}`}`
  }
  return 'not offered by this device type'
}
