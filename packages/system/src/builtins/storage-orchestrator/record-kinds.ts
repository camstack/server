/**
 * Record kinds owned by storage-orchestrator (phase 4 — hub-main).
 */
import {
  defineRecordKinds,
  StorageLocationModeSchema,
  StorageLocationTypeSchema,
  type DefinedRecordKind,
} from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export const STORAGE_DRAIN_STATE_LEGACY = 'storage_drain_state'

export type StorageLocationBody = {
  readonly type: z.infer<typeof StorageLocationTypeSchema>
  readonly displayName: string
  readonly providerId: string
  readonly config: Record<string, unknown>
  readonly isSystem: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly nodeId?: string
  readonly enabled?: boolean
  readonly mode?: z.infer<typeof StorageLocationModeSchema>
  readonly isDefault?: boolean
}
const _storageLocationBody: z.ZodType<StorageLocationBody> = z.object({
  type: StorageLocationTypeSchema,
  displayName: z.string(),
  providerId: z.string(),
  config: z.record(z.string(), z.unknown()),
  isSystem: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nodeId: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: StorageLocationModeSchema.optional(),
  isDefault: z.boolean().optional(),
})
export const StorageLocationBodySchema: z.ZodType<StorageLocationBody> = _storageLocationBody

export type StorageSeedMarkerBody = { readonly seededAt: number }
const _storageSeedMarkerBody: z.ZodType<StorageSeedMarkerBody> = z.object({ seededAt: z.number() })
export const StorageSeedMarkerBodySchema: z.ZodType<StorageSeedMarkerBody> = _storageSeedMarkerBody

export type StorageDrainStateBody = {
  readonly locationId: string
  readonly startedAtMs: number
  readonly startBytes: number
  readonly capBytes: number
  readonly lastPeerBytes: number | null
  readonly lastSweepMs: number
  readonly observedGrowthBytes: number
  readonly observedElapsedMs: number
}
const _storageDrainStateBody: z.ZodType<StorageDrainStateBody> = z.object({
  locationId: z.string(),
  startedAtMs: z.number(),
  startBytes: z.number(),
  capBytes: z.number(),
  lastPeerBytes: z.number().nullable(),
  lastSweepMs: z.number(),
  observedGrowthBytes: z.number(),
  observedElapsedMs: z.number(),
})
export const StorageDrainStateBodySchema: z.ZodType<StorageDrainStateBody> = _storageDrainStateBody

const _storageOrchestratorRecordKinds = defineRecordKinds({
  locations: {
    schema: StorageLocationBodySchema,
    class: 'config',
    writeTrigger:
      'operator create/edit/delete; boot reconcile seeds defaults and backfills in-memory locations',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'type', fields: ['type'] }],
    retention: { none: 'operator delete or declaration prune only' },
  },
  'seed-markers': {
    schema: StorageSeedMarkerBodySchema,
    class: 'config',
    writeTrigger:
      'a declared location type was seeded (or found already present on an existing install); the id is the type',
    device: 'none',
    at: 'none',
    retention: {
      none: 'one row per location type ever seeded — what makes an operator delete stick',
    },
  },
  'drain-state': {
    schema: StorageDrainStateBodySchema,
    class: 'config',
    writeTrigger: 'pressure sweep while a location is in drain mode',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'location_id', fields: ['locationId'] }],
    retention: { none: 'row deleted when location leaves drain' },
  },
}) satisfies IsolatedRecordKinds

export type StorageOrchestratorRecordKindsMap = {
  readonly locations: DefinedRecordKind<z.ZodType<StorageLocationBody>>
  readonly 'seed-markers': DefinedRecordKind<z.ZodType<StorageSeedMarkerBody>>
  readonly 'drain-state': DefinedRecordKind<z.ZodType<StorageDrainStateBody>>
}

export const storageOrchestratorRecordKinds: StorageOrchestratorRecordKindsMap =
  _storageOrchestratorRecordKinds

export const storageLocationsRecordKind: DefinedRecordKind<z.ZodType<StorageLocationBody>> =
  _storageOrchestratorRecordKinds.locations

export const storageDrainStateRecordKind: DefinedRecordKind<z.ZodType<StorageDrainStateBody>> =
  _storageOrchestratorRecordKinds['drain-state']
