/**
 * Record kinds owned by device-manager (records plan phase 4).
 */
import { z } from 'zod'
import {
  AdoptionRecordSchema,
  AdoptModeSchema,
  DeviceTombstoneSchema,
  DiscoveryProposalBodySchema,
  IdentityLinkBodySchema,
  RoomBodySchema,
  ZoneBodySchema,
  defineRecordKinds,
  type AdoptionRecord,
  type AdoptMode,
  type DefinedRecordKind,
  type DiscoveryProposalBody,
  type IdentityLinkBody,
  type RoomBody,
  type ZoneBody,
} from '@camstack/types'
import type { IsolatedRecordKinds } from '../records-isolated.js'

/** Body excludes `deviceId` — the record id is `String(deviceId)`. */
export type DeviceTombstoneBody = Omit<z.infer<typeof DeviceTombstoneSchema>, 'deviceId'>
const _deviceTombstoneBody: z.ZodType<DeviceTombstoneBody> = DeviceTombstoneSchema.omit({
  deviceId: true,
})
export const DeviceTombstoneBodySchema: z.ZodType<DeviceTombstoneBody> = _deviceTombstoneBody

/** The adopt mode an operator stored for one integration instance (D1090). */
export interface AdoptionModeBody {
  readonly addonId: string
  readonly integrationId: string
  readonly adoptMode: AdoptMode
}
const AdoptionModeBodySchema: z.ZodType<AdoptionModeBody> = z.object({
  addonId: z.string(),
  integrationId: z.string(),
  adoptMode: AdoptModeSchema,
})
const AdoptionRecordBodySchema: z.ZodType<AdoptionRecord> = AdoptionRecordSchema

const _deviceManagerRecordKinds = defineRecordKinds({
  'adoption-records': {
    schema: AdoptionRecordBodySchema,
    class: 'config',
    writeTrigger:
      'an adoption job lands a candidate (who adopted it); after each discovery refresh the miss counter, `adoptionState` and `withdrawnSince` move; `adoptionRelease` marks it released (D1090)',
    device: 'none',
    at: 'none',
    indexes: [],
    retention: {
      none: 'a record lives with its device; a released or removed device keeps it as the marker auto-adopt must not re-adopt, until an explicit adopt replaces it',
    },
  },
  'adoption-modes': {
    schema: AdoptionModeBodySchema,
    class: 'config',
    writeTrigger: '`adoptionSetMode` stores the adopt mode of one integration instance (D1090)',
    device: 'none',
    at: 'none',
    indexes: [],
    retention: {
      none: 'an operator choice lives until the operator changes it',
    },
  },
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
  // D1089: a room and a site zone are records with an id; a device meta carries
  // `locationId`. A rename, a restyle or a new description is ONE write here.
  rooms: {
    schema: RoomBodySchema,
    class: 'config',
    writeTrigger:
      '`ensureRoom` creates one, `updateRoom` edits it (rename, icon, description, zone); `deleteRoom` removes it and clears every device reference in one operation',
    device: 'none',
    at: 'none',
    indexes: [],
    retention: { none: 'a room lives until the operator deletes it' },
  },
  zones: {
    schema: ZoneBodySchema,
    class: 'config',
    writeTrigger:
      '`setSiteZone` / `setLocationZone` create one, `renameSiteZone` edits it, `removeSiteZone` removes it and clears the `zoneId` of its rooms',
    device: 'none',
    at: 'none',
    indexes: [],
    retention: { none: 'a zone lives until the operator deletes it' },
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
  readonly 'adoption-records': DefinedRecordKind<z.ZodType<AdoptionRecord>>
  readonly 'adoption-modes': DefinedRecordKind<z.ZodType<AdoptionModeBody>>
  readonly tombstones: DefinedRecordKind<z.ZodType<DeviceTombstoneBody>>
  readonly 'discovery-proposals': DefinedRecordKind<z.ZodType<DiscoveryProposalBody>>
  readonly 'identity-links': DefinedRecordKind<z.ZodType<IdentityLinkBody>>
  readonly rooms: DefinedRecordKind<z.ZodType<RoomBody>>
  readonly zones: DefinedRecordKind<z.ZodType<ZoneBody>>
}

export const deviceManagerRecordKinds: DeviceManagerRecordKindsMap = _deviceManagerRecordKinds

/** Narrow kind for `records.kind()`. */
export const deviceTombstonesRecordKind: DefinedRecordKind<z.ZodType<DeviceTombstoneBody>> =
  _deviceManagerRecordKinds.tombstones
