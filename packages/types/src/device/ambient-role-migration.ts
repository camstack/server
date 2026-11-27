import { DeviceRole } from './device-type.js'

/**
 * The one-time move of a multi-reading sensor to `ambient-monitor`.
 *
 * The meta row does not record WHO set a role, so the only proof that the provider
 * (not the operator) chose the current role is that it equals the role the provider
 * would have set under its previous rule (`replaces`). Any other role is kept. The
 * verdict is stored by the caller (`markReviewed`), so an operator who later picks the
 * old role again is not flipped back at the next start.
 */
export interface AmbientRoleInput {
  /** The role on the meta row; `null` = none. */
  readonly current: string | null
  /** The role the provider proposes now; `null` = it names none. */
  readonly wanted: DeviceRole | null
  /** The role the provider's previous rule gave this same device; `null` = none. */
  readonly replaces: string | null
  /** The verdict was already stored for this device. */
  readonly reviewed: boolean
}

export interface AmbientRoleVerdict {
  /** `set` = write `wanted`; `kept` = leave the role and say so; `skip` = nothing to do. */
  readonly action: 'set' | 'kept' | 'skip'
  /** The caller stores the verdict so it is not taken again. */
  readonly markReviewed: boolean
}

export function ambientRoleVerdict(input: AmbientRoleInput): AmbientRoleVerdict {
  const { current, wanted, replaces, reviewed } = input
  if (wanted === null || current === wanted) return { action: 'skip', markReviewed: false }
  if (current === null) return { action: 'set', markReviewed: false }
  if (wanted !== DeviceRole.AmbientMonitor || reviewed) {
    return { action: 'skip', markReviewed: false }
  }
  return { action: current === replaces ? 'set' : 'kept', markReviewed: true }
}

/** The role stored on a device's meta row; `null` and absence both read as "none". */
export function persistedRoleOf(meta: object): string | null {
  if (!('role' in meta)) return null
  const value: unknown = meta.role
  return typeof value === 'string' && value.length > 0 ? value : null
}
