import type {
  MqttHaComponent,
  MqttHaDiscoveredEntity,
  ParsedDiscoveryTopic,
} from './mqtt-ha-discovery-types.js'

const DEFAULT_DISCOVERY_PREFIX = 'homeassistant'
const SUPPORTED_COMPONENTS: ReadonlySet<string> = new Set(['sensor', 'switch'])

export function isSupportedMqttHaComponent(value: string): value is MqttHaComponent {
  return value === 'sensor' || value === 'switch'
}

/**
 * Parse `homeassistant/{component}/{object_id}/config`.
 * Returns null when the topic is not a discovery config topic.
 */
export function parseDiscoveryConfigTopic(
  topic: string,
  discoveryPrefix: string = DEFAULT_DISCOVERY_PREFIX,
): ParsedDiscoveryTopic | null {
  const parts = topic.split('/').filter((p) => p.length > 0)
  if (parts.length !== 4) return null
  if (parts[0] !== discoveryPrefix) return null
  if (parts[3] !== 'config') return null
  const component = parts[1]
  const objectId = parts[2]
  if (component === undefined || objectId === undefined) return null
  return {
    discoveryPrefix: parts[0],
    component,
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
  readonly objectId: string
}): string {
  if (input.uniqueId !== null) return input.uniqueId
  return `${input.component}/${input.objectId}`
}

/** CamStack stable id: `mqtt:{brokerId}:entity:{entityKey}`. */
export function buildMqttHaStableId(brokerId: string, entityKey: string): string {
  return `mqtt:${brokerId}:entity:${entityKey}`
}

export interface ParseDiscoveryPayloadInput {
  readonly brokerId: string
  readonly component: string
  readonly objectId: string
  readonly payload: string
  readonly now?: number
}

/**
 * Parse a discovery config JSON payload into a normalised entity record.
 * Empty payload means "remove this discovery entry".
 */
export function parseDiscoveryConfigPayload(
  input: ParseDiscoveryPayloadInput,
): MqttHaDiscoveredEntity | null | 'remove' {
  const trimmed = input.payload.trim()
  if (trimmed.length === 0) return 'remove'

  if (!SUPPORTED_COMPONENTS.has(input.component)) return null
  if (!isSupportedMqttHaComponent(input.component)) return null

  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isRecord(parsed)) return null
    raw = parsed
  } catch {
    return null
  }

  const stateTopic = readStringField(raw, 'state_topic')
  if (stateTopic === null) return null

  const name = readStringField(raw, 'name') ?? readStringField(raw, 'object_id') ?? input.objectId

  const uniqueId = readStringField(raw, 'unique_id')
  const entityKey = buildMqttHaEntityKey({
    uniqueId,
    component: input.component,
    objectId: input.objectId,
  })

  const commandTopic = input.component === 'switch' ? readStringField(raw, 'command_topic') : null
  if (input.component === 'switch' && commandTopic === null) return null

  const unitOfMeasurement = readStringField(raw, 'unit_of_measurement')
  const payloadOn = readStringField(raw, 'payload_on') ?? 'ON'
  const payloadOff = readStringField(raw, 'payload_off') ?? 'OFF'

  return {
    brokerId: input.brokerId,
    entityKey,
    component: input.component,
    objectId: input.objectId,
    name,
    stateTopic,
    commandTopic,
    unitOfMeasurement,
    payloadOn,
    payloadOff,
    uniqueId,
    discoveredAt: input.now ?? Date.now(),
  }
}

/** Decode an MQTT state payload for a switch entity. */
export function decodeSwitchPayload(
  payload: string,
  entity: Pick<MqttHaDiscoveredEntity, 'payloadOn' | 'payloadOff'>,
): boolean | null {
  const trimmed = payload.trim()
  if (trimmed.length === 0) return null
  if (trimmed === entity.payloadOn) return true
  if (trimmed === entity.payloadOff) return false
  const lower = trimmed.toLowerCase()
  if (lower === 'on' || lower === 'true' || lower === '1') return true
  if (lower === 'off' || lower === 'false' || lower === '0') return false
  return null
}

/** Decode an MQTT state payload for a sensor entity (numeric v1). */
export function decodeSensorPayload(payload: string): number | null {
  const trimmed = payload.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}
