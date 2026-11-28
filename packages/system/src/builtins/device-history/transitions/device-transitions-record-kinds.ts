/**
 * The record kind of the transition ledger (D1022). Declared by the
 * device-history addon (owner stamp `device-history`) in the `events` file:
 * one row per recorded transition, swept by the device-history retention pass
 * under the `transitionDays` setting - the engine does nothing on its own.
 *
 * Kept in a module with no side effects: the records guards import it.
 */
import type { z } from 'zod'
import { defineRecordKinds, DeviceTransitionSchema, type DefinedRecordKind } from '@dominevo/types'

/** A stored row is a command: `ok` or `failed`. `device` is a derived row and never written (D1084). */
const StoredDeviceTransitionSchema = DeviceTransitionSchema.refine(
  (row) => row.outcome !== 'device',
  { message: 'a derived device change is not stored', path: ['outcome'] },
)

const _deviceTransitionsRecordKinds = defineRecordKinds({
  'device-transitions': {
    schema: StoredDeviceTransitionSchema,
    class: 'audit',
    database: 'events',
    writeTrigger:
      'the hub kernel delivers a batch of completed device commands, one row per command with its actor and ok or failed outcome',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'device_cap_at', fields: ['deviceId', 'capName', 'at'] },
      { name: 'device_actor_at', fields: ['deviceId', 'actor.kind', 'at'] },
      { name: 'device_outcome_at', fields: ['deviceId', 'outcome', 'at'] },
      { name: 'actor_at', fields: ['actor.kind', 'at'] },
      { name: 'outcome_at', fields: ['outcome', 'at'] },
    ],
    retention: {
      owner: 'device-history',
      reason:
        'swept by the device-history retention pass under the transitionDays setting (default 365 days)',
    },
    deviceRemoval: 'delete',
  },
})

export type DeviceTransitionsRecordKindsMap = {
  readonly 'device-transitions': DefinedRecordKind<
    z.ZodType<z.infer<typeof DeviceTransitionSchema>>
  >
}

export const deviceTransitionsRecordKinds: DeviceTransitionsRecordKindsMap =
  _deviceTransitionsRecordKinds
