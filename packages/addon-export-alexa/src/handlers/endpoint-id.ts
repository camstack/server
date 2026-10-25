/**
 * Decode the `endpointId` strings the Discovery handler emits.
 *
 * Format:
 *   - `${deviceId}`               — parent camera endpoint
 *   - `${parent}__${child}`       — child accessory (switch/light/siren)
 *   - `${parent}__autotrack`      — synthetic autotrack toggle
 *   - `${parent}__privacy`        — synthetic privacy-mask toggle
 *   - `${deviceId}__alarm`        — an alarm panel's own endpoint
 *   - `${deviceId}__dev`          — a non-camera device (R5): lock, sensor,
 *                                   switch, light
 *   - `${camera}__det_<class>`    — a camera's detection sensor (R1):
 *                                   person / vehicle / animal / package
 *
 * The `__alarm` tag is a ROUTING tag, not a parent/child relation: an alarm
 * panel is a standalone device, and the suffix is what lets the directive
 * router and `Alexa/ReportState` know they are looking at a security panel
 * without a device-manager round trip per poll.
 *
 * All numeric parts must parse as non-negative integers; anything else
 * yields a parse failure and the directive handler returns
 * `INVALID_DIRECTIVE`.
 */

export type ParsedEndpointId =
  | { kind: 'camera'; deviceId: number }
  | { kind: 'child'; parentDeviceId: number; childDeviceId: number }
  | { kind: 'autotrack'; parentDeviceId: number }
  | { kind: 'privacy'; parentDeviceId: number }
  | { kind: 'alarm-panel'; deviceId: number }
  | { kind: 'detection'; deviceId: number; detectionClass: DetectionSensorClass }
  | { kind: 'generic'; deviceId: number }
  | { kind: 'invalid'; reason: string }

/** The classes a camera publishes a detection sensor for (R1). */
export const DETECTION_SENSOR_CLASSES = ['person', 'vehicle', 'animal', 'package'] as const
export type DetectionSensorClass = (typeof DETECTION_SENSOR_CLASSES)[number]

const DETECTION_PREFIX = 'det_'

function isDetectionSensorClass(value: string): value is DetectionSensorClass {
  return (DETECTION_SENSOR_CLASSES as readonly string[]).includes(value)
}

/** The endpoint id of a camera's detection sensor for one class. */
export function detectionSensorEndpointId(deviceId: number, cls: DetectionSensorClass): string {
  return `${deviceId}${SEPARATOR}${DETECTION_PREFIX}${cls}`
}

const SEPARATOR = '__'

export function parseCameraEndpointId(raw: string): ParsedEndpointId {
  if (!raw.includes(SEPARATOR)) {
    const id = parseNonNegativeInt(raw)
    if (id === null) return { kind: 'invalid', reason: `not a numeric deviceId: ${raw}` }
    return { kind: 'camera', deviceId: id }
  }
  const [head, tail, ...rest] = raw.split(SEPARATOR)
  if (head === undefined || tail === undefined || rest.length > 0) {
    return { kind: 'invalid', reason: `unexpected segments in endpointId: ${raw}` }
  }
  const parent = parseNonNegativeInt(head)
  if (parent === null) {
    return { kind: 'invalid', reason: `parent segment not numeric: ${raw}` }
  }
  if (tail === 'autotrack') return { kind: 'autotrack', parentDeviceId: parent }
  if (tail === 'privacy') return { kind: 'privacy', parentDeviceId: parent }
  if (tail === 'alarm') return { kind: 'alarm-panel', deviceId: parent }
  if (tail === 'dev') return { kind: 'generic', deviceId: parent }
  if (tail.startsWith(DETECTION_PREFIX)) {
    const cls = tail.slice(DETECTION_PREFIX.length)
    if (isDetectionSensorClass(cls)) {
      return { kind: 'detection', deviceId: parent, detectionClass: cls }
    }
    return { kind: 'invalid', reason: `unknown detection class in endpointId: ${raw}` }
  }
  const child = parseNonNegativeInt(tail)
  if (child === null) {
    return {
      kind: 'invalid',
      reason: `child segment not numeric and not 'autotrack'/'privacy'/'alarm': ${raw}`,
    }
  }
  return { kind: 'child', parentDeviceId: parent, childDeviceId: child }
}

function parseNonNegativeInt(s: string): number | null {
  if (!/^\d+$/.test(s)) return null
  const n = Number.parseInt(s, 10)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}
