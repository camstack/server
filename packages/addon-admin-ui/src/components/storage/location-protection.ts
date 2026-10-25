/**
 * ONE protection policy per location, replacing two numbers whose relationship
 * nobody could state.
 *
 * The Edit modal used to offer "MIN FREE DISK %" and "MAX USED (GB)" side by
 * side and an operator reported, correctly, that it is not clear which one
 * wins. There is one knob now: how much space to KEEP FREE on the volume,
 * expressed either as a percentage of the volume or as an absolute number of
 * gigabytes. The oldest data stored at this location is deleted to keep that
 * much free; when the reserve cannot be held any more, writes stop rather than
 * filling the disk.
 *
 * Two config keys, exactly one of them set at a time:
 *  - `minFreePercent` — percent of the volume to keep free.
 *  - `minFreeGb`      — gigabytes of the volume to keep free.
 *
 * `maxUsedGb` stays in the data model as an internal mechanism but is no
 * longer an operator knob: {@link readLegacyMaxUsedGb} exists so the modal can
 * SHOW a stored one rather than silently dropping it on the next save.
 */

import i18n from '../../i18n/index'

/** How the reserve is expressed. */
export type ProtectionUnit = 'percent' | 'gb'

/** The default reserve when the operator leaves the field empty. */
export const DEFAULT_MIN_FREE_PERCENT = 10

const BYTES_PER_GB = 1024 ** 3

export interface ProtectionPolicy {
  readonly unit: ProtectionUnit
  /** `null` = leave it to the default; the unit is then only a UI preference. */
  readonly value: number | null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The policy a stored config expresses. `minFreeGb` wins when both keys are
 * present — a row can only get there by hand-editing, and the absolute figure
 * is the one an operator typed most recently in that case.
 */
export function readProtectionPolicy(config: Readonly<Record<string, unknown>>): ProtectionPolicy {
  const gb = readNumber(config['minFreeGb'])
  if (gb !== null) return { unit: 'gb', value: gb }
  const percent = readNumber(config['minFreePercent'])
  if (percent !== null) return { unit: 'percent', value: percent }
  return { unit: 'percent', value: null }
}

/**
 * The value stored FOR ONE UNIT, independent of which unit the config happens
 * to express.
 *
 * The unit an operator is editing in is a PENDING EDIT and cannot be derived
 * from the stored config: picking "GB" before typing anything clears both keys,
 * and a unit re-derived from the config then reads back as "percent" and the
 * selector snaps back. The unit lives in component state; only the value is
 * read from here.
 */
export function readProtectionValue(
  config: Readonly<Record<string, unknown>>,
  unit: ProtectionUnit,
): number | null {
  return readNumber(config[unit === 'gb' ? 'minFreeGb' : 'minFreePercent'])
}

/**
 * Write the policy into a config, CLEARING the other key. Both keys set at
 * once is the ambiguity this control exists to remove.
 */
export function writeProtectionPolicy(
  config: Readonly<Record<string, unknown>>,
  policy: ProtectionPolicy,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config }
  delete next['minFreePercent']
  delete next['minFreeGb']
  if (policy.value === null) return next
  if (policy.unit === 'gb') return { ...next, minFreeGb: policy.value }
  return { ...next, minFreePercent: policy.value }
}

/**
 * Parse what the operator typed. Empty (or unparseable) is `null` — the
 * default — never zero: an accidental clear must not turn protection off.
 */
export function parseProtectionValue(raw: string, unit: ProtectionUnit): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  if (unit === 'percent') return Math.min(100, Math.max(0, parsed))
  return Math.max(0, parsed)
}

/**
 * The reserve in BYTES, for the capacity bar's red band.
 *
 * `null` when the volume never answered `statfs` and the percentage has
 * nothing to be a percentage OF — an unknown capacity paints no band rather
 * than a band of zero.
 */
export function protectionReserveBytes(
  policy: ProtectionPolicy,
  totalBytes: number | null,
  defaultPercent: number = DEFAULT_MIN_FREE_PERCENT,
): number | null {
  if (policy.unit === 'gb' && policy.value !== null) return policy.value * BYTES_PER_GB
  const percent = policy.value ?? defaultPercent
  if (totalBytes === null || totalBytes <= 0) return null
  return (totalBytes * Math.min(100, Math.max(0, percent))) / 100
}

/** What the operator is asked to type, per unit. */
export function protectionUnitLabel(unit: ProtectionUnit): string {
  return unit === 'gb'
    ? i18n.t('helpers.locationProtection.unitGb')
    : i18n.t('helpers.locationProtection.unitPercent')
}

/**
 * The help text under the control. It says what the space is FOR and what
 * happens when it is reached — a first-time reader must not have to guess.
 */
export function protectionHelpText(
  policy: ProtectionPolicy,
  defaultPercent: number = DEFAULT_MIN_FREE_PERCENT,
): string {
  const target =
    policy.value === null
      ? i18n.t('helpers.locationProtection.targetDefault', { percent: String(defaultPercent) })
      : policy.unit === 'gb'
        ? i18n.t('helpers.locationProtection.targetGb', { value: String(policy.value) })
        : i18n.t('helpers.locationProtection.targetPercent', { value: String(policy.value) })
  return i18n.t('helpers.locationProtection.helpText', { target, percent: String(defaultPercent) })
}

/**
 * A `maxUsedGb` an operator stored before this became a system-managed
 * mechanism. Surfaced read-only so an edit does not silently delete it.
 */
export function readLegacyMaxUsedGb(config: Readonly<Record<string, unknown>>): number | null {
  return readNumber(config['maxUsedGb'])
}

/** Why a cap is in force — it is never an operator knob any more. */
export type SystemCapReason = 'legacy' | 'drain'

export interface SystemCap {
  readonly bytes: number
  readonly reason: SystemCapReason
}

/**
 * The cap to MARK on the bar, or `null` when none is in force.
 *
 * Exactly two locations carry one: a row still holding a value an operator
 * stored back when `maxUsedGb` was a knob, and a DRAINING location, where the
 * descending cap is the progress indicator itself. Everything else draws no
 * marker — painting an absent cap advertises a knob that no longer exists.
 */
export function resolveSystemCap(
  config: Readonly<Record<string, unknown>>,
  mode: string,
): SystemCap | null {
  const gb = readNumber(config['maxUsedGb'])
  if (gb === null || gb < 0) return null
  return { bytes: gb * BYTES_PER_GB, reason: mode === 'drain' ? 'drain' : 'legacy' } // i18n-ignore: enum value, never shown
}
