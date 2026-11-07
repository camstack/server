/**
 * Switch on = device on (D933, amended): a device with an ACTUATOR switch - its
 * own `switch`, the one that turns its function on - runs while that switch is on.
 * A SUPPLY switch (`power-source.switchOn`, an appliance on a plug) is never a
 * running source: the appliance keeps its power while it is idle.
 *
 * The default is derived from STRUCTURE (an actuator switch is present and no
 * supply relation is), computed at plan time and never written into the stored
 * composition: a stored composition is never rewritten silently, and an
 * authored `running` field always wins. The operator turns the default on and
 * off in the Customize running row ("Follow the device's switch").
 */
import { RUNNING_CUSTOMIZE_DEVICE_TYPES } from '../capabilities/running-state.cap.js'
import {
  type Composition,
  type CompositionFieldRead,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  composedDeviceRef,
  compositionFeatureEnabled,
} from './composition.js'
import { compileScalarOverride } from './customize/scalar-compile.js'

const RUNNING_CAP = 'running-state'
const SWITCH_CAP = 'switch'
const ON_FIELD = 'on'
const CHANGED_AT_FIELD = 'lastChangedAt'

function fieldsFeatureOf(composition: Composition, cap: string): CompositionFieldsFeature | null {
  const feature = composition.features.find((f) => f.cap === cap)
  return feature !== undefined && feature.kind === 'fields' ? feature : null
}

/** The device switch the composed `switch.on` reads, when it is one plain `from` of a switch. */
export function actuatorSwitchRead(composition: Composition): CompositionFieldRead | null {
  const feature = fieldsFeatureOf(composition, SWITCH_CAP)
  if (feature === null || !compositionFeatureEnabled(feature)) return null
  const field = feature.fields[ON_FIELD]
  if (field === undefined || field.kind !== 'from' || field.cap !== SWITCH_CAP) return null
  return { source: field.source, cap: field.cap, fieldPath: field.fieldPath }
}

function hasSupplyRelation(composition: Composition): boolean {
  const feature = fieldsFeatureOf(composition, 'power-source')
  return (
    feature !== null &&
    compositionFeatureEnabled(feature) &&
    feature.fields['switchOn'] !== undefined
  )
}

/**
 * "Do not follow the switch": a DISABLED `running-state` feature with no field.
 * It is the operator's stored word that this device has no derived running rule
 * (until another source is picked, which replaces it whole).
 */
export function runningOptOutFeature(): CompositionFieldsFeature {
  return { kind: 'fields', cap: RUNNING_CAP, enabled: false, fields: {} }
}

export function isRunningOptOut(feature: CompositionFieldsFeature | null): boolean {
  return (
    feature !== null &&
    feature.cap === RUNNING_CAP &&
    feature.enabled === false &&
    Object.keys(feature.fields).length === 0
  )
}

/** Anything stored for running - a rule, or the opt-out - is the operator's, and the default stays out of it. */
function hasAuthoredRunning(composition: Composition): boolean {
  return fieldsFeatureOf(composition, RUNNING_CAP) !== null
}

/** A NEW device of a type that offers "running", with an actuator switch and no supply relation. */
export function actuatorSwitchDrivesRunning(composition: Composition): boolean {
  const target = composition.target
  if (target.kind !== 'new') return false
  if (!RUNNING_CUSTOMIZE_DEVICE_TYPES.some((type) => type === target.type)) return false
  return actuatorSwitchRead(composition) !== null && !hasSupplyRelation(composition)
}

/** The `running-state` feature that reads the actuator switch: the one the scalar compiler stores. */
export function followSwitchRunningFeature(
  composition: Composition,
  host: CompositionSourceRef,
): CompositionFieldsFeature | null {
  const read = actuatorSwitchRead(composition)
  if (read === null) return null
  const compiled = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: RUNNING_CAP,
      targetId: 'running',
      source: { ...read.source, cap: read.cap, fieldPath: read.fieldPath },
      transform: { kind: 'identity' },
    },
    device: host,
    apply: 'add',
    sourceValueKind: 'boolean',
    changedAtField: CHANGED_AT_FIELD,
    sourceUnit: null,
  })
  return compiled.ok ? compiled.value : null
}

/**
 * The composition the composer PLANS: the stored one, plus the derived running
 * field when nothing is authored for it. The input is never changed; with nothing
 * to add it is returned as it is.
 */
export function withDefaultRunning(composition: Composition, blockId: string): Composition {
  if (hasAuthoredRunning(composition) || !actuatorSwitchDrivesRunning(composition)) {
    return composition
  }
  const feature = followSwitchRunningFeature(composition, composedDeviceRef(blockId))
  return feature === null
    ? composition
    : { ...composition, features: [...composition.features, feature] }
}

/** Does the `running` of this composition follow the actuator switch (stored link, or the derived default)? */
export function runningFollowsSwitch(composition: Composition): boolean {
  const feature = fieldsFeatureOf(composition, RUNNING_CAP)
  if (feature === null) return actuatorSwitchDrivesRunning(composition)
  const stored = feature.fields['running']
  if (stored === undefined) return false
  const read = actuatorSwitchRead(composition)
  return (
    read !== null &&
    stored.kind === 'from' &&
    stored.cap === read.cap &&
    stored.fieldPath === read.fieldPath &&
    stored.source.addonId === read.source.addonId &&
    stored.source.stableId === read.source.stableId
  )
}
