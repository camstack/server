/**
 * Record kinds owned by device-manager (records plan phase 4).
 */
import { z } from 'zod'
import {
  DeviceTombstoneSchema,
  DiscoveryProposalBodySchema,
  IdentityLinkBodySchema,
  defineRecordKinds,
  type DefinedRecordKind,
  type DiscoveryProposalBody,
  type IdentityLinkBody,
} from '@camstack/types'
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
  'discovery-proposals': {
    schema: DiscoveryProposalBodySchema,
    class: 'config',
    writeTrigger:
      'the passive listener and the 30-minute sweep of `local-network` re-see a device (`lastSeenAt` and `at` move); `dismissDiscoveryProposal` sets `dismissed`',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'last_seen_at', fields: ['lastSeenAt'] }],
    retention: { ttlMs: 90 * 24 * 60 * 60 * 1000, from: 'at' },
  },
  'identity-links': {
    schema: IdentityLinkBodySchema,
    class: 'config',
    writeTrigger:
      'the identity-link reconciler sees a candidate appear, upgrade or lose its evidence; the operator confirms, dismisses or unlinks (D1063)',
    // A link names TWO devices, so no single device column: removal is the
    // `identity-links` step of `removeDevice` (D864), driven by the tombstone.
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'a_device', fields: ['a.deviceId'] },
      { name: 'b_device', fields: ['b.deviceId'] },
    ],
    retention: {
      none: 'a link lives as long as both its devices; a dismissal is sticky (operator intent)',
    },
  },
}) satisfies IsolatedRecordKinds

export type DeviceManagerRecordKindsMap = {
  readonly tombstones: DefinedRecordKind<z.ZodType<DeviceTombstoneBody>>
  readonly 'discovery-proposals': DefinedRecordKind<z.ZodType<DiscoveryProposalBody>>
  readonly 'identity-links': DefinedRecordKind<z.ZodType<IdentityLinkBody>>
}

export const deviceManagerRecordKinds: DeviceManagerRecordKindsMap = _deviceManagerRecordKinds

/** Narrow kind for `records.kind()`. */
export const deviceTombstonesRecordKind: DefinedRecordKind<z.ZodType<DeviceTombstoneBody>> =
  _deviceManagerRecordKinds.tombstones
