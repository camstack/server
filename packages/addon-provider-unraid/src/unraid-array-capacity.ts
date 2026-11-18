/**
 * The array capacity in bytes, or `null` when it is unknown (D393): the API left it out, or it
 * reported a total of zero (a stopped array has no capacity to measure, not an empty one). A
 * used or free figure is only meaningful against a known total. Pure.
 */
import type { UnraidCapacityKb } from './unraid-client-contract.js'

/** Unraid reports the array capacity in KiB. */
const KIB = 1024

/** A known array capacity, in bytes; `used` / `free` stay `null` when the API left them out. */
export interface UnraidArrayCapacityBytes {
  readonly total: number
  readonly used: number | null
  readonly free: number | null
}

function kibToBytes(kib: number | null): number | null {
  return kib === null || !Number.isFinite(kib) || kib < 0 ? null : kib * KIB
}

/** The capacity in bytes, or `null` when the total is absent or zero. */
export function knownArrayCapacityBytes(
  capacity: UnraidCapacityKb,
): UnraidArrayCapacityBytes | null {
  const total = kibToBytes(capacity.total)
  if (total === null || total === 0) return null
  return { total, used: kibToBytes(capacity.used), free: kibToBytes(capacity.free) }
}
