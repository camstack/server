/**
 * The record kind of the run ledger (D992). Declared by the device-history
 * addon (owner stamp `device-history`) in the `events` file: a ring of the
 * newest runs per device, with one row per run and the open row written
 * through at the instant the run opens.
 *
 * Kept in a module with no side effects: the records guards import it.
 */
import type { z } from 'zod'
import { defineRecordKinds, DeviceRunSchema, type DefinedRecordKind } from '@camstack/types'

export const DEVICE_RUNS_MAX_ROWS_PER_DEVICE = 500

const _deviceRunsRecordKinds = defineRecordKinds({
  'device-runs': {
    schema: DeviceRunSchema,
    class: 'ledger',
    database: 'events',
    writeTrigger:
      'a running-state flip opens (write-through) or closes a run; the boot reconcile closes or opens one the flips missed',
    device: 'required',
    at: 'required',
    indexes: [
      { name: 'open', fields: ['state', 'deviceId'] },
      { name: 'device_outcome', fields: ['deviceId', 'outcome', 'startedAt'] },
    ],
    retention: { maxRowsPerDevice: DEVICE_RUNS_MAX_ROWS_PER_DEVICE },
    deviceRemoval: 'delete',
  },
})

export type DeviceRunsRecordKindsMap = {
  readonly 'device-runs': DefinedRecordKind<z.ZodType<z.infer<typeof DeviceRunSchema>>>
}

export const deviceRunsRecordKinds: DeviceRunsRecordKindsMap = _deviceRunsRecordKinds
