/**
 * Record kinds owned by device-manager (records plan phase 4).
 */
import { z } from 'zod'
import { DeviceTombstoneSchema, defineRecordKinds, type DefinedRecordKind } from '@camstack/types'
import type { IsolatedRecordKinds } from '../records-isolated.js'

/** Body excludes `deviceId` — the record id is `String(deviceId)`. */
export type DeviceTombstoneBody = Omit<z.infer<typeof DeviceTombstoneSchema>, 'deviceId'>
const _deviceTombstoneBody: z.ZodType<DeviceTombstoneBody> = DeviceTombstoneSchema.omit({
  deviceId: true,
})
export const DeviceTombstoneBodySchema: z.ZodType<DeviceTombstoneBody> = _deviceTombstoneBody

const _deviceManagerRecordKinds = defineRecordKinds({
  tombstones: {
    schema: DeviceTombstoneBodySchema,
    class: 'ledger',
    writeTrigger:
      '`removeDevice` records one row per deleted device after the device row is gone; re-record keeps the earlier `deletedAt`',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'deleted_at', fields: ['deletedAt'] }],
    retention: {
      owner: 'device-manager',
      reason:
        '90 days (`DEVICE_TOMBSTONE_RETENTION_MS`), pruned whenever a tombstone is written or the list is read',
    },
  },
}) satisfies IsolatedRecordKinds

export type DeviceManagerRecordKindsMap = {
  readonly tombstones: DefinedRecordKind<z.ZodType<DeviceTombstoneBody>>
}

export const deviceManagerRecordKinds: DeviceManagerRecordKindsMap = _deviceManagerRecordKinds

/** Narrow kind for `records.kind()`. */
export const deviceTombstonesRecordKind: DefinedRecordKind<z.ZodType<DeviceTombstoneBody>> =
  _deviceManagerRecordKinds.tombstones
