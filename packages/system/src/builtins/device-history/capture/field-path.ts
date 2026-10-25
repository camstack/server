/**
 * Reading a history field out of a cap slice. A catalog path is a top-level
 * `runtimeState` key or a path into a FIXED object (`dustBin.level`); the
 * catalog guard keeps it out of arrays and records, so a plain walk is enough.
 */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value at `path`, or `undefined` when any step is missing or not an object. */
export function readPath(slice: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = slice
  for (const step of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[step]
  }
  return current
}

/**
 * The number a field contributes: a finite number for a gauge/counter, 0/1 for
 * a boolean field. Anything else (null, undefined, a string, NaN) is NOT a
 * reading — `null` means unknown and must never become 0.
 */
export function readNumeric(
  slice: Readonly<Record<string, unknown>>,
  path: string,
  kind: 'gauge' | 'counter' | 'boolean',
): number | null {
  // An `enum` field is read by the capture engine against its value list, never here.
  const raw = readPath(slice, path)
  if (kind === 'boolean') {
    if (typeof raw === 'boolean') return raw ? 1 : 0
    return null
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return null
}

/** A unit string a `unitFrom` sibling field states, or `null` when it states none. */
export function readUnit(
  slice: Readonly<Record<string, unknown>>,
  unitFrom: string,
): string | null {
  const raw = readPath(slice, unitFrom)
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}
