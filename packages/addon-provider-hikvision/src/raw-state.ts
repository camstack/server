import type { RawStateResult, IDeviceRuntimeState } from '@camstack/types'

/** Frozen cap-keyed snapshot shape — exactly what `IDeviceRuntimeState.snapshot()` returns. */
export type RuntimeStateSnapshot = ReturnType<IDeviceRuntimeState['snapshot']>

/**
 * Source tag for every raw-state blob this provider emits.
 */
const RAW_STATE_SOURCE = 'hikvision' as const

/**
 * Key fragments that mark a field as secret/credential bearing. Any
 * object key matching this (case-insensitive) is dropped from the
 * display-safe raw-state blob.
 */
const SECRET_KEY_PATTERN = /password|token|secret|credential|passwd|auth/i

/**
 * The slice of the runtime-state surface the raw-state helper needs:
 * a frozen, cap-keyed snapshot of every written slice. Mirrors
 * `IDeviceRuntimeState.snapshot()` so a `BaseDevice.runtimeState`
 * satisfies it structurally, and tests can supply a tiny fake.
 */
export interface RawStateReader {
  snapshot(): RuntimeStateSnapshot
}

/**
 * Deep-copy `value`, dropping any object key that looks like a
 * credential. Recurses into nested plain objects and arrays; leaves
 * primitives untouched. Never mutates the input.
 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue
      out[key] = redactValue(child)
    }
    return out
  }
  return value
}

/**
 * Return a deep copy of `obj` with every credential-bearing key
 * removed at any depth. Display-safe.
 */
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(obj)
  // `obj` is an object, so `redactValue` returns an object too.
  return redacted as Record<string, unknown>
}

/**
 * Snapshot every cached cap slice from `reader` and strip secrets.
 * Returns a `Record<capName, redactedSlice>`; empty when no slice has
 * been written yet.
 */
export function collectRedactedSnapshot(reader: RawStateReader): Record<string, unknown> {
  const snap = reader.snapshot()
  const out: Record<string, unknown> = {}
  for (const [capName, slice] of Object.entries(snap)) {
    out[capName] = redactSecrets({ ...slice })
  }
  return out
}

/**
 * Build the display-safe `{ source:'hikvision', data }` raw-state blob
 * from a device's cached runtime-state slices. Returns `null` when
 * the device has no cached state at all (so the State panel hides the
 * Raw toggle rather than showing an empty object).
 *
 * No camera round-trip — reads only the in-memory runtime-state cache.
 */
export function buildRawState(reader: RawStateReader): RawStateResult | null {
  const data = collectRedactedSnapshot(reader)
  if (Object.keys(data).length === 0) return null
  return { source: RAW_STATE_SOURCE, data }
}
