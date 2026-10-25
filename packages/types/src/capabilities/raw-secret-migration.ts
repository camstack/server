/**
 * The report of a one-shot "move this owner's plaintext secrets into the
 * keychain" run (D878). COUNTS only - never a value, never a ref.
 *
 * The owner runs it on its own rows, through its own write path; an operator
 * script (`scripts/hub/migrate-raw-secrets.ts`) calls the owner's cap method.
 * Dry run (`apply: false`) reports what WOULD move and changes nothing.
 */
import { z } from 'zod'

export const RawSecretMigrationInputSchema = z.object({
  /** `false` (the default of the script) = report only. */
  apply: z.boolean(),
})
export type RawSecretMigrationInput = z.infer<typeof RawSecretMigrationInputSchema>

export const RawSecretMigrationReportSchema = z.object({
  apply: z.boolean(),
  /** Rows that can carry a secret (a profile, an enrolment). */
  rows: z.number().int(),
  /** Rows whose secret was plaintext when the run started. */
  raw: z.number().int(),
  /** Rows that already held a keychain marker when the run started. */
  markers: z.number().int(),
  /** Plaintext rows moved by THIS run (always 0 on a dry run). */
  migrated: z.number().int(),
  /** Plaintext rows left in place because the move or its read-back failed. */
  failed: z.number().int(),
  /** After the run: rows still holding plaintext. */
  remainingRaw: z.number().int(),
  /** After the run: markers the keychain could not resolve right now. */
  unresolvedMarkers: z.number().int(),
  /**
   * A second, redundant copy of the secrets' rows that the run found (and, on
   * `apply`, deleted after verifying the first). Owners with a single copy omit it.
   */
  redundantCopies: z.number().int().optional(),
  /** True when nothing is raw and every marker resolves. */
  verified: z.boolean(),
})
export type RawSecretMigrationReport = z.infer<typeof RawSecretMigrationReportSchema>
