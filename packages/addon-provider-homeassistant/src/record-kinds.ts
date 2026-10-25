/**
 * Record kinds owned by the provider-homeassistant addon (records plan
 * phase 2, step 16).
 *
 * The addon declares `execution.placement: hub-only` and no `execution.group`,
 * so the runner id is the addon id: `provider-homeassistant`.
 *
 * Only the `provider-homeassistant` addon declares these kinds. The sibling
 * `homeassistant-export` addon in the same package does NOT own HA notify
 * targets and does not call `ctx.records.declare` here.
 */
import { z } from 'zod'
import { defineRecordKinds, TargetSchema } from '@camstack/types'
import { haBrokersEntryKind } from './broker-record-kinds.js'

/**
 * Body of one stored HA notification target. The record id IS the target id
 * and is not repeated in the body.
 * No `.meta({ secret: true })` fields: HA notify targets carry no standalone
 * credential — delivery reuses the broker WebSocket connection (the token
 * lives in the broker config, not in the target).
 */
export const HaTargetBodySchema = TargetSchema.omit({ id: true })
export type HaTargetBody = z.infer<typeof HaTargetBodySchema>

export const haRecordKinds = defineRecordKinds({
  /**
   * One row per configured Home Assistant push target. Operator-managed via the
   * notification-output cap CRUD; no TTL.
   * The legacy collection name is `provider-homeassistant:ha-notification-targets`.
   */
  'ha-notification-targets': {
    schema: HaTargetBodySchema,
    class: 'config',
    writeTrigger:
      'an operator creates, updates, enables/disables or deletes a HA notification target',
    device: 'none',
    at: 'none',
    retention: {
      none: 'a row is removed only on an explicit operator delete; bounded by the number of HA notify targets the operator configures',
    },
    entry: { title: 'Home Assistant notification targets' },
  },
})

/** All record kinds this addon declares (targets + B2 broker entries). */
export const haAllRecordKinds = {
  ...haRecordKinds,
  [haBrokersEntryKind.name]: haBrokersEntryKind,
} as const
