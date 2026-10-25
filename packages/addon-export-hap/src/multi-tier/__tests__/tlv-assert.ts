/**
 * Test helper: read a TLV field that MUST be there.
 *
 * `noUncheckedIndexedAccess` is right about decoded TLV maps — a controller's
 * bytes really can lack a type. In a test the absence is the finding, so this
 * turns it into a named failure instead of a cast that would report it as
 * "cannot read property of undefined" three lines later.
 */
export function field<T>(map: Record<string, T | undefined>, type: number | string): T {
  const value = map[String(type)]
  if (value === undefined) {
    throw new Error(`TLV type ${type} is absent; present: ${Object.keys(map).join(', ') || 'none'}`)
  }
  return value
}

/** The elements of a REPEATED TLV field, whether the decoder gave one or many. */
export function repeated<T>(
  value: T | readonly T[] | undefined,
  type: number | string,
): readonly T[] {
  if (value === undefined) {
    throw new Error(`repeated TLV type ${type} is absent`)
  }
  return Array.isArray(value) ? value : [value as T]
}

/** One element of a repeated field, by index, failing by name when short. */
export function at<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) {
    throw new Error(`expected at least ${index + 1} entries, got ${values.length}`)
  }
  return value
}
