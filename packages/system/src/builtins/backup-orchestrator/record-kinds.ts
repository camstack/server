/**
 * Record kinds owned by backup-orchestrator (phase 4 — hub-main).
 */
import type { RecordKindHandle, RecordsAccess } from '@camstack/types'
import { DataStoreDatabaseSchema, defineRecordKinds, type DefinedRecordKind } from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export type BackupScheduleBody = {
  readonly label: string
  readonly cron: string
  readonly enabled: boolean
  readonly locationIds: readonly string[]
  readonly retentionCount: number
  readonly dataSources?: readonly string[]
  readonly databases?: readonly z.infer<typeof DataStoreDatabaseSchema>[]
  readonly lastAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly lastError?: string
}
const _backupScheduleBody: z.ZodType<BackupScheduleBody> = z.object({
  label: z.string(),
  cron: z.string(),
  enabled: z.boolean(),
  locationIds: z.array(z.string()).readonly(),
  retentionCount: z.number(),
  dataSources: z.array(z.string()).readonly().optional(),
  databases: z.array(DataStoreDatabaseSchema).readonly().optional(),
  lastAttemptAt: z.number().optional(),
  lastSuccessAt: z.number().optional(),
  lastError: z.string().optional(),
})
export const BackupScheduleBodySchema: z.ZodType<BackupScheduleBody> = _backupScheduleBody

export type BackupDestinationPolicyBody = {
  readonly enabled: boolean
  readonly retentionCount: number
  readonly label?: string
  readonly lastAttemptAt?: number
  readonly lastError?: string
}
const _backupDestinationPolicyBody: z.ZodType<BackupDestinationPolicyBody> = z.object({
  enabled: z.boolean(),
  retentionCount: z.number(),
  label: z.string().optional(),
  lastAttemptAt: z.number().optional(),
  lastError: z.string().optional(),
})
export const BackupDestinationPolicyBodySchema: z.ZodType<BackupDestinationPolicyBody> =
  _backupDestinationPolicyBody

export type BackupEncryptionKeyBody = {
  readonly keyId: string
  readonly publicKey: string
  readonly createdAt: number
  readonly retiredAt: number | null
}
const _backupEncryptionKeyBody: z.ZodType<BackupEncryptionKeyBody> = z.object({
  keyId: z.string(),
  publicKey: z.string(),
  createdAt: z.number(),
  retiredAt: z.number().nullable(),
})
export const BackupEncryptionKeyBodySchema: z.ZodType<BackupEncryptionKeyBody> =
  _backupEncryptionKeyBody

export type BackupSeedMarkerBody = {
  readonly seededAt: number
}
const _backupSeedMarkerBody: z.ZodType<BackupSeedMarkerBody> = z.object({
  seededAt: z.number(),
})
export const BackupSeedMarkerBodySchema: z.ZodType<BackupSeedMarkerBody> = _backupSeedMarkerBody

const _backupOrchestratorRecordKinds = defineRecordKinds({
  schedules: {
    schema: BackupScheduleBodySchema,
    class: 'config',
    writeTrigger: 'operator upsert/delete; orchestrator stamps lastAttempt/success/error',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'enabled', fields: ['enabled'] }],
    retention: { none: 'operator delete only' },
    entry: { title: 'Backup schedules', nameField: 'label' },
  },
  'destination-policies': {
    schema: BackupDestinationPolicyBodySchema,
    class: 'config',
    writeTrigger: 'ensureDefault, operator upsert, recordAttempt after each archive write',
    device: 'none',
    at: 'none',
    retention: { none: 'row outlives location; ensureDefault recreates' },
  },
  'encryption-keys': {
    schema: BackupEncryptionKeyBodySchema,
    class: 'config',
    writeTrigger: 'setupEncryption activate; disableEncryption retires active row',
    device: 'none',
    at: 'none',
    retention: { none: 'retired keys kept for archive decryption hints' },
  },
  'seed-markers': {
    schema: BackupSeedMarkerBodySchema,
    class: 'config',
    writeTrigger: 'mark() once per seed id after seed landed',
    device: 'none',
    at: 'none',
    retention: { none: 'one row per seed id ever' },
  },
}) satisfies IsolatedRecordKinds

export type BackupOrchestratorRecordKindsMap = {
  readonly schedules: DefinedRecordKind<z.ZodType<BackupScheduleBody>>
  readonly 'destination-policies': DefinedRecordKind<z.ZodType<BackupDestinationPolicyBody>>
  readonly 'encryption-keys': DefinedRecordKind<z.ZodType<BackupEncryptionKeyBody>>
  readonly 'seed-markers': DefinedRecordKind<z.ZodType<BackupSeedMarkerBody>>
}

export const backupOrchestratorRecordKinds: BackupOrchestratorRecordKindsMap =
  _backupOrchestratorRecordKinds

export const backupSchedulesRecordKind: DefinedRecordKind<z.ZodType<BackupScheduleBody>> =
  _backupOrchestratorRecordKinds.schedules

export const backupDestinationPoliciesRecordKind: DefinedRecordKind<
  z.ZodType<BackupDestinationPolicyBody>
> = _backupOrchestratorRecordKinds['destination-policies']

export const backupEncryptionKeysRecordKind: DefinedRecordKind<z.ZodType<BackupEncryptionKeyBody>> =
  _backupOrchestratorRecordKinds['encryption-keys']

export const backupSeedMarkersRecordKind: DefinedRecordKind<z.ZodType<BackupSeedMarkerBody>> =
  _backupOrchestratorRecordKinds['seed-markers']

export interface BackupRecordStores {
  readonly schedules: RecordKindHandle<BackupScheduleBody>
  readonly destinationPolicies: RecordKindHandle<BackupDestinationPolicyBody>
  readonly encryptionKeys: RecordKindHandle<BackupEncryptionKeyBody>
  readonly seedMarkers: RecordKindHandle<BackupSeedMarkerBody>
}

export function backupRecordStoresOf(records: Pick<RecordsAccess, 'kind'>): BackupRecordStores {
  return {
    schedules: records.kind(backupSchedulesRecordKind),
    destinationPolicies: records.kind(backupDestinationPoliciesRecordKind),
    encryptionKeys: records.kind(backupEncryptionKeysRecordKind),
    seedMarkers: records.kind(backupSeedMarkersRecordKind),
  }
}
