/**
 * Amazon's discovery rules, encoded (D769).
 *
 * Alexa does not reject a bad capability — it rejects the WHOLE endpoint, and
 * sometimes every endpoint of the report: a ModeController with one mode, or
 * two identical preset names, made a camera and all its children disappear
 * ("Invalid capability received"), and nothing on our side said why. Every
 * rule below is one Amazon states (developer.amazon.com, device-apis:
 * alexa-discovery, alexa-discovery-objects, list-of-interfaces, the interface
 * pages) or one this addon paid for. The validator runs in the specs over every
 * shape the builders can emit, and at runtime before any endpoint leaves the
 * hub, so an invalid one is withheld and logged rather than sent.
 */
import type { AlexaCapability, AlexaEndpoint } from './types.js'
import { validateInstanced } from './validate-instanced.js'
import { validateThermostat } from './validate-thermostat.js'

/**
 * Interfaces this skill may declare, with the version Amazon documents. An
 * interface missing here is either not in Amazon's list (`BatteryLevelSensor`
 * never was) or deprecated (`MediaMetadata`, `EventDetectionSensor`).
 */
export const ALLOWED_INTERFACE_VERSIONS: Readonly<Record<string, string>> = {
  Alexa: '3',
  'Alexa.CameraStreamController': '3',
  'Alexa.RTCSessionController': '3',
  'Alexa.DoorbellEventSource': '3',
  'Alexa.MotionSensor': '3',
  'Alexa.ContactSensor': '3',
  'Alexa.TemperatureSensor': '3',
  'Alexa.HumiditySensor': '3',
  'Alexa.EndpointHealth': '3.1',
  'Alexa.PowerController': '3',
  'Alexa.BrightnessController': '3',
  'Alexa.ModeController': '3',
  'Alexa.ToggleController': '3',
  'Alexa.RangeController': '3',
  'Alexa.SecurityPanelController': '3',
  'Alexa.LockController': '3',
  'Alexa.ThermostatController': '3.1',
  'Alexa.SmartVision.SnapshotProvider': '1.1',
  'Alexa.SmartVision.ObjectDetectionSensor': '1.0',
  'Alexa.DataController': '1.0',
  'Alexa.SceneController': '3',
}

/** `imageNetClass` values Amazon accepts (alexa-smartvision-objectdetectionsensor). */
const SMART_VISION_CLASSES = new Set(['person', 'package'])

/** `supportedAccess` values Amazon documents (alexa-datacontroller). */
const DATA_CONTROLLER_ACCESS = new Set(['BY_IDENTIFIER', 'BY_TIMESTAMP_RANGE'])

/** Interfaces that need an `instance`. */
const INSTANCED = new Set([
  'Alexa.ModeController',
  'Alexa.ToggleController',
  'Alexa.RangeController',
])

/** Sensor interfaces Amazon requires to be paired with `Alexa.EndpointHealth`. */
const NEEDS_ENDPOINT_HEALTH = new Set([
  'Alexa.MotionSensor',
  'Alexa.ContactSensor',
  'Alexa.TemperatureSensor',
  'Alexa.HumiditySensor',
  'Alexa.LockController',
  'Alexa.SmartVision.ObjectDetectionSensor',
])

/** `displayCategories` values from alexa-discovery (the subset a camstack
 *  device can be). */
const DISPLAY_CATEGORIES = new Set([
  'CAMERA',
  'DOORBELL',
  'LIGHT',
  'SWITCH',
  'SMARTPLUG',
  'SECURITY_PANEL',
  'SECURITY_SYSTEM',
  'MOTION_SENSOR',
  'CONTACT_SENSOR',
  'TEMPERATURE_SENSOR',
  'SMARTLOCK',
  'INTERIOR_BLIND',
  'EXTERIOR_BLIND',
  'THERMOSTAT',
  'AIR_CONDITIONER',
  'DOOR',
  'GATE',
  'GARAGE_DOOR',
  'SCENE_TRIGGER',
  'OTHER',
])

const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9 _\-=#;:?@&]{1,256}$/
const MAX_FRIENDLY_NAME = 256
const MAX_DESCRIPTION = 128
const MAX_MANUFACTURER = 128
const MAX_COOKIE_BYTES = 5000
const MAX_CAPABILITIES = 100
const MIN_MODES = 2

export interface EndpointViolation {
  readonly endpointId: string
  readonly rule: string
}

function capabilityKey(c: AlexaCapability): string {
  return c.instance === undefined ? c.interface : `${c.interface}#${c.instance}`
}

function friendlyTexts(c: AlexaCapability): readonly string[] {
  return (c.capabilityResources?.friendlyNames ?? []).map((n) =>
    n['@type'] === 'text' ? n.value.text : n.value.assetId,
  )
}

function field(c: AlexaCapability, key: string): unknown {
  return c.configuration?.[key]
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** ObjectDetectionSensor (D779): a non-empty, duplicate-free list of the two
 *  classes Amazon knows, and no reportable properties (it defines none). */
function validateObjectDetection(c: AlexaCapability, push: (rule: string) => void): void {
  const list = field(c, 'objectDetectionConfiguration')
  if (!Array.isArray(list) || list.length === 0) {
    push('configuration.objectDetectionConfiguration must list at least one class')
    return
  }
  const classes = list.map((entry) => objectField(entry, 'imageNetClass'))
  for (const cls of classes) {
    if (typeof cls !== 'string' || !SMART_VISION_CLASSES.has(cls)) {
      push(`imageNetClass ${String(cls)} is not person or package`)
    }
  }
  if (new Set(classes).size !== classes.length) push('imageNetClass listed twice')
  if (c.properties !== undefined) push('declares properties; the interface defines none')
}

/** DataController (D779): an instance, a schema, a documented access mode, and
 *  a target capability the SAME endpoint declares. */
function validateDataController(
  c: AlexaCapability,
  declared: ReadonlySet<string>,
  push: (rule: string) => void,
): void {
  if (c.instance === undefined || c.instance.length === 0) push('instance is required')
  const schema = field(c, 'dataRetrievalSchema')
  if (
    typeof objectField(schema, 'type') !== 'string' ||
    typeof objectField(schema, 'schema') !== 'string'
  ) {
    push('configuration.dataRetrievalSchema {type, schema} is required')
  }
  const target = objectField(field(c, 'targetCapability'), 'name')
  if (typeof target !== 'string' || !declared.has(target)) {
    push('configuration.targetCapability must name an interface this endpoint declares')
  }
  const access = field(c, 'supportedAccess')
  if (
    !Array.isArray(access) ||
    access.length === 0 ||
    access.some((a) => typeof a !== 'string' || !DATA_CONTROLLER_ACCESS.has(a))
  ) {
    push('configuration.supportedAccess must list BY_IDENTIFIER and/or BY_TIMESTAMP_RANGE')
  }
}

function validateCapability(
  endpointId: string,
  c: AlexaCapability,
  out: EndpointViolation[],
  declared: ReadonlySet<string>,
): void {
  const push = (rule: string): void => {
    out.push({ endpointId, rule: `${capabilityKey(c)}: ${rule}` })
  }
  if (c.type !== 'AlexaInterface') push('type must be AlexaInterface')
  const version = ALLOWED_INTERFACE_VERSIONS[c.interface]
  if (version === undefined) {
    push("interface is not in Amazon's interface list (or is deprecated)")
    return
  }
  if (c.version !== version) push(`version must be ${version}`)
  if (INSTANCED.has(c.interface)) {
    if (c.instance === undefined || c.instance.length === 0) push('instance is required')
    if (friendlyTexts(c).length === 0) push('capabilityResources.friendlyNames is required')
  }
  if (c.properties !== undefined) {
    if (c.properties.supported.length === 0) push('properties.supported must not be empty')
  }
  if (c.interface === 'Alexa.ModeController') {
    const modes = c.configuration?.['supportedModes']
    if (!Array.isArray(modes) || modes.length < MIN_MODES) {
      push(`at least ${MIN_MODES} supportedModes`)
    } else {
      const values = modes.map((m) =>
        typeof m === 'object' && m !== null ? String(Reflect.get(m, 'value')) : '',
      )
      if (new Set(values).size !== values.length) push('supportedModes values must be unique')
    }
  }
  validateInstanced(c, push)
  if (c.interface === 'Alexa.ThermostatController') validateThermostat(c, push)
  if (c.interface === 'Alexa.SmartVision.ObjectDetectionSensor') validateObjectDetection(c, push)
  if (c.interface === 'Alexa.DataController') validateDataController(c, declared, push)
  if (c.interface === 'Alexa.SmartVision.SnapshotProvider') {
    if (typeof c.configuration?.['isAvailable'] !== 'boolean') {
      push('configuration.isAvailable is required')
    }
  }
}

/** Every rule an endpoint breaks. Empty = Amazon should accept it. */
export function validateAlexaEndpoint(endpoint: AlexaEndpoint): readonly EndpointViolation[] {
  const out: EndpointViolation[] = []
  const id = endpoint.endpointId
  const push = (rule: string): void => {
    out.push({ endpointId: id, rule })
  }
  if (!ENDPOINT_ID_PATTERN.test(id)) push('endpointId: 1-256 of [A-Za-z0-9 _-=#;:?@&]')
  if (endpoint.friendlyName.trim().length === 0) push('friendlyName must not be empty')
  if (endpoint.friendlyName.length > MAX_FRIENDLY_NAME) push('friendlyName longer than 256')
  if (endpoint.description.length === 0 || endpoint.description.length > MAX_DESCRIPTION) {
    push('description must be 1-128 characters')
  }
  if (
    endpoint.manufacturerName.length === 0 ||
    endpoint.manufacturerName.length > MAX_MANUFACTURER
  ) {
    push('manufacturerName must be 1-128 characters')
  }
  if (endpoint.displayCategories.length === 0) push('displayCategories must not be empty')
  for (const cat of endpoint.displayCategories) {
    if (!DISPLAY_CATEGORIES.has(cat)) push(`displayCategory ${cat} is not an Amazon value`)
  }
  if (endpoint.cookie !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(endpoint.cookie)).length
    if (bytes > MAX_COOKIE_BYTES) push('cookie larger than 5000 bytes')
  }
  const caps = endpoint.capabilities
  if (caps.length > MAX_CAPABILITIES) push('more than 100 capabilities')
  if (!caps.some((c) => c.interface === 'Alexa' && c.version === '3')) {
    push('the base Alexa interface (version 3) is required')
  }
  const keys = caps.map(capabilityKey)
  if (new Set(keys).size !== keys.length)
    push('a capability (interface + instance) is declared twice')
  const interfaces = new Set(caps.map((c) => c.interface))
  for (const needs of NEEDS_ENDPOINT_HEALTH) {
    if (interfaces.has(needs) && !interfaces.has('Alexa.EndpointHealth')) {
      push(`${needs} requires Alexa.EndpointHealth`)
    }
  }
  if (interfaces.has('Alexa.RTCSessionController') && endpoint.displayCategories[0] !== 'CAMERA') {
    push('an RTCSessionController endpoint must list CAMERA first')
  }
  for (const c of caps) validateCapability(id, c, out, interfaces)
  return out
}

/** Split endpoints into the valid ones and the violations of the rest. */
export function partitionValidEndpoints(endpoints: readonly AlexaEndpoint[]): {
  readonly valid: readonly AlexaEndpoint[]
  readonly violations: readonly EndpointViolation[]
} {
  const valid: AlexaEndpoint[] = []
  const violations: EndpointViolation[] = []
  for (const e of endpoints) {
    const found = validateAlexaEndpoint(e)
    if (found.length === 0) valid.push(e)
    else violations.push(...found)
  }
  return { valid, violations }
}

/**
 * The runtime gate: keep the valid endpoints, and say out loud which ones were
 * withheld and why. Sending an invalid one risks Alexa rejecting the report —
 * and with it every valid endpoint beside it.
 */
export function withholdInvalidEndpoints(
  endpoints: readonly AlexaEndpoint[],
  warn: (message: string, violations: readonly EndpointViolation[]) => void,
): readonly AlexaEndpoint[] {
  const { valid, violations } = partitionValidEndpoints(endpoints)
  if (violations.length > 0) {
    warn(
      'alexa: endpoints WITHHELD — they break an Amazon discovery rule and could make Alexa reject the whole report',
      violations,
    )
  }
  return valid
}
