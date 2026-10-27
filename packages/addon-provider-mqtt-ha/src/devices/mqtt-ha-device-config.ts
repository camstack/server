import { z } from 'zod'
import { mqttHaEntitySchema, type MqttHaEntity } from '../mqtt-ha-discovery-types.js'
import type { MqttHaCap, MqttHaMeterEntities } from '../mqtt-ha-domain-mapping.js'

/**
 * Persisted config of an adopted device. A device adopted by the current
 * flow carries its member `entities`, which cap each one feeds (`bindings`)
 * and the meter fields (`meter`, D951). A device adopted before devices were
 * grouped carries one flat sensor or switch (`component`, `stateTopic`, …);
 * it is read as a one-entity device.
 */
export const mqttHaDeviceSchema = z.object({
  brokerId: z.string().min(1),
  /** Legacy single entity, or the first member of a grouped device. */
  entityKey: z.string().min(1),
  /** Discovery `device` identifier of a grouped device. */
  deviceKey: z.string().optional(),
  entities: z.array(mqttHaEntitySchema).default([]),
  bindings: z.record(z.string(), z.string()).default({}),
  meter: z.record(z.string(), z.string()).default({}),
  capabilities: z.array(z.string()).default([]),
  // Legacy flat fields.
  component: z.enum(['sensor', 'switch']).optional(),
  stateTopic: z.string().optional(),
  commandTopic: z.string().nullable().optional(),
  unitOfMeasurement: z.string().nullable().optional(),
  payloadOn: z.string().default('ON'),
  payloadOff: z.string().default('OFF'),
  system: z.literal('mqtt-ha').optional(),
  integrationId: z.string().optional(),
})

export type MqttHaDeviceConfig = z.infer<typeof mqttHaDeviceSchema>

/** What a device reads: its entities and the cap each feeds. */
export interface MqttHaDeviceModel {
  readonly entities: ReadonlyMap<string, MqttHaEntity>
  readonly bindings: ReadonlyMap<MqttHaCap, string>
  readonly meter: Readonly<MqttHaMeterEntities>
  readonly capabilities: readonly MqttHaCap[]
}

const CAP_NAMES: readonly MqttHaCap[] = [
  'switch',
  'brightness',
  'color',
  'power-meter',
  'battery',
  'contact',
  'motion',
  'flood',
  'vibration',
  'tamper',
  'temperature-sensor',
  'humidity-sensor',
  'ambient-light-sensor',
  'numeric-sensor',
  'climate-control',
  'event-emitter',
]

export function isMqttHaCap(value: string): value is MqttHaCap {
  return CAP_NAMES.some((cap) => cap === value)
}

function legacyEntity(config: MqttHaDeviceConfig): MqttHaEntity | null {
  if (config.component === undefined || config.stateTopic === undefined) return null
  return {
    entityKey: config.entityKey,
    component: config.component,
    objectId: config.entityKey,
    name: config.entityKey,
    stateTopic: config.stateTopic,
    commandTopic: config.commandTopic ?? null,
    unitOfMeasurement: config.unitOfMeasurement ?? null,
    deviceClass: null,
    entityCategory: null,
    valueTemplate: null,
    payloadOn: config.payloadOn,
    payloadOff: config.payloadOff,
    stateOn: null,
    stateOff: null,
    uniqueId: null,
    availability: [],
    availabilityMode: 'latest',
    device: null,
    light: null,
    eventTypes: [],
    climate: null,
  }
}

function meterEntities(config: MqttHaDeviceConfig): MqttHaMeterEntities {
  const out: MqttHaMeterEntities = {}
  for (const [field, entityKey] of Object.entries(config.meter)) {
    if (field === 'watts' || field === 'kwhTotal' || field === 'volts' || field === 'amps') {
      out[field] = entityKey
    }
  }
  return out
}

/** Resolve a persisted config (current or legacy) into what the device reads. */
export function resolveDeviceModel(config: MqttHaDeviceConfig): MqttHaDeviceModel {
  const entities = new Map<string, MqttHaEntity>(config.entities.map((e) => [e.entityKey, e]))
  const bindings = new Map<MqttHaCap, string>()
  if (entities.size === 0) {
    const legacy = legacyEntity(config)
    if (legacy !== null) {
      entities.set(legacy.entityKey, legacy)
      const cap: MqttHaCap = legacy.component === 'switch' ? 'switch' : 'numeric-sensor'
      bindings.set(cap, legacy.entityKey)
    }
  } else {
    for (const [cap, entityKey] of Object.entries(config.bindings)) {
      if (isMqttHaCap(cap)) bindings.set(cap, entityKey)
    }
  }
  const capabilities =
    entities.size > 0 && config.entities.length === 0
      ? [...bindings.keys()]
      : config.capabilities.filter(isMqttHaCap)
  return { entities, bindings, meter: meterEntities(config), capabilities }
}
