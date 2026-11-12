import { z } from 'zod'

/**
 * HA MQTT discovery components this addon understands as entities. A device
 * trigger (`device_automation`) is folded into an `event` entity
 * (`mqtt-ha-device-trigger.ts`); everything else a bridge publishes (update,
 * number, lock, cover, the HA `infrared` component, …) is ignored. `text`,
 * `select` and `button` carry commands only a device profile consumes
 * (`mqtt-ha-ir-profiles.ts`).
 */
export const MQTT_HA_COMPONENTS = [
  'sensor',
  'binary_sensor',
  'switch',
  'light',
  'event',
  'climate',
  'text',
  'select',
  'button',
] as const

export type MqttHaComponent = (typeof MQTT_HA_COMPONENTS)[number]

const topicReadSchema = z.object({
  topic: z.string().min(1),
  template: z.string().nullable(),
})

export type MqttHaTopicRead = z.infer<typeof topicReadSchema>

const availabilitySchema = z.object({
  topic: z.string().min(1),
  payloadAvailable: z.string(),
  payloadNotAvailable: z.string(),
  valueTemplate: z.string().nullable(),
})

export type MqttHaAvailability = z.infer<typeof availabilitySchema>

/** The discovery `device` block: what groups entities into one physical device. */
const deviceInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
})

export type MqttHaDeviceInfo = z.infer<typeof deviceInfoSchema>

const lightSchema = z.object({
  /** `schema: json` — state and commands are JSON objects on one topic. */
  json: z.boolean(),
  brightness: z.boolean(),
  brightnessScale: z.number().positive(),
  supportedColorModes: z.array(z.string()),
})

export type MqttHaLightSpec = z.infer<typeof lightSchema>

const climateSchema = z.object({
  currentTemperature: topicReadSchema.nullable(),
  targetTemperature: topicReadSchema.nullable(),
  mode: topicReadSchema.nullable(),
  temperatureCommandTopic: z.string().nullable(),
  modeCommandTopic: z.string().nullable(),
  modes: z.array(z.string()),
  minTemp: z.number().nullable(),
  maxTemp: z.number().nullable(),
  tempStep: z.number().positive().nullable(),
})

export type MqttHaClimateSpec = z.infer<typeof climateSchema>

/**
 * Normalised discovery record for one MQTT entity. The same shape is kept in
 * the in-memory inventory and persisted inside an adopted device, so a device
 * works after a restart before any discovery message has been replayed.
 */
export const mqttHaEntitySchema = z.object({
  /** Opaque entity id (`unique_id`, else `component/[node_id/]object_id`). */
  entityKey: z.string().min(1),
  component: z.enum(MQTT_HA_COMPONENTS),
  /** The `<node_id>` topic level of the 4-level form (zigbee2mqtt, ESPHome); absent in the 3-level form. */
  nodeId: z.string().optional(),
  objectId: z.string(),
  name: z.string(),
  /** Null for a command-only entity (a SET-only text, select or button). */
  stateTopic: z.string().min(1).nullable(),
  commandTopic: z.string().nullable(),
  /** The discovery `command_template`; a profile that publishes a bare payload refuses an entity that has one. */
  commandTemplate: z.string().nullable().default(null),
  unitOfMeasurement: z.string().nullable(),
  deviceClass: z.string().nullable(),
  entityCategory: z.enum(['diagnostic', 'config']).nullable(),
  valueTemplate: z.string().nullable(),
  /** Payload sent to turn the entity on (command side). */
  payloadOn: z.string(),
  payloadOff: z.string(),
  /** Button `payload_press`. Null when discovery did not set one. */
  payloadPress: z.string().nullable().default(null),
  /** State payload that reads as on; falls back to `payloadOn`. */
  stateOn: z.string().nullable(),
  stateOff: z.string().nullable(),
  uniqueId: z.string().nullable(),
  availability: z.array(availabilitySchema),
  availabilityMode: z.enum(['all', 'any', 'latest']),
  device: deviceInfoSchema.nullable(),
  /** The discovery `origin.name`: which bridge published the entity. */
  origin: z.string().nullable().default(null),
  light: lightSchema.nullable(),
  eventTypes: z.array(z.string()),
  climate: climateSchema.nullable(),
})

export type MqttHaEntity = z.infer<typeof mqttHaEntitySchema>

/** An entity as the broker session inventories it. */
export interface MqttHaDiscoveredEntity extends MqttHaEntity {
  readonly brokerId: string
  readonly discoveredAt: number
}

export interface ParsedDiscoveryTopic {
  readonly discoveryPrefix: string
  readonly component: string
  readonly nodeId?: string
  readonly objectId: string
}
