/**
 * Record kind owned by the notifiers addon (records plan phase 2, step 17).
 *
 * The addon has `execution.placement: hub-only` and `execution.group:
 * "notifiers"`. The UDS stamp on every record is the RUNNER id (= the group
 * id): `notifiers` — same lesson as AI whose `execution.group: "ml"` makes
 * every ai record owned by `ml`, not by `ai`.
 *
 * The `notification-targets` kind adopts the legacy
 * `notifiers:notification-targets` collection. Prod has 5 rows.
 *
 * ## Secrets in the config blob
 *
 * Each target's `config` blob contains adapter-specific fields, some of which
 * are passwords (API tokens, webhook secrets). These are handled at the PROVIDER
 * level by `secrets.ts` (redact on read, merge on write) using the adapter's
 * `configSchema`. The records layer does not encrypt them at the field level
 * because the password-field names vary per adapter kind and are not enumerable
 * at the schema level. This remains a known limitation addressed in a future
 * phase: operator-visible secret fields would need individual `.meta({ secret: true })`
 * marks, which requires the adapter config schema to be lifted into the record
 * kind schema. The mapper adopts existing plaintext values as-is.
 */
import { z } from 'zod'
import { defineRecordKinds, TargetSchema } from '@camstack/types'

/** Body of a stored notification target (id is the record id, not repeated). */
export const TargetBodySchema = TargetSchema.omit({ id: true })
export type TargetBody = z.infer<typeof TargetBodySchema>

export const notifiersRecordKinds = defineRecordKinds({
  'notification-targets': {
    schema: TargetBodySchema,
    class: 'config',
    writeTrigger: 'an operator creates, updates, enables/disables or deletes a notification target',
    device: 'none',
    at: 'none',
    retention: {
      none: 'a row goes only on an explicit operator delete; bounded by the number of notification targets the operator configures',
    },
    entry: { title: 'Notification targets' },
  },
})
