/**
 * Where a target's secrets GO — judged on the value the adapter would USE.
 *
 * `mergeSecrets` may restore a redacted secret only while the destination is
 * unchanged. Comparing raw config blobs refused edits that changed nothing
 * (review M2): the viewer serializer sends every schema field with its default
 * (so an absent `backend` came back as `'green-api'`), a field hidden for the
 * stored backend is sent too, and the zentik text field turns a stored list
 * into CSV. So the comparison is of an EFFECTIVE destination:
 *
 *  - an absent / null / `''` value is the field's schema `default`;
 *  - a field whose `showWhen` does not hold for the config is not in use and
 *    routes nothing — it compares as absent (switching the controlling field
 *    itself is a change of its own, and `backend` is a destination key);
 *  - the adapter may canonicalise a value (`normalizeDestination`).
 *
 * Fail-closed where it matters: two values that are not recognisably the SAME
 * destination are a change, and a change with a redacted secret is refused.
 */
import type { ConfigCondition, ConfigField, TargetKind } from '@camstack/types'

/** What the comparison needs from an adapter. */
export interface DestinationSpec {
  readonly descriptor: TargetKind
  readonly destinationKeys: readonly string[]
  normalizeDestination?(key: string, value: unknown): unknown
}

function topLevelFields(descriptor: TargetKind): ReadonlyMap<string, ConfigField> {
  const out = new Map<string, ConfigField>()
  for (const section of descriptor.configSchema.sections) {
    for (const field of section.fields) {
      if ('key' in field) out.set(field.key, field)
    }
  }
  return out
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** The value in effect: the stored one, else the schema default. */
function valueInEffect(
  fields: ReadonlyMap<string, ConfigField>,
  config: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const value = config[key]
  if (!isBlank(value)) return value
  const field = fields.get(key)
  return field !== undefined && 'default' in field ? field.default : undefined
}

/** A field's visibility condition — separators and the like have none. */
function showWhenOf(field: ConfigField | undefined): ConfigCondition | undefined {
  return field !== undefined && 'showWhen' in field ? field.showWhen : undefined
}

function conditionHolds(condition: ConfigCondition, actual: unknown): boolean {
  if (condition.equals !== undefined && actual !== condition.equals) return false
  if (condition.notEquals !== undefined && actual === condition.notEquals) return false
  if (condition.in !== undefined && !condition.in.includes(actual)) return false
  if (condition.notIn?.includes(actual)) return false
  const list = Array.isArray(actual) ? actual : []
  if (condition.includes !== undefined && !list.includes(condition.includes)) return false
  if (condition.notIncludes !== undefined && list.includes(condition.notIncludes)) return false
  return true
}

/** A comparable string for one value: blank is '', a scalar itself, else JSON. */
function comparable(value: unknown): string {
  if (isBlank(value)) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function isFieldInUse(
  fields: ReadonlyMap<string, ConfigField>,
  config: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const condition = showWhenOf(fields.get(key))
  return (
    condition === undefined ||
    conditionHolds(condition, valueInEffect(fields, config, condition.field))
  )
}

/**
 * Whether a field is SHOWN for this config — the exact rule the destination
 * comparison uses (defaults applied, every `ConfigCondition` operator), so the
 * spec proving a hidden field is never read tests the same notion of hidden.
 */
export function fieldInUse(
  descriptor: TargetKind,
  config: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return isFieldInUse(topLevelFields(descriptor), config, key)
}

/** Every destination key → the comparable value the adapter would use. */
export function effectiveDestinations(
  spec: DestinationSpec,
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const fields = topLevelFields(spec.descriptor)
  const out: Record<string, string> = {}
  for (const key of spec.destinationKeys) {
    if (!isFieldInUse(fields, config, key)) {
      out[key] = ''
      continue
    }
    const value = valueInEffect(fields, config, key)
    out[key] = comparable(spec.normalizeDestination ? spec.normalizeDestination(key, value) : value)
  }
  return out
}

/** The destination keys whose effective value differs between two configs. */
export function changedDestinations(
  spec: DestinationSpec,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly string[] {
  const was = effectiveDestinations(spec, before)
  const now = effectiveDestinations(spec, after)
  return spec.destinationKeys.filter((key) => was[key] !== now[key])
}
