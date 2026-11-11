/**
 * The picker speaks {@link PickedValue}; most admin call sites store plain
 * numeric device ids (a rule's devices, a trigger's source, a token's
 * cameras). These two convert at that boundary, and nowhere else.
 */
import type { PickedValue } from './device-value-picker-model'

export function pickedFromDeviceIds(ids: readonly number[]): readonly PickedValue[] {
  return ids.map((deviceId) => ({ deviceId }))
}

/** Back to the stored shape: each device once, in pick order. */
export function deviceIdsOf(picked: readonly PickedValue[]): number[] {
  return [...new Set(picked.map((p) => p.deviceId))]
}
