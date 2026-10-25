/**
 * The display gate — "should this slot show its value right now?".
 *
 * It reuses the notification centre's `NcConditions` vocabulary rather
 * than a parallel model, but it cannot answer all of it: the facts here
 * are DEVICE STATE, not a persisted detection record. There is no class,
 * no zone, no confidence, no track to reason about.
 *
 * So the supported set is enumerated, and the WRITE path rejects anything
 * outside it (`assertSupportedConditions`). The rejected alternative was
 * to accept every key and fail closed on the ones we cannot evaluate,
 * which is how NC behaves — correct there, wrong here. NC failing closed
 * sends no notification, which is invisible. This failing closed renders a
 * permanently blank overlay, and a blank overlay is indistinguishable from
 * a broken camera. Refuse loudly at write time instead.
 *
 * Pure: no I/O, no clock. State comes in as a lookup function.
 */
import { isScheduleActive, type NcConditions, type NcSchedule } from '@camstack/types'

/**
 * Condition ids from `NC_CONDITION_CATALOG` this gate can evaluate.
 * Widening it means giving `evaluateGate` the facts to answer it — a
 * live detection subject would unlock `classes`, `zones`, `minConfidence`.
 */
export const OSD_SUPPORTED_CONDITIONS: readonly string[] = ['deviceState']
const OSD_RUNTIME_CONDITIONS: readonly string[] = ['devices', ...OSD_SUPPORTED_CONDITIONS]

/** Current value of a device's `device-status` style state, or undefined when unreadable. */
export type OsdDeviceStateLookup = (deviceId: number) => string | undefined

export interface OsdGateInput {
  /** The camera whose slot is being rendered. */
  readonly cameraDeviceId: number
  readonly atMs: number
  readonly schedule?: NcSchedule
  readonly conditions?: NcConditions
  readonly deviceState: OsdDeviceStateLookup
}

export interface OsdGateResult {
  readonly open: boolean
  /** Catalog id of the condition that closed the gate. Never silent. */
  readonly failedCondition?: string
}

const OPEN: OsdGateResult = { open: true }

/**
 * Which condition keys are set on `conditions` but outside the supported
 * set. Returned rather than thrown so the caller decides the error shape.
 */
export function unsupportedConditionKeys(conditions: NcConditions | undefined): readonly string[] {
  if (conditions === undefined) return []
  // `devices` was exposed by the first UI, but is redundant for a binding
  // already scoped to one camera. Continue accepting old stored bindings while
  // no longer advertising or creating that condition.
  const supported = new Set(OSD_RUNTIME_CONDITIONS)
  const present: string[] = []
  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (!supported.has(key)) present.push(key)
  }
  return present
}

/** Throw a listing error when a binding names a condition this gate cannot answer. */
export function assertSupportedConditions(conditions: NcConditions | undefined): void {
  const unsupported = unsupportedConditionKeys(conditions)
  if (unsupported.length === 0) return
  throw new Error(
    `osd-manager: condition(s) not evaluable by an overlay gate: ${unsupported.join(', ')}. ` +
      `Supported: ${OSD_SUPPORTED_CONDITIONS.join(', ')}.`,
  )
}

/**
 * Evaluate the gate. Short-circuits on the first failing group and names
 * it, mirroring `evaluateRule`'s `failedCondition` contract so the same
 * editor can explain both.
 */
export function evaluateGate(input: OsdGateInput): OsdGateResult {
  if (!isScheduleActive(input.schedule, input.atMs)) {
    return { open: false, failedCondition: 'schedule' }
  }

  const conditions = input.conditions
  if (conditions === undefined) return OPEN

  const devices = conditions.devices
  if (devices !== undefined && devices.length > 0 && !devices.includes(input.cameraDeviceId)) {
    return { open: false, failedCondition: 'devices' }
  }

  const deviceState = conditions.deviceState
  if (deviceState !== undefined) {
    // Fail-closed on an unreadable device, exactly as NC does: a state we
    // cannot read is not a state that matches.
    const current = input.deviceState(deviceState.deviceId)
    if (current === undefined || !deviceState.states.includes(current)) {
      return { open: false, failedCondition: 'deviceState' }
    }
  }

  return OPEN
}
