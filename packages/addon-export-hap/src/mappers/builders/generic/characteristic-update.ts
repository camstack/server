/**
 * How a capability status becomes characteristic writes.
 *
 * Kept in its own module — with no hap-nodejs *service* and no camstack proxy —
 * so both the generic capability table and the camera's own builders can read a
 * status the same way without importing each other.
 */
import type { Characteristic, CharacteristicValue, Service, WithUUID } from '@homebridge/hap-nodejs'
import type { z } from 'zod'

/** One characteristic write derived from a capability status. */
export interface CharacteristicUpdate {
  readonly characteristic: WithUUID<{ new (): Characteristic }>
  readonly value: CharacteristicValue
}

/**
 * Parse `status` with the capability's OWN Zod schema and turn it into
 * characteristic writes.
 *
 * Duck-typing the payload here would be the second source of truth about what a
 * cap reports; the schema is the first and only one. A payload that does not
 * match yields NO updates — never a partial or invented value — and the caller
 * logs the drop, because a sensor that silently stops moving is
 * indistinguishable from a sensor that never changed.
 *
 * Rows `.pick()` only the fields they read, so a provider omitting a timestamp
 * cannot silence a sensor.
 */
export function reader<S extends z.ZodType>(
  schema: S,
  toUpdates: (status: z.infer<S>) => readonly CharacteristicUpdate[],
): (status: unknown) => readonly CharacteristicUpdate[] {
  return (status) => {
    const parsed = schema.safeParse(status)
    return parsed.success ? toUpdates(parsed.data) : []
  }
}

/** Push every update onto `service`. */
export function applyUpdates(service: Service, updates: readonly CharacteristicUpdate[]): void {
  for (const update of updates) {
    service.updateCharacteristic(update.characteristic, update.value)
  }
}
