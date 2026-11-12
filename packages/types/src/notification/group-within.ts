/**
 * How long a rule holds deliveries before it sends them (operator, 2026-11-12).
 *
 * Absent means the kind's default: a system-event rule waits
 * {@link NC_GROUP_WITHIN_SYSTEM_DEFAULT_SEC}, every other rule sends at once.
 * `0` is the explicit "send each one now". The number is never a Zod default —
 * the addon cap path does not run those, and a default that depended on
 * `delivery` cannot be one value on the schema.
 *
 * The constants live on the cap schema (one owner). `delivery === 'system-event'`
 * is the comparison `isSystemDelivery` makes; this module does not import that
 * function because its module imports the cap, and the cap must not import this.
 */

import {
  NC_GROUP_WITHIN_MAX_SEC,
  NC_GROUP_WITHIN_OTHER_DEFAULT_SEC,
  NC_GROUP_WITHIN_SYSTEM_DEFAULT_SEC,
} from '../capabilities/notification-rules.cap.js'

export {
  NC_GROUP_WITHIN_MAX_SEC,
  NC_GROUP_WITHIN_OTHER_DEFAULT_SEC,
  NC_GROUP_WITHIN_SYSTEM_DEFAULT_SEC,
}

const SYSTEM_DELIVERY = 'system-event'

/** The rule fields the window reads. A stored rule and a half-built form both fit. */
export interface GroupWithinRule {
  readonly delivery: string
  readonly groupWithinSec?: number
}

/** Seconds to hold. `0` sends immediately. */
export function groupWithinSecOf(rule: GroupWithinRule): number {
  if (rule.groupWithinSec !== undefined) return rule.groupWithinSec
  return rule.delivery === SYSTEM_DELIVERY
    ? NC_GROUP_WITHIN_SYSTEM_DEFAULT_SEC
    : NC_GROUP_WITHIN_OTHER_DEFAULT_SEC
}
