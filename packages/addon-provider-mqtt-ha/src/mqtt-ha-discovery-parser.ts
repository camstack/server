import {
  MQTT_HA_COMPONENTS,
  type MqttHaAvailability,
  type MqttHaClimateSpec,
  type MqttHaComponent,
  type MqttHaDeviceInfo,
  type MqttHaDiscoveredEntity,
  type MqttHaLightSpec,
  type MqttHaTopicRead,
  type ParsedDiscoveryTopic,
} from './mqtt-ha-discovery-types.js'

import { MQTT_HA_TRIGGER_COMPONENT, triggerEntityKey } from './mqtt-ha-device-trigger.js'

const DEFAULT_DISCOVERY_PREFIX = 'homeassistant'

/** Components that may have no state topic: they are commands a device profile drives. */
const COMMAND_ONLY_COMPONENTS: ReadonlySet<MqttHaComponent> = new Set(['text', 'select', 'button'])

export function isSupportedMqttHaComponent(value: string): value is MqttHaComponent {
  return MQTT_HA_COMPONENTS.some((c) => c === value)
}

/**
 * Parse `homeassistant/{component}/[{node_id}/]{object_id}/config`.
 * Returns null when the topic is not a discovery config topic.
 */
export function parseDiscoveryConfigTopic(
  topic: string,
  discoveryPrefix: string = DEFAULT_DISCOVERY_PREFIX,
): ParsedDiscoveryTopic | null {
  const parts = topic.split('/').filter((p) => p.length > 0)
  if (parts.length !== 4 && parts.length !== 5) return null
  if (parts[0] !== discoveryPrefix) return null
  if (parts[parts.length - 1] !== 'config') return null
  const component = parts[1]
  const nodeId = parts.length === 5 ? parts[2] : undefined
  const objectId = parts[parts.length - 2]
  if (component === undefined || objectId === undefined) return null
  return {
    discoveryPrefix: parts[0],
    component,
    ...(nodeId === undefined ? {} : { nodeId }),
    objectId,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readStringField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** Build the stable entity key used in `stableId` and adoption native ids. */
export function buildMqttHaEntityKey(input: {
  readonly uniqueId: string | null
  readonly component: string
  readonly nodeId?: string
  readonly objectId: string
}): string {
  if (input.uniqueId !== null) return input.uniqueId
  if (input.nodeId !== undefined) return `${input.component}/${input.nodeId}/${input.objectId}`
  return `${input.component}/${input.objectId}`
}

/** CamStack stable id: `mqtt:{brokerId}:entity:{entityKey}`. */
export function buildMqttHaStableId(brokerId: string, entityKey: string): string {
  return `mqtt:${brokerId}:entity:${entityKey}`
}

/** Stable id of a device adopted as a group (`deviceKey` = `device:<identifier>`). */
export function buildMqttHaDeviceStableId(brokerId: string, deviceKey: string): string {
  return `mqtt:${brokerId}:${deviceKey}`
}

export interface ParseDiscoveryPayloadInput {
  readonly brokerId: string
  readonly component: string
  readonly nodeId?: string
  readonly objectId: string
  readonly payload: string
  readonly now?: number
}

/** A payload field that bridges write as a JSON boolean or number (`payload_on: false`). */
function readPayloadField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function readNumberField(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readStringList(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key]
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function readAvailability(raw: Record<string, unknown>): MqttHaAvailability[] {
  const topLevelOn = readPayloadField(raw, 'payload_available') ?? 'online'
  const topLevelOff = readPayloadField(raw, 'payload_not_available') ?? 'offline'
  const list = raw['availability']
  const out: MqttHaAvailability[] = []
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!isRecord(item)) continue
      const topic = readStringField(item, 'topic')
      if (topic === null) continue
      out.push({
        topic,
        payloadAvailable: readPayloadField(item, 'payload_available') ?? topLevelOn,
        payloadNotAvailable: readPayloadField(item, 'payload_not_available') ?? topLevelOff,
        valueTemplate: readStringField(item, 'value_template'),
      })
    }
    return out
  }
  const single = readStringField(raw, 'availability_topic')
  if (single !== null) {
    out.push({
      topic: single,
      payloadAvailable: topLevelOn,
      payloadNotAvailable: topLevelOff,
      valueTemplate: readStringField(raw, 'availability_template'),
    })
  }
  return out
}

function readDevice(raw: Record<string, unknown>): MqttHaDeviceInfo | null {
  const block = raw['device']
  if (!isRecord(block)) return null
  const identifiers = block['identifiers']
  const id =
    typeof identifiers === 'string'
      ? identifiers
      : Array.isArray(identifiers)
        ? identifiers.find((v): v is string => typeof v === 'string' && v.length > 0)
        : undefined
  if (id === undefined || id.length === 0) return null
  return {
    id,
    name: readStringField(block, 'name'),
    manufacturer: readStringField(block, 'manufacturer'),
    model: readStringField(block, 'model'),
  }
}

function readOrigin(raw: Record<string, unknown>): string | null {
  const block = raw['origin']
  return isRecord(block) ? readStringField(block, 'name') : null
}

function readLight(raw: Record<string, unknown>): MqttHaLightSpec {
  return {
    json: raw['schema'] === 'json',
    brightness: raw['brightness'] === true,
    brightnessScale: readNumberField(raw, 'brightness_scale') ?? 255,
    supportedColorModes: readStringList(raw, 'supported_color_modes'),
  }
}

function readTopicRead(
  raw: Record<string, unknown>,
  topicKey: string,
  templateKey: string,
): MqttHaTopicRead | null {
  const topic = readStringField(raw, topicKey)
  return topic === null ? null : { topic, template: readStringField(raw, templateKey) }
}

const DEFAULT_CLIMATE_MODES: readonly string[] = ['auto', 'off', 'cool', 'heat', 'dry', 'fan_only']

function readClimate(raw: Record<string, unknown>): MqttHaClimateSpec {
  const modes = readStringList(raw, 'modes')
  return {
    currentTemperature: readTopicRead(
      raw,
      'current_temperature_topic',
      'current_temperature_template',
    ),
    targetTemperature: readTopicRead(raw, 'temperature_state_topic', 'temperature_state_template'),
    mode: readTopicRead(raw, 'mode_state_topic', 'mode_state_template'),
    temperatureCommandTopic: readStringField(raw, 'temperature_command_topic'),
    modeCommandTopic: readStringField(raw, 'mode_command_topic'),
    modes: modes.length > 0 ? modes : [...DEFAULT_CLIMATE_MODES],
    minTemp: readNumberField(raw, 'min_temp'),
    maxTemp: readNumberField(raw, 'max_temp'),
    tempStep: readNumberField(raw, 'temp_step'),
  }
}

/** The primary topic of an entity; a climate entity may only declare per-field topics. */
function readStateTopic(
  component: MqttHaComponent,
  raw: Record<string, unknown>,
  climate: MqttHaClimateSpec | null,
): string | null {
  const declared = readStringField(raw, 'state_topic')
  if (declared !== null) return declared
  if (component !== 'climate' || climate === null) return null
  return (
    climate.currentTemperature?.topic ??
    climate.mode?.topic ??
    climate.targetTemperature?.topic ??
    null
  )
}

function readEntityCategory(raw: Record<string, unknown>): 'diagnostic' | 'config' | null {
  const value = readStringField(raw, 'entity_category')
  return value === 'diagnostic' || value === 'config' ? value : null
}

function readAvailabilityMode(raw: Record<string, unknown>): 'all' | 'any' | 'latest' {
  const value = readStringField(raw, 'availability_mode')
  return value === 'all' || value === 'any' ? value : 'latest'
}

/**
 * A device trigger read as the `event` entity of its device, carrying the one
 * event it announces: the trigger's topic is the state topic and its payload
 * is the event. Null when it is not a trigger or names no topic, device or
 * payload.
 */
function parseDeviceTrigger(
  input: ParseDiscoveryPayloadInput,
  raw: Record<string, unknown>,
): MqttHaDiscoveredEntity | null {
  if (raw['automation_type'] !== 'trigger') return null
  const topic = readStringField(raw, 'topic')
  const device = readDevice(raw)
  const eventType = readPayloadField(raw, 'payload') ?? readStringField(raw, 'subtype')
  if (topic === null || device === null || eventType === null) return null
  const triggerType = readStringField(raw, 'type') ?? 'action'
  return {
    brokerId: input.brokerId,
    entityKey: triggerEntityKey(device.id, triggerType),
    component: 'event',
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    objectId: triggerType,
    name: device.name ?? triggerType,
    stateTopic: topic,
    commandTopic: null,
    unitOfMeasurement: null,
    deviceClass: null,
    entityCategory: null,
    valueTemplate: readStringField(raw, 'value_template'),
    payloadOn: 'ON',
    payloadOff: 'OFF',
    stateOn: null,
    stateOff: null,
    uniqueId: null,
    availability: [],
    availabilityMode: 'latest',
    device,
    origin: readOrigin(raw),
    light: null,
    eventTypes: [eventType],
    climate: null,
    discoveredAt: input.now ?? Date.now(),
  }
}

/**
 * Parse a discovery config JSON payload into a normalised entity record.
 * Empty payload means "remove this discovery entry". A component this addon
 * has no mapping for, or a payload missing what the component needs, is `null`.
 */
export function parseDiscoveryConfigPayload(
  input: ParseDiscoveryPayloadInput,
): MqttHaDiscoveredEntity | null | 'remove' {
  const trimmed = input.payload.trim()
  if (trimmed.length === 0) return 'remove'

  const component = input.component
  const isTrigger = component === MQTT_HA_TRIGGER_COMPONENT
  if (!isTrigger && !isSupportedMqttHaComponent(component)) return null

  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isRecord(parsed)) return null
    raw = parsed
  } catch {
    return null
  }
  if (!isSupportedMqttHaComponent(component)) return parseDeviceTrigger(input, raw)

  const climate = component === 'climate' ? readClimate(raw) : null
  const stateTopic = readStateTopic(component, raw, climate)
  const commandTopic = readStringField(raw, 'command_topic')
  if (stateTopic === null && !COMMAND_ONLY_COMPONENTS.has(component)) return null
  if (COMMAND_ONLY_COMPONENTS.has(component) && commandTopic === null) return null
  if ((component === 'switch' || component === 'light') && commandTopic === null) return null

  const device = readDevice(raw)
  const uniqueId = readStringField(raw, 'unique_id')
  const name =
    readStringField(raw, 'name') ??
    device?.name ??
    readStringField(raw, 'object_id') ??
    input.objectId

  return {
    brokerId: input.brokerId,
    entityKey: buildMqttHaEntityKey({
      uniqueId,
      component,
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      objectId: input.objectId,
    }),
    component,
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    objectId: input.objectId,
    name,
    stateTopic,
    commandTopic,
    unitOfMeasurement: readStringField(raw, 'unit_of_measurement'),
    deviceClass: readStringField(raw, 'device_class'),
    entityCategory: readEntityCategory(raw),
    valueTemplate: readStringField(raw, 'value_template'),
    payloadOn: readPayloadField(raw, 'payload_on') ?? 'ON',
    payloadOff: readPayloadField(raw, 'payload_off') ?? 'OFF',
    stateOn: readPayloadField(raw, 'state_on'),
    stateOff: readPayloadField(raw, 'state_off'),
    uniqueId,
    availability: readAvailability(raw),
    availabilityMode: readAvailabilityMode(raw),
    device,
    origin: readOrigin(raw),
    light: component === 'light' ? readLight(raw) : null,
    eventTypes: component === 'event' ? readStringList(raw, 'event_types') : [],
    climate,
    discoveredAt: input.now ?? Date.now(),
  }
}
