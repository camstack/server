/**
 * Which smart switch powers a device (the `power-source` Customize extension):
 * the source its stored `power-source.switchOn` field reads, and the off time of
 * a forced restart stored beside it. Read from the STORED composition, never kept
 * as a second copy (D676). Shared by the hub (which acts on the switch) and the
 * admin UI (which shows it).
 */
import {
  POWER_SOURCE_OFF_SECONDS_DEFAULT,
  POWER_SOURCE_OFF_SECONDS_MAX,
  POWER_SOURCE_OFF_SECONDS_MIN,
} from '../capabilities/power-source.cap.js'
import {
  composedDeviceRef,
  compositionFeatureEnabled,
  compositionSourceKey,
  featureSources,
  fieldReads,
  type Composition,
} from './composition.js'
import type { CompositionSourceRef } from './source-ref.js'
import { featureForwards } from './validate-forward.js'

export interface PowerSourceLink {
  /** The device the customization is on. */
  readonly device: CompositionSourceRef
  /** The smart switch that powers it. */
  readonly switch: CompositionSourceRef
  /** How long a forced restart keeps the switch off: an integer within the cap's bounds. */
  readonly offSeconds: number
}

/**
 * The stored off time, or the default when none is stored. A stored number out
 * of range is CLAMPED to the bounds (a hand-written value never refuses the
 * link, it just cannot cut power for an absurd time); a non-integer is rounded.
 */
export function normalizeOffSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return POWER_SOURCE_OFF_SECONDS_DEFAULT
  return Math.min(
    POWER_SOURCE_OFF_SECONDS_MAX,
    Math.max(POWER_SOURCE_OFF_SECONDS_MIN, Math.round(value)),
  )
}

/** The constant a stored `offSeconds` field carries, or undefined when it is not a literal number. */
function storedOffSeconds(composition: Composition): unknown {
  const feature = composition.features.find((f) => f.cap === 'power-source')
  if (feature === undefined || feature.kind !== 'fields') return undefined
  const field = feature.fields['offSeconds']
  if (field === undefined || field.kind !== 'expression') return undefined
  const n = Number(field.expr)
  return field.expr.trim() === '' || !Number.isFinite(n) ? undefined : n
}

/**
 * The link a composition stores. An `existing` target names its own device; a
 * `new` target (a composed device) is the composer's own device, so the caller
 * passes the block id and a new-target composition without one has no link.
 */
export function powerSourceLinkOfComposition(
  composition: Composition | null,
  blockId?: string,
): PowerSourceLink | null {
  if (composition === null) return null
  let device: CompositionSourceRef
  if (composition.target.kind === 'existing') device = composition.target.device
  else if (blockId !== undefined) device = composedDeviceRef(blockId)
  else return null
  const feature = composition.features.find((f) => f.cap === 'power-source')
  if (feature === undefined || feature.kind !== 'fields' || feature.enabled === false) return null
  const field = feature.fields['switchOn']
  if (field === undefined) return null
  const read = fieldReads(field).find((r) => r.cap === 'switch')
  if (read === undefined) return null
  return {
    device,
    switch: read.source,
    offSeconds: normalizeOffSeconds(storedOffSeconds(composition)),
  }
}

/** A power-source link that names one of the device's own actuators: the field, and the switch it names. */
export interface PowerSourceActuatorConflict {
  /** Where the link sits: `features[N].fields.switchOn`. */
  readonly path: string
  /** The switch that is both the supply and an actuator (or the device itself). */
  readonly switch: CompositionSourceRef
}

const ACTUATOR_CAP = 'switch'

/**
 * The devices that ACT for this composition: the device itself when it is an
 * existing one, and every source its own `switch` feature reads or forwards a
 * command to (a heater's plug, every member of a switch group).
 */
function actuatorKeys(composition: Composition): ReadonlySet<string> {
  const keys = new Set<string>()
  if (composition.target.kind === 'existing') {
    keys.add(compositionSourceKey(composition.target.device))
  }
  composition.features.forEach((feature, index) => {
    if (feature.kind !== 'fields' || feature.cap !== ACTUATOR_CAP) return
    if (!compositionFeatureEnabled(feature)) return
    for (const source of featureSources(feature)) {
      for (const read of fieldReads(source)) keys.add(compositionSourceKey(read.source))
    }
    for (const forward of featureForwards(feature, index)) {
      keys.add(compositionSourceKey(forward.command.source))
    }
  })
  return keys
}

/**
 * The supply plug is never one of the device's own actuators (#462): cutting
 * power through the switch that IS the device's on/off leaves nothing to
 * restart, and makes "power off" and "turn off" the same press. Refused at save
 * time (`power-source-is-actuator`) and again by the power-source provider for a
 * link stored before this check existed (`switch-is-actuator`).
 */
export function powerSourceActuatorConflicts(
  composition: Composition,
): readonly PowerSourceActuatorConflict[] {
  const index = composition.features.findIndex((f) => f.cap === 'power-source')
  const feature = composition.features[index]
  if (feature === undefined || feature.kind !== 'fields' || feature.enabled === false) return []
  const field = feature.fields['switchOn']
  if (field === undefined) return []
  const actuators = actuatorKeys(composition)
  return fieldReads(field)
    .filter((read) => read.cap === ACTUATOR_CAP && actuators.has(compositionSourceKey(read.source)))
    .map((read) => ({ path: `features[${index}].fields.switchOn`, switch: read.source }))
}
