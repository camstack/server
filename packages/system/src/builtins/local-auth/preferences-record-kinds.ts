/**
 * The per-user account preferences kind (D894), owned by `local-auth` because
 * it owns the users the rows belong to — a user's delete wipes them in the
 * same call (`endAllAccess`).
 *
 * Declared on its OWN, never folded into `localAuthRecordKinds`: that map is
 * the phase-6 adoption set, and a kind missing from the catalog there sends
 * the whole auth builtin back to its legacy tables.
 */
import {
  type DefinedRecordKind,
  defineRecordKinds,
  type PreferenceValue,
  PreferenceDeviceIdSchema,
  PreferenceNamespaceSchema,
  PreferenceValueSchema,
  PREFERENCES_MAX_VALUE_BYTES,
} from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

/** One `(user, namespace)` row. The record id is {@link userPreferenceRecordId}. */
export type UserPreferenceBody = {
  readonly userId: string
  readonly namespace: string
  readonly value: PreferenceValue
  readonly revision: number
  readonly updatedAt: number
  readonly updatedByDevice: string | null
}
const _userPreferenceBody: z.ZodType<UserPreferenceBody> = z.object({
  userId: z.string().min(1),
  namespace: PreferenceNamespaceSchema,
  value: PreferenceValueSchema,
  revision: z.number().int().positive(),
  updatedAt: z.number().int(),
  updatedByDevice: PreferenceDeviceIdSchema.nullable(),
})
export const UserPreferenceBodySchema: z.ZodType<UserPreferenceBody> = _userPreferenceBody

/** The value bound plus room for the row's own fields. */
const ROW_MAX_DATA_BYTES: number = PREFERENCES_MAX_VALUE_BYTES + 4 * 1024

const _localAuthPreferencesRecordKinds = defineRecordKinds({
  'user-preferences': {
    schema: UserPreferenceBodySchema,
    class: 'config',
    writeTrigger:
      'a signed-in user saves one of their account preference namespaces (preferences.put) or deletes it',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'user', fields: ['userId'] }],
    retention: {
      none: 'a row goes when its user deletes the namespace, or with the user (deleteUser wipes every row of theirs)',
    },
    maxDataBytes: ROW_MAX_DATA_BYTES,
  },
}) satisfies IsolatedRecordKinds

export type LocalAuthPreferencesRecordKindsMap = {
  readonly 'user-preferences': DefinedRecordKind<z.ZodType<UserPreferenceBody>>
}

export const localAuthPreferencesRecordKinds: LocalAuthPreferencesRecordKindsMap =
  _localAuthPreferencesRecordKinds

/** Namespaces cannot hold `:`, so the id splits unambiguously. */
export function userPreferenceRecordId(userId: string, namespace: string): string {
  return `${userId}:${namespace}`
}
