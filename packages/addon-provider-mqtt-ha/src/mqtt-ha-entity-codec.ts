import type { MqttHaEntity, MqttHaTopicRead } from './mqtt-ha-discovery-types.js'
import { renderTemplate } from './mqtt-ha-template.js'

/** Reads the last payload seen on a topic; undefined when none has arrived. */
export type TopicPayloadReader = (topic: string) => string | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Every topic an entity needs to hear: its state, per-field climate topics, availability. */
export function entityTopics(entity: MqttHaEntity): readonly string[] {
  const topics = new Set<string>([entity.stateTopic])
  const climate = entity.climate
  if (climate !== null) {
    for (const read of [climate.currentTemperature, climate.targetTemperature, climate.mode]) {
      if (read !== null) topics.add(read.topic)
    }
  }
  for (const a of entity.availability) topics.add(a.topic)
  return [...topics]
}

export function decodeNumber(entity: MqttHaEntity, payload: string): number | null {
  const rendered = renderTemplate(entity.valueTemplate, payload)
  if (rendered === null || rendered.length === 0) return null
  const value = Number(rendered)
  return Number.isFinite(value) ? value : null
}

/** On/off of a switch, a binary sensor or a light-less boolean field. */
export function decodeBoolean(entity: MqttHaEntity, payload: string): boolean | null {
  const rendered = renderTemplate(entity.valueTemplate, payload)
  if (rendered === null || rendered.length === 0) return null
  const lower = rendered.toLowerCase()
  const on = (entity.stateOn ?? entity.payloadOn).toLowerCase()
  const off = (entity.stateOff ?? entity.payloadOff).toLowerCase()
  if (lower === on) return true
  if (lower === off) return false
  if (lower === 'on' || lower === 'true' || lower === '1') return true
  if (lower === 'off' || lower === 'false' || lower === '0') return false
  return null
}

export interface MqttHaLightReading {
  readonly on: boolean
  readonly brightnessPct: number | null
  readonly mireds: number | null
}

/** A JSON-schema light: `{state, brightness, color_temp}` on the state topic. */
export function decodeLight(entity: MqttHaEntity, payload: string): MqttHaLightReading | null {
  const json = parseJsonRecord(payload)
  if (json === null) return null
  const state = json['state']
  if (typeof state !== 'string') return null
  const scale = entity.light?.brightnessScale ?? 255
  const brightness = readNumber(json['brightness'])
  return {
    on: state.toUpperCase() === 'ON',
    brightnessPct: brightness === null ? null : Math.round((brightness / scale) * 100),
    mireds: readNumber(json['color_temp']),
  }
}

export interface MqttHaLightChange {
  readonly on?: boolean
  readonly brightnessPct?: number
  readonly mireds?: number
  readonly rgb?: { readonly r: number; readonly g: number; readonly b: number }
  readonly hsv?: { readonly h: number; readonly s: number }
}

/** The JSON command payload for one change; any change but an explicit off keeps the light on. */
export function lightCommandPayload(entity: MqttHaEntity, change: MqttHaLightChange): string {
  const scale = entity.light?.brightnessScale ?? 255
  const command: Record<string, unknown> = { state: change.on === false ? 'OFF' : 'ON' }
  if (change.brightnessPct !== undefined) {
    command['brightness'] = Math.round((change.brightnessPct / 100) * scale)
  }
  if (change.mireds !== undefined) command['color_temp'] = Math.round(change.mireds)
  if (change.rgb !== undefined) command['color'] = { ...change.rgb }
  if (change.hsv !== undefined) command['color'] = { ...change.hsv }
  return JSON.stringify(command)
}

export interface MqttHaEventReading {
  readonly eventType: string
}

function eventTypeOf(json: Record<string, unknown>): string | null {
  const value = json['event_type'] ?? json['action']
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The event a message carries. A template this subset cannot evaluate (a
 * statement-based one) falls back to the JSON payload's own `event_type` /
 * `action`, so a remote still fires.
 */
export function decodeEvent(entity: MqttHaEntity, payload: string): MqttHaEventReading | null {
  if (payload.trim().length === 0) return null
  const rendered = renderTemplate(entity.valueTemplate, payload)
  if (rendered !== null && rendered.length > 0) {
    const json = parseJsonRecord(rendered)
    if (json === null) return { eventType: rendered }
    const fromRendered = eventTypeOf(json)
    if (fromRendered !== null) return { eventType: fromRendered }
  }
  const raw = parseJsonRecord(payload)
  const fromRaw = raw === null ? null : eventTypeOf(raw)
  return fromRaw === null ? null : { eventType: fromRaw }
}

export interface MqttHaClimateReading {
  readonly currentTemp: number | null
  readonly target: number | null
  readonly mode: string | null
}

function readTopic(read: MqttHaTopicRead | null, reader: TopicPayloadReader): string | null {
  if (read === null) return null
  const payload = reader(read.topic)
  if (payload === undefined) return null
  const rendered = renderTemplate(read.template, payload)
  return rendered === null || rendered.length === 0 ? null : rendered
}

function toFinite(value: string | null): number | null {
  if (value === null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function decodeClimate(
  entity: MqttHaEntity,
  reader: TopicPayloadReader,
): MqttHaClimateReading {
  const climate = entity.climate
  return {
    currentTemp: toFinite(readTopic(climate?.currentTemperature ?? null, reader)),
    target: toFinite(readTopic(climate?.targetTemperature ?? null, reader)),
    mode: readTopic(climate?.mode ?? null, reader),
  }
}

function availabilityOf(
  item: MqttHaEntity['availability'][number],
  reader: TopicPayloadReader,
): boolean | null {
  const payload = reader(item.topic)
  if (payload === undefined) return null
  const value = renderTemplate(item.valueTemplate, payload)
  if (value === null) return null
  if (value === item.payloadAvailable) return true
  if (value === item.payloadNotAvailable) return false
  return null
}

/**
 * Whether the entity is reachable: `null` while no availability topic has
 * spoken (presumed reachable by the caller). `all` needs every topic online
 * and any offline wins; `any` and `latest` are online when one topic is.
 */
export function evaluateAvailability(
  entity: MqttHaEntity,
  reader: TopicPayloadReader,
): boolean | null {
  if (entity.availability.length === 0) return null
  const states = entity.availability.map((item) => availabilityOf(item, reader))
  if (entity.availabilityMode === 'all') {
    if (states.some((s) => s === false)) return false
    return states.every((s) => s === true) ? true : null
  }
  if (states.some((s) => s === true)) return true
  return states.every((s) => s === false) ? false : null
}
