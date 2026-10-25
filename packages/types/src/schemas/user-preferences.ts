/**
 * Per-user ACCOUNT preferences (D894): the hub-side half of the viewer's two
 * settings levels.
 *
 *   - DEVICE settings never leave the phone.
 *   - ACCOUNT settings live here: one row per `(user, namespace)`, private to
 *     that user, synced across every device signed in as them, last write wins
 *     unless the writer sends the revision it based its edit on.
 *
 * A setting lives in exactly ONE level; there are no overrides. The caller
 * never names a user: the hub stamps the principal's own id, admin included.
 *
 * The contract the client codes against is the `preferences.*` tRPC router
 * (`server/backend/src/api/core/preferences.router.ts`).
 */
import { z } from 'zod'

/** `viewer.app`, `viewer.cameras`, `viewer.grids` … — lowercase, dot/dash separated. */
export const PREFERENCES_NAMESPACE_PATTERN: RegExp = /^[a-z][a-z0-9.-]{0,63}$/

/** One row's value, measured as UTF-8 JSON. */
export const PREFERENCES_MAX_VALUE_BYTES = 256 * 1024

/** Namespaces one user may hold. */
export const PREFERENCES_MAX_NAMESPACES = 32

/** The opaque client id a writer stamps (`updatedByDevice`). */
export const PREFERENCES_MAX_DEVICE_ID_LENGTH = 64

export const PreferenceNamespaceSchema = z.string().regex(PREFERENCES_NAMESPACE_PATTERN)
export type PreferenceNamespace = z.infer<typeof PreferenceNamespaceSchema>

/** A namespace's value: a JSON object, opaque to the hub. */
export const PreferenceValueSchema = z.record(z.string(), z.unknown())
export type PreferenceValue = z.infer<typeof PreferenceValueSchema>

export const PreferenceDeviceIdSchema = z.string().min(1).max(PREFERENCES_MAX_DEVICE_ID_LENGTH)

/** A stored row, as the owner reads it. */
export const PreferenceRowSchema = z.object({
  namespace: PreferenceNamespaceSchema,
  value: PreferenceValueSchema,
  /** Starts at 1, +1 on every write of this namespace. A delete ends the row and its count. */
  revision: z.number().int().positive(),
  updatedAt: z.number().int(),
  /** The client id the last writer sent; `null` when it sent none. */
  updatedByDevice: PreferenceDeviceIdSchema.nullable(),
})
export type PreferenceRow = z.infer<typeof PreferenceRowSchema>

export const PreferencesGetInputSchema = z.object({
  /** Absent: every namespace the caller holds. */
  namespaces: z.array(PreferenceNamespaceSchema).max(PREFERENCES_MAX_NAMESPACES).optional(),
})
export type PreferencesGetInput = z.infer<typeof PreferencesGetInputSchema>

export const PreferencesGetOutputSchema = z.object({
  rows: z.array(PreferenceRowSchema),
})
export type PreferencesGetOutput = z.infer<typeof PreferencesGetOutputSchema>

export const PreferencesPutInputSchema = z.object({
  namespace: PreferenceNamespaceSchema,
  value: PreferenceValueSchema,
  /**
   * The revision the edit was based on. Absent: last write wins. `0`: the
   * namespace must not exist yet. Any other value that is not the current
   * revision answers `conflict` and writes nothing.
   */
  baseRevision: z.number().int().nonnegative().optional(),
  deviceId: PreferenceDeviceIdSchema.optional(),
})
export type PreferencesPutInput = z.infer<typeof PreferencesPutInputSchema>

export const PreferencesPutOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), row: PreferenceRowSchema }),
  /** Nothing was written; `current` is the row as it stands (`null`: it was deleted). */
  z.object({ status: z.literal('conflict'), current: PreferenceRowSchema.nullable() }),
])
export type PreferencesPutOutput = z.infer<typeof PreferencesPutOutputSchema>

export const PreferencesDeleteInputSchema = z.object({
  namespace: PreferenceNamespaceSchema,
})
export type PreferencesDeleteInput = z.infer<typeof PreferencesDeleteInputSchema>

export const PreferencesDeleteOutputSchema = z.object({
  /** `false` when the namespace did not exist. */
  deleted: z.boolean(),
})
export type PreferencesDeleteOutput = z.infer<typeof PreferencesDeleteOutputSchema>

export const PreferencesChangedSinceInputSchema = z.object({
  /** The revision the client holds per namespace; a namespace it does not list is new to it. */
  revisionByNamespace: z
    .record(PreferenceNamespaceSchema, z.number().int().nonnegative())
    .refine((map) => Object.keys(map).length <= PREFERENCES_MAX_NAMESPACES, {
      message: `at most ${PREFERENCES_MAX_NAMESPACES} namespaces`,
    }),
})
export type PreferencesChangedSinceInput = z.infer<typeof PreferencesChangedSinceInputSchema>

export const PreferencesChangedSinceOutputSchema = z.object({
  /** Every row whose revision differs from the client's, and every row it did not list. */
  rows: z.array(PreferenceRowSchema),
  /** Namespaces the client listed that no longer exist. */
  deleted: z.array(PreferenceNamespaceSchema),
})
export type PreferencesChangedSinceOutput = z.infer<typeof PreferencesChangedSinceOutputSchema>
