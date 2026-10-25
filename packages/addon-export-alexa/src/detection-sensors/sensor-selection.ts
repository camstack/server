/**
 * Which detection classes a camera publishes as Alexa sensors (D778).
 *
 * Two inputs, two owners:
 *
 *  - WHAT MAY BE OFFERED is the camera's pipeline: `DetectionClassSource`
 *    (`pipelineAnalytics.listEventKinds`, the same answer the timeline lanes
 *    use). `package` is in it only on a camera with an enabled package zone or
 *    package detection, so a camera without package support never offers it.
 *  - WHAT IS PUBLISHED is the operator's per-camera selection, saved in this
 *    addon's per-device store (`<addonId>:addon-devices`, key
 *    {@link SENSOR_SELECTION_KEY}) through the device-settings aggregate.
 *
 * The published set is the intersection. A key never written means "never
 * saved" and publishes NOTHING — the default is empty, and that is also the
 * migration of every camera that published all four classes under D772: on its
 * next reconcile the build no longer contains the sensors and the sync engine
 * deletes them (`mayRetire`). A selected class the camera stops producing
 * drops out of the intersection the same way, after `DetectionClassSource`'s
 * confirmation window.
 */
import type { ConfigFieldWithValue } from '@camstack/types'
import { DETECTION_SENSOR_CLASSES, type DetectionSensorClass } from '../handlers/endpoint-id.js'

/** Per-device store key of the saved selection. */
export const SENSOR_SELECTION_KEY = 'alexaDetectionSensorClasses'

const LABELS: Readonly<Record<DetectionSensorClass, string>> = {
  person: 'Person',
  vehicle: 'Vehicle',
  animal: 'Animal',
  package: 'Package',
}

function isClass(value: unknown): value is DetectionSensorClass {
  return (
    typeof value === 'string' && (DETECTION_SENSOR_CLASSES as readonly string[]).includes(value)
  )
}

/** The saved selection in a per-device store blob; `null` = never saved. */
export function parseSensorSelection(
  store: Readonly<Record<string, unknown>>,
): readonly DetectionSensorClass[] | null {
  const raw = store[SENSOR_SELECTION_KEY]
  if (!Array.isArray(raw)) return null
  return DETECTION_SENSOR_CLASSES.filter((c) => raw.includes(c))
}

/** A patch value from the multiselect, cleaned to known classes. */
export function sensorSelectionFromPatch(value: unknown): readonly DetectionSensorClass[] {
  if (!Array.isArray(value)) return []
  const picked = new Set(value.filter(isClass))
  return DETECTION_SENSOR_CLASSES.filter((c) => picked.has(c))
}

/** The classes a camera publishes a sensor for: offered ∩ saved, in the
 *  canonical order. Never saved ⇒ none. */
export function effectiveSensorClasses(
  available: readonly DetectionSensorClass[],
  saved: readonly DetectionSensorClass[] | null,
): readonly DetectionSensorClass[] {
  if (saved === null) return []
  return DETECTION_SENSOR_CLASSES.filter((c) => available.includes(c) && saved.includes(c))
}

/** The device-settings field key — namespaced per exporter (see the addon). */
export function sensorSelectionKey(deviceId: number): string {
  return `alexa:${deviceId}:detectionSensorClasses`
}

export interface SensorSelectionFieldInput {
  readonly deviceId: number
  readonly available: readonly DetectionSensorClass[]
  readonly saved: readonly DetectionSensorClass[] | null
  readonly enabledKey: string
  /** The integration-level "Detection sensors" switch. */
  readonly masterOn: boolean
}

/** The camera's "Detection sensors in Alexa" field: a multiselect over the
 *  classes the camera produces, or an info line saying why there is none. */
export function sensorSelectionField(input: SensorSelectionFieldInput): ConfigFieldWithValue {
  const key = sensorSelectionKey(input.deviceId)
  const showWhen = { field: input.enabledKey, equals: true }
  if (!input.masterOn) {
    return {
      type: 'info',
      key: `${key}:off`,
      label: 'Detection sensors in Alexa',
      content:
        'Detection sensors are switched off for the whole Alexa integration (Alexa settings → Detection sensors).',
      variant: 'info',
      showWhen,
    }
  }
  if (input.available.length === 0) {
    return {
      type: 'info',
      key: `${key}:none`,
      label: 'Detection sensors in Alexa',
      content:
        "This camera's detection pipeline produces no person, vehicle, animal or package events, so there is nothing to send to Alexa as a sensor.",
      variant: 'info',
      showWhen,
    }
  }
  return {
    type: 'multiselect',
    key,
    label: 'Detection sensors in Alexa',
    description:
      'Each class picked here becomes an Alexa motion sensor named "<camera> <class>", usable as a routine trigger. Only the classes this camera\'s pipeline detects are offered (Package needs a package zone). Removing a class deletes its sensor, and the routines built on it, from Alexa.',
    options: input.available.map((c) => ({ value: c, label: LABELS[c] })),
    value: input.available.filter((c) => (input.saved ?? []).includes(c)),
    showWhen,
    immediate: true,
  }
}
