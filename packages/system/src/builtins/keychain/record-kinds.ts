/**
 * Record kinds owned by keychain (phase 4 — audit and resets only).
 */
import {
  defineRecordKinds,
  KeychainAuditEntrySchema,
  KeychainResetRecordSchema,
  type DefinedRecordKind,
} from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export type KeychainAuditBody = Omit<z.infer<typeof KeychainAuditEntrySchema>, 'id' | 'at'>
const _keychainAuditBody: z.ZodType<KeychainAuditBody> = KeychainAuditEntrySchema.omit({
  id: true,
  at: true,
})
export const KeychainAuditBodySchema: z.ZodType<KeychainAuditBody> = _keychainAuditBody

export type KeychainResetBody = Omit<z.infer<typeof KeychainResetRecordSchema>, 'id' | 'at'>
const _keychainResetBody: z.ZodType<KeychainResetBody> = KeychainResetRecordSchema.omit({
  id: true,
  at: true,
})
export const KeychainResetBodySchema: z.ZodType<KeychainResetBody> = _keychainResetBody

const _keychainRecordKinds = defineRecordKinds({
  audit: {
    schema: KeychainAuditBodySchema,
    class: 'audit',
    writeTrigger: 'one row per write / delete / rotation / reveal / recovery download',
    device: 'none',
    at: 'required',
    indexes: [{ name: 'audit_at', fields: ['at'] }],
    retention: {
      owner: 'keychain',
      reason: '90 days and at most 20_000 rows, pruned at boot and daily',
    },
  },
  resets: {
    schema: KeychainResetBodySchema,
    class: 'config',
    writeTrigger:
      'one row per keychain reset (System → Secrets, or the RESET_KEYCHAIN trigger file); acknowledgeReset stamps acknowledgedAt',
    device: 'none',
    at: 'required',
    retention: {
      none: 'a handful of rows over a hub life; they name archive tables a reset left behind',
    },
  },
}) satisfies IsolatedRecordKinds

export type KeychainRecordKindsMap = {
  readonly audit: DefinedRecordKind<z.ZodType<KeychainAuditBody>>
  readonly resets: DefinedRecordKind<z.ZodType<KeychainResetBody>>
}

export const keychainRecordKinds: KeychainRecordKindsMap = _keychainRecordKinds

export const keychainAuditRecordKind: DefinedRecordKind<z.ZodType<KeychainAuditBody>> =
  _keychainRecordKinds.audit

export const keychainResetsRecordKind: DefinedRecordKind<z.ZodType<KeychainResetBody>> =
  _keychainRecordKinds.resets
